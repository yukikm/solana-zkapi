package egress

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func admissionDirectory(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func admissionFile(t *testing.T, raw string) string {
	t.Helper()
	file := filepath.Join(admissionDirectory(t), "admission.token")
	if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func admissionTLSConfig(t *testing.T, origin string, servers ...*httptest.Server) (Config, string) {
	t.Helper()
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{19}, 32))
	var certificates []byte
	var routes []Route
	for _, server := range servers {
		certificates = append(certificates, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})...)
		routes = append(routes, Route{Origin: server.URL, Prefix: "/zkapi/v1"}, Route{Origin: server.URL, Prefix: "/rpc"})
	}
	caPath := filepath.Join(admissionDirectory(t), "ca.pem")
	if err := os.WriteFile(caPath, certificates, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(certificates)
	return Config{Mode: "direct", Routes: routes, ExtraCA: &PinnedCA{Path: caPath, SHA256: hex.EncodeToString(digest[:])},
		Admission: &Admission{Origin: origin, TokenFile: admissionFile(t, token+"\n")}}, token
}

func admissionFetch(relay *Relay, method, target, authorization string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/fetch", strings.NewReader("{}"))
	r.Header.Set("X-Zkapi-Target", target)
	r.Header.Set("X-Zkapi-Admission", "caller-spoof-must-never-be-forwarded")
	r.Header.Set("Authorization", authorization)
	w := httptest.NewRecorder()
	relay.ServeHTTP(w, r)
	return w
}

func TestAdmissionInjectsOnlyExactAUTHAndLoadsOnce(t *testing.T) {
	type observed struct{ method, uri, token, authorization string }
	seen := make(chan observed, 16)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- observed{r.Method, r.URL.RequestURI(), r.Header.Get("X-Zkapi-Admission"), r.Header.Get("Authorization")}
		_, _ = io.WriteString(w, "ok")
	})
	control := httptest.NewTLSServer(handler)
	defer control.Close()
	other := httptest.NewTLSServer(handler)
	defer other.Close()
	config, token := admissionTLSConfig(t, control.URL, control, other)
	relay, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.client.CloseIdleConnections()
	// Startup captures the secret and reviewed origin; later file/config changes
	// must not rotate a running relay's credential or attach it elsewhere.
	if err := os.WriteFile(config.Admission.TokenFile, []byte(base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{20}, 32))), 0600); err != nil {
		t.Fatal(err)
	}
	config.Admission.Origin = other.URL
	for _, tc := range []struct{ method, origin, path, want string }{
		{"POST", control.URL, "/zkapi/v1/sessions", token},
		{"GET", control.URL, "/zkapi/v1/sessions", ""},
		{"POST", control.URL, "/zkapi/v1/sessions/123/close", ""},
		{"POST", control.URL, "/zkapi/v1/quotes", ""},
		{"POST", control.URL, "/zkapi/v1/withdraw/clearance", ""},
		{"POST", control.URL, "/rpc", ""},
		{"POST", control.URL, "/zkapi/v1/sessions?foo=bar", ""},
		{"POST", control.URL, "/zkapi/v1/sessions?", ""},
		{"POST", other.URL, "/zkapi/v1/sessions", ""},
	} {
		w := admissionFetch(relay, tc.method, tc.origin+tc.path, "Bearer existing-control-token")
		if w.Code != http.StatusOK {
			t.Fatalf("request rejected: %s %s: %d", tc.method, tc.path, w.Code)
		}
		got := <-seen
		if got.token != tc.want || got.method != tc.method || got.uri != tc.path || got.authorization != "Bearer existing-control-token" {
			t.Fatalf("unexpected admission/header routing for %s %s", tc.method, tc.path)
		}
	}
	for _, target := range []string{control.URL + "/not-reviewed", control.URL + "/zkapi/v1/%73essions", "https://unreviewed.example.invalid/zkapi/v1/sessions"} {
		if w := admissionFetch(relay, "POST", target, ""); w.Code != http.StatusForbidden {
			t.Fatalf("route policy bypass: %d", w.Code)
		}
	}
	select {
	case <-seen:
		t.Fatal("unreviewed route reached an upstream")
	default:
	}
}

func TestAdmissionNeverFollowsRedirectOrCopiesCallerToken(t *testing.T) {
	redirected := make(chan struct{}, 1)
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected <- struct{}{} }))
	defer destination.Close()
	seen := make(chan string, 2)
	control := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("X-Zkapi-Admission")
		http.Redirect(w, r, destination.URL+"/zkapi/v1/sessions", http.StatusTemporaryRedirect)
	}))
	defer control.Close()
	config, token := admissionTLSConfig(t, control.URL, control, destination)
	relay, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.client.CloseIdleConnections()
	if w := admissionFetch(relay, "POST", control.URL+"/zkapi/v1/sessions", ""); w.Code != http.StatusBadGateway {
		t.Fatalf("redirect was not refused: %d", w.Code)
	}
	if <-seen != token {
		t.Fatal("exact initial AUTH did not carry its configured admission")
	}
	select {
	case <-redirected:
		t.Fatal("redirect leaked an admission request")
	default:
	}
	config.Admission = nil
	without, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer without.client.CloseIdleConnections()
	_ = admissionFetch(without, "POST", control.URL+"/zkapi/v1/sessions", "")
	if <-seen != "" {
		t.Fatal("caller invitation copied without private configuration")
	}
}

func TestAdmissionRejectsUnreviewedOrNoncanonicalOrigins(t *testing.T) {
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{21}, 32))
	file := admissionFile(t, token)
	for _, origin := range []string{"http://control.example.com", "https://control.example.com/", "https://control.example.com?", "https://control.example.com?key=private", "https://control.example.com#fragment", "https://user:private@control.example.com", "https://CONTROL.example.com", "https://control.example.com:443", "https://other.example.com"} {
		config := Config{Mode: "direct", Routes: []Route{{Origin: "https://control.example.com", Prefix: "/zkapi/v1"}}, Admission: &Admission{Origin: origin, TokenFile: file}}
		if _, err := New(config); err == nil {
			t.Fatal("unsafe admission origin accepted")
		}
	}
	for _, prefix := range []string{"/rpc", "/zkapi/v1/quotes", "/zkapi/v1/sessions/other"} {
		config := Config{Mode: "direct", Routes: []Route{{Origin: "https://control.example.com", Prefix: prefix}}, Admission: &Admission{Origin: "https://control.example.com", TokenFile: file}}
		if _, err := New(config); err == nil {
			t.Fatal("admission bypassed reviewed AUTH route")
		}
	}
	for _, origin := range []string{"https://control.example.com:", "https://control.example.com:0443", "https://control.example.com:65536", "https://control.example.com:0"} {
		config := Config{Mode: "direct", Routes: []Route{{Origin: origin, Prefix: "/zkapi/v1"}}, Admission: &Admission{Origin: origin, TokenFile: file}}
		if _, err := New(config); err == nil {
			t.Fatal("noncanonical admission port accepted")
		}
	}
}

func TestAdmissionRejectsUnsafeFilesAndTokenEncodings(t *testing.T) {
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{22}, 32))
	for _, kind := range []string{"relative", "unclean", "symlink", "parent-symlink", "directory", "missing", "group-readable", "world-readable", "empty", "oversized", "padding", "two-newlines", "crlf", "space", "noncanonical"} {
		t.Run(kind, func(t *testing.T) {
			file := admissionFile(t, token)
			selected, raw := file, token
			switch kind {
			case "relative":
				selected = "admission.token"
			case "unclean":
				selected = filepath.Dir(file) + "/./admission.token"
			case "symlink":
				selected = file + ".link"
				if err := os.Symlink(file, selected); err != nil {
					t.Fatal(err)
				}
			case "parent-symlink":
				linked := filepath.Join(admissionDirectory(t), "linked")
				if err := os.Symlink(filepath.Dir(file), linked); err != nil {
					t.Fatal(err)
				}
				selected = filepath.Join(linked, "admission.token")
			case "directory":
				selected = filepath.Dir(file)
			case "missing":
				selected = file + ".missing"
			case "group-readable":
				if err := os.Chmod(file, 0640); err != nil {
					t.Fatal(err)
				}
			case "world-readable":
				if err := os.Chmod(file, 0604); err != nil {
					t.Fatal(err)
				}
			case "empty":
				raw = ""
			case "oversized":
				raw = strings.Repeat("A", 4096)
			case "padding":
				raw += "="
			case "two-newlines":
				raw += "\n\n"
			case "crlf":
				raw += "\r\n"
			case "space":
				raw += " "
			case "noncanonical":
				raw = token[:42] + "B"
			}
			if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := New(Config{Mode: "direct", Routes: []Route{{Origin: "https://control.example.com", Prefix: "/"}}, Admission: &Admission{Origin: "https://control.example.com", TokenFile: selected}})
			if err == nil {
				t.Fatal("unsafe admission file accepted")
			}
			if strings.Contains(err.Error(), token) || strings.Contains(err.Error(), selected) {
				t.Fatal("private admission data exposed in error")
			}
		})
	}
	for _, raw := range []string{token, token + "\n"} {
		if _, err := New(Config{Mode: "direct", Routes: []Route{{Origin: "https://control.example.com", Prefix: "/zkapi/v1/sessions"}}, Admission: &Admission{Origin: "https://control.example.com", TokenFile: admissionFile(t, raw)}}); err != nil {
			t.Fatal("canonical private token rejected")
		}
	}
}

type admissionOwnerInfo struct {
	os.FileInfo
	stat syscall.Stat_t
}

func (info admissionOwnerInfo) Sys() any { return &info.stat }

func TestAdmissionRejectsAnotherFileOwner(t *testing.T) {
	file := admissionFile(t, base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{23}, 32)))
	info, err := os.Lstat(file)
	if err != nil {
		t.Fatal(err)
	}
	stat := *info.Sys().(*syscall.Stat_t)
	stat.Uid++
	if privateAdmissionFile(admissionOwnerInfo{FileInfo: info, stat: stat}) {
		t.Fatal("another owner's admission file accepted")
	}
}

func TestAdmissionTorFailureNeverFallsBack(t *testing.T) {
	calls := make(chan struct{}, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls <- struct{}{} }))
	defer server.Close()
	config, _ := admissionTLSConfig(t, server.URL, server)
	config.Mode, config.SOCKS5 = "tor", "127.0.0.1:1"
	relay, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer relay.client.CloseIdleConnections()
	if w := admissionFetch(relay, "POST", server.URL+"/zkapi/v1/sessions", ""); w.Code != http.StatusServiceUnavailable {
		t.Fatal("Tor failure did not fail closed")
	}
	select {
	case <-calls:
		t.Fatal("admission silently fell back to direct transport")
	default:
	}
}
