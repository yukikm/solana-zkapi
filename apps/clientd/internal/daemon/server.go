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
	"strconv"
	"strings"
	"time"
)

type Server struct {
	InferenceToken, ManagementToken string
	Port                            int
	Backend                         http.Handler
}

func NewServer(socket, inference, management string, port int) (*Server, error) {
	if len(inference) < 32 || len(management) < 32 || inference == management || port < 1 || port > 65535 {
		return nil, errors.New("distinct local credentials and a valid port are required")
	}
	target, _ := url.Parse("http://sdk.local")
	p := httputil.NewSingleHostReverseProxy(target)
	p.Transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}, DisableCompression: true, ResponseHeaderTimeout: 15 * time.Minute}
	p.FlushInterval = -1
	p.Director = func(r *http.Request) {
		r.URL.Scheme = target.Scheme
		r.URL.Host = target.Host
		r.Host = target.Host
		r.Header.Del("Authorization")
		r.Header.Del("X-Api-Key")
		r.Header.Del("Forwarded")
		r.Header.Del("X-Forwarded-For")
		r.Header.Del("X-Forwarded-Host")
	}
	p.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		failure(w, http.StatusServiceUnavailable, "client_state_unavailable")
	}
	return &Server{inference, management, port, p}, nil
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
	if r.URL.RawQuery != "" || r.URL.EscapedPath() != r.URL.Path {
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
	valid := r.Method == "GET" && r.URL.Path == "/v1/models"
	if r.Method == "POST" {
		switch r.URL.Path {
		case "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens":
			valid = true
		}
	}
	if management {
		valid = r.Method == "GET" && (r.URL.Path == "/admin/status" || r.URL.Path == "/admin/upgrade-plan" || r.URL.Path == "/admin/model-availability") || r.Method == "POST" && (r.URL.Path == "/admin/close" || r.URL.Path == "/admin/recover" || r.URL.Path == "/admin/reconcile" || r.URL.Path == "/admin/cancel-unsent" || r.URL.Path == "/admin/purge-settled-bodies" || r.URL.Path == "/admin/wallet")
	}
	if !valid {
		failure(w, 404, "unsupported_route")
		return
	}
	if r.Header.Get("Content-Encoding") != "" && r.Header.Get("Content-Encoding") != "identity" {
		failure(w, 415, "content_encoding")
		return
	}
	if r.Method == "POST" {
		body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
		_ = r.Body.Close()
		if err != nil || len(body) > 1<<20 {
			failure(w, 413, "request_size")
			return
		}
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		r.ContentLength = int64(len(body))
	}
	s.Backend.ServeHTTP(w, r)
}
