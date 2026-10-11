// Package egress is the sole network route for SDK control, inference, indexer
// and RPC traffic. Tor mode always sends hostnames through SOCKS5.
package egress

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Route struct {
	Origin string `json:"origin"`
	Prefix string `json:"prefix"`
}
type Config struct {
	Mode           string     `json:"mode"`
	SOCKS5         string     `json:"socks5"`
	Routes         []Route    `json:"routes"`
	AllowLocalHTTP bool       `json:"allow_local_http"`
	ExtraCA        *PinnedCA  `json:"extra_ca,omitempty"`
	Admission      *Admission `json:"admission,omitempty"`
}

// Admission is a consumer-private invitation for one reviewed control origin.
// Only its file reference is configuration; token bytes stay inside the relay.
type Admission struct {
	Origin    string `json:"origin"`
	TokenFile string `json:"token_file"`
}
type PinnedCA struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Relay struct {
	client          *http.Client
	routes          []Route
	admissionOrigin string
	admissionToken  string
}

func routeAllows(route Route, origin, targetPath string) bool {
	return origin == route.Origin && (route.Prefix == "/" || targetPath == strings.TrimSuffix(route.Prefix, "/") || strings.HasPrefix(targetPath, strings.TrimSuffix(route.Prefix, "/")+"/"))
}

func privateAdmissionFile(info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() < 43 || info.Size() > 44 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func loadAdmission(config *Admission, routes []Route) (string, string, error) {
	if config == nil {
		return "", "", nil
	}
	rejected := errors.New("invalid private admission configuration")
	u, err := url.Parse(config.Origin)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Hostname() == "" || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || u.Host != strings.ToLower(u.Host) || u.Port() == "443" || config.Origin != u.Scheme+"://"+u.Host || u.String() != config.Origin {
		return "", "", rejected
	}
	if strings.HasSuffix(u.Host, ":") {
		return "", "", rejected
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
			return "", "", rejected
		}
	}
	allowed := false
	for _, route := range routes {
		if routeAllows(route, config.Origin, "/zkapi/v1/sessions") {
			allowed = true
		}
	}
	if !allowed || !filepath.IsAbs(config.TokenFile) || filepath.Clean(config.TokenFile) != config.TokenFile {
		return "", "", rejected
	}
	real, err := filepath.EvalSymlinks(config.TokenFile)
	if err != nil || real != config.TokenFile {
		return "", "", rejected
	}
	info, err := os.Lstat(config.TokenFile)
	if err != nil || !privateAdmissionFile(info) {
		return "", "", rejected
	}
	file, err := os.Open(config.TokenFile)
	if err != nil {
		return "", "", rejected
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !privateAdmissionFile(actual) || !os.SameFile(info, actual) {
		return "", "", rejected
	}
	raw, err := io.ReadAll(io.LimitReader(file, 45))
	if err != nil || len(raw) > 44 {
		return "", "", rejected
	}
	defer clear(raw)
	token := strings.TrimSuffix(string(raw), "\n")
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(token)
	defer clear(decoded)
	if err != nil || len(token) != 43 || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return "", "", rejected
	}
	return config.Origin, token, nil
}

func New(config Config) (*Relay, error) {
	if config.Mode != "direct" && config.Mode != "tor" {
		return nil, errors.New("explicit network mode required")
	}
	if len(config.Routes) == 0 {
		return nil, errors.New("pinned network routes required")
	}
	for _, route := range config.Routes {
		u, err := url.Parse(route.Origin)
		if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Host == "" || route.Origin != u.Scheme+"://"+u.Host || !strings.HasPrefix(route.Prefix, "/") {
			return nil, errors.New("invalid pinned network route")
		}
		if u.Scheme != "https" && !(config.AllowLocalHTTP && u.Scheme == "http" && net.ParseIP(u.Hostname()) != nil && net.ParseIP(u.Hostname()).IsLoopback()) {
			return nil, errors.New("HTTPS required")
		}
	}
	admissionOrigin, admissionToken, err := loadAdmission(config.Admission, config.Routes)
	if err != nil {
		return nil, err
	}
	dial := (&net.Dialer{Timeout: 20 * time.Second}).DialContext
	if config.Mode == "tor" {
		host, port, err := net.SplitHostPort(config.SOCKS5)
		portNumber, portErr := strconv.Atoi(port)
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || portErr != nil || portNumber < 1 || portNumber > 65535 {
			return nil, errors.New("SOCKS5 must be a numeric loopback address")
		}
		dial = func(ctx context.Context, network, destination string) (net.Conn, error) {
			return dialSOCKS5(ctx, config.SOCKS5, network, destination)
		}
	} else if config.SOCKS5 != "" {
		return nil, errors.New("SOCKS5 configured without tor mode")
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if config.ExtraCA != nil {
		pin := config.ExtraCA
		if !filepath.IsAbs(pin.Path) || len(pin.SHA256) != 64 {
			return nil, errors.New("absolute independently pinned CA required")
		}
		info, err := os.Lstat(pin.Path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 1024*1024 {
			return nil, errors.New("unsafe pinned CA file")
		}
		file, err := os.Open(pin.Path)
		if err != nil {
			return nil, errors.New("pinned CA unavailable")
		}
		actual, statErr := file.Stat()
		pem, readErr := io.ReadAll(io.LimitReader(file, 1024*1024+1))
		_ = file.Close()
		if statErr != nil || !os.SameFile(info, actual) || readErr != nil || len(pem) > 1024*1024 {
			return nil, errors.New("pinned CA read failed")
		}
		sum := sha256.Sum256(pem)
		if hex.EncodeToString(sum[:]) != pin.SHA256 {
			return nil, errors.New("pinned CA digest mismatch")
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, errors.New("system certificate roots unavailable")
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid pinned CA certificate")
		}
		tlsConfig.RootCAs = roots
	}
	t := &http.Transport{Proxy: nil, DialContext: dial, TLSClientConfig: tlsConfig, TLSHandshakeTimeout: 20 * time.Second, ResponseHeaderTimeout: 10 * time.Minute, DisableCompression: true, ForceAttemptHTTP2: true}
	return &Relay{client: &http.Client{Transport: t, Timeout: 10 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}, routes: append([]Route(nil), config.Routes...), admissionOrigin: admissionOrigin, admissionToken: admissionToken}, nil
}

func (e *Relay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/fetch" || r.URL.RawQuery != "" || (r.Method != "GET" && r.Method != "POST") {
		http.Error(w, "route rejected", 400)
		return
	}
	u, err := url.Parse(r.Header.Get("X-Zkapi-Target"))
	if err != nil || u.User != nil || u.Fragment != "" || u.Host == "" || u.Opaque != "" {
		http.Error(w, "target rejected", 400)
		return
	}
	allowed := false
	for _, route := range e.routes {
		if routeAllows(route, u.Scheme+"://"+u.Host, u.Path) {
			allowed = true
		}
	}
	if !allowed || u.EscapedPath() != u.Path || path.Clean(u.Path) != u.Path && u.Path != "" {
		http.Error(w, "target rejected", 403)
		return
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), r.Body)
	if err != nil {
		http.Error(w, "request rejected", 400)
		return
	}
	for _, key := range []string{"Authorization", "Content-Type", "Accept", "Anthropic-Version", "Idempotency-Key"} {
		if value := r.Header.Get(key); value != "" {
			out.Header.Set(key, value)
		}
	}
	// Never copy this header from the SDK request. The private invitation is
	// scoped to the exact AUTH endpoint and cannot follow a redirect.
	if e.admissionToken != "" && r.Method == http.MethodPost && u.Scheme+"://"+u.Host == e.admissionOrigin && u.Path == "/zkapi/v1/sessions" && u.RawQuery == "" && !u.ForceQuery {
		out.Header.Set("X-Zkapi-Admission", e.admissionToken)
	}
	out.ContentLength = r.ContentLength
	response, err := e.client.Do(out)
	if err != nil {
		http.Error(w, "network unavailable; no direct fallback or retry", 503)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		http.Error(w, "redirect rejected", 502)
		return
	}
	for _, key := range []string{"Content-Type", "X-Zkapi-Operation-Id", "X-Zkapi-Status-Url", "X-Zkapi-Error-Code", "Retry-After"} {
		if value := response.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			if _, err = w.Write(buffer[:n]); err != nil {
				return
			}
			_ = http.NewResponseController(w).Flush()
		}
		if readErr != nil {
			if readErr != io.EOF {
				panic(http.ErrAbortHandler)
			}
			return
		}
	}
}
