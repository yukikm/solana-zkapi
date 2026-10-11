// Package daemon provides the loopback boundary. Accounting, recovery and note
// custody live exclusively in the SDK process behind a private Unix socket.
package daemon

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var apiOperationPath = regexp.MustCompile(`^/zkapi/v1/api/[a-z0-9][a-z0-9_-]{0,63}/[a-z0-9][a-z0-9_-]{0,63}$`)

type gatewayContextKey struct{}

type gatewayForwardState struct {
	operationIDs []string
	delivery     string
}

type Server struct {
	InferenceToken, ManagementToken string
	Port                            int
	Backend                         http.Handler
	GatewayPrefixes                 []string
}

func NewServer(socket, inference, management string, port int) (*Server, error) {
	if len(inference) < 32 || len(management) < 32 || inference == management || port < 1 || port > 65535 {
		return nil, errors.New("distinct local credentials and a valid port are required")
	}
	target, _ := url.Parse("http://sdk.local")
	p := httputil.NewSingleHostReverseProxy(target)
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}, DisableCompression: true, DisableKeepAlives: true, ResponseHeaderTimeout: 15 * time.Minute}
	apiTransport := transport.Clone()
	// This hop includes proof/authorization before the bounded API execution.
	// Keep its budget aligned with the API command's overall deadline.
	apiTransport.ResponseHeaderTimeout = 900 * time.Second
	p.Transport = &operationTransport{ordinary: transport, api: apiTransport}
	p.FlushInterval = -1
	p.Director = func(r *http.Request) {
		r.URL.Scheme = target.Scheme
		r.URL.Host = target.Host
		r.Host = target.Host
		r.Header.Del("Authorization")
		if r.Context().Value(gatewayContextKey{}) == nil {
			r.Header.Del("X-Api-Key")
		}
		r.Header.Del(gatewayDeliveryHeader)
		if _, present := r.Header["User-Agent"]; !present {
			r.Header["User-Agent"] = []string{""}
		}
		r.Header.Del("Forwarded")
		r.Header.Del("X-Forwarded-For")
		r.Header.Del("X-Forwarded-Host")
	}
	p.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		failure(w, http.StatusServiceUnavailable, "client_state_unavailable")
	}
	p.ModifyResponse = func(response *http.Response) error {
		token := response.Header.Get(gatewayDeliveryHeader)
		response.Header.Del(gatewayDeliveryHeader)
		if state, ok := response.Request.Context().Value(gatewayContextKey{}).(*gatewayForwardState); ok && gatewayDeliveryToken.MatchString(token) {
			state.delivery = token
		}
		return nil
	}
	backend := &gatewayDeliveryProxy{proxy: p, client: &http.Client{Transport: transport, Timeout: 5 * time.Second}}
	return &Server{InferenceToken: inference, ManagementToken: management, Port: port, Backend: backend}, nil
}

type operationTransport struct {
	ordinary, api *http.Transport
}

func (t *operationTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if state, ok := r.Context().Value(gatewayContextKey{}).(*gatewayForwardState); ok {
		// ReverseProxy removes Connection-nominated fields. The local operation
		// ID must be consumed independently of that upstream header policy.
		if len(state.operationIDs) > 0 {
			r.Header["Idempotency-Key"] = append([]string(nil), state.operationIDs...)
		}
	}
	if r.Method == http.MethodPost && r.URL.RawQuery == "" && r.URL.EscapedPath() == r.URL.Path && apiOperationPath.MatchString(r.URL.Path) {
		return t.api.RoundTrip(r)
	}
	return t.ordinary.RoundTrip(r)
}

func failure(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Zkapi-Error-Code", code)
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `{"error":{"type":"zkapi_client_error","code":"`+code+`","message":"Request was not replayed. Inspect local status before retrying."}}`)
}

func (s *Server) local(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return false
	}
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || port != strconv.Itoa(s.Port) || !(host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()) {
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		return false
	}
	return true
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.local(r) {
		failure(w, http.StatusForbidden, "loopback_boundary")
		return
	}
	gateway := s.gatewayTarget(r)
	if gateway {
		r = r.WithContext(context.WithValue(r.Context(), gatewayContextKey{}, &gatewayForwardState{operationIDs: append([]string(nil), r.Header.Values("Idempotency-Key")...)}))
		if !strings.HasPrefix(r.RequestURI, "/") || strings.HasPrefix(r.RequestURI, "//") || r.Header.Get("Upgrade") != "" {
			failure(w, http.StatusBadRequest, "unsupported_capability")
			return
		}
		for _, connection := range r.Header.Values("Connection") {
			for _, field := range strings.Split(connection, ",") {
				if strings.EqualFold(strings.TrimSpace(field), "upgrade") {
					failure(w, http.StatusBadRequest, "unsupported_capability")
					return
				}
			}
		}
	}
	// Browser preflight is a local control exchange and must never be billed.
	if gateway && r.Method == "OPTIONS" && r.Header.Get("Access-Control-Request-Method") != "" {
		failure(w, http.StatusForbidden, "preflight_unsupported")
		return
	}
	if !gateway && (r.URL.RawQuery != "" || r.URL.ForceQuery || r.URL.EscapedPath() != r.URL.Path) {
		failure(w, 400, "unsupported_route")
		return
	}
	wanted := s.InferenceToken
	management := strings.HasPrefix(r.URL.Path, "/admin/")
	if management {
		wanted = s.ManagementToken
	}
	if len(r.Header.Values("Authorization")) != 1 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+wanted)) != 1 {
		failure(w, http.StatusUnauthorized, "local_credential_required")
		return
	}
	valid := r.Method == "GET" && (r.URL.Path == "/v1/models" || r.URL.Path == "/zkapi/v1/apis")
	if r.Method == "POST" {
		valid = apiOperationPath.MatchString(r.URL.Path)
		switch r.URL.Path {
		case "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens":
			valid = true
		}
	}
	if management {
		valid = r.Method == "GET" && (r.URL.Path == "/admin/status" || r.URL.Path == "/admin/upgrade-plan" || r.URL.Path == "/admin/model-availability") || r.Method == "POST" && (r.URL.Path == "/admin/close" || r.URL.Path == "/admin/recover" || r.URL.Path == "/admin/reconcile" || r.URL.Path == "/admin/cancel-unsent" || r.URL.Path == "/admin/purge-settled-bodies" || r.URL.Path == "/admin/wallet")
	}
	if gateway {
		switch r.Method {
		case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
			valid = true
		default:
			valid = false
		}
	}
	if !valid {
		failure(w, 404, "unsupported_route")
		return
	}
	if r.Header.Get("Content-Encoding") != "" && r.Header.Get("Content-Encoding") != "identity" {
		failure(w, 415, "content_encoding")
		return
	}
	if r.Method == "POST" || gateway {
		body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
		_ = r.Body.Close()
		if err != nil || len(body) > 1<<20 {
			failure(w, 413, "request_size")
			return
		}
		if gateway && ((r.Method == "GET" || r.Method == "HEAD") && len(body) != 0 || len(r.Trailer) != 0) {
			failure(w, 400, "unsupported_capability")
			return
		}
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		r.ContentLength = int64(len(body))
	}
	s.Backend.ServeHTTP(w, r)
}
