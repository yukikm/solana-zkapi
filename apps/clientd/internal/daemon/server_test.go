package daemon

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoopbackCredentialsAndRoutes(t *testing.T) {
	api, err := NewServer("/unused", strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	api.Backend = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) })
	for _, tc := range []struct {
		name, peer, host, origin, auth, path, method string
		status                                       int
	}{
		{"inference", "127.0.0.1:5", "127.0.0.1:8787", "", "i", "/v1/chat/completions", "POST", 204},
		{"management", "[::1]:5", "localhost:8787", "http://localhost:8787", "m", "/admin/status", "GET", 204},
		{"cancel unsent", "127.0.0.1:5", "localhost:8787", "", "m", "/admin/cancel-unsent", "POST", 204},
		{"cancel needs management", "127.0.0.1:5", "localhost:8787", "", "i", "/admin/cancel-unsent", "POST", 401},
		{"wrong role", "127.0.0.1:5", "localhost:8787", "", "i", "/admin/close", "POST", 401},
		{"admin not inference", "127.0.0.1:5", "localhost:8787", "", "m", "/v1/messages", "POST", 401},
		{"missing credential", "127.0.0.1:5", "localhost:8787", "", "", "/v1/models", "GET", 401},
		{"rebinding", "127.0.0.1:5", "evil.example:8787", "", "i", "/v1/models", "GET", 403},
		{"wrong port", "127.0.0.1:5", "localhost:8080", "", "i", "/v1/models", "GET", 403},
		{"remote", "192.0.2.1:5", "localhost:8787", "", "i", "/v1/models", "GET", 403},
		{"foreign origin", "127.0.0.1:5", "localhost:8787", "https://example.com", "i", "/v1/models", "GET", 403},
		{"null origin", "127.0.0.1:5", "localhost:8787", "null", "i", "/v1/models", "GET", 403},
		{"query rejected", "127.0.0.1:5", "localhost:8787", "", "i", "/v1/models?evil=1", "GET", 400},
		{"no arbitrary proxy", "127.0.0.1:5", "localhost:8787", "", "i", "/v1/files", "POST", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{"model":"m"}`))
			r.RemoteAddr = tc.peer
			r.Host = tc.host
			r.Header.Set("Origin", tc.origin)
			if tc.auth != "" {
				r.Header.Set("Authorization", "Bearer "+strings.Repeat(tc.auth, 32))
			}
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			w := httptest.NewRecorder()
			api.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d", w.Code, tc.status)
			}
		})
	}
	if calls != 3 {
		t.Fatalf("unauthorized calls: %d", calls)
	}
}

func TestActualUnixStreamingAndHeaderSeparation(t *testing.T) {
	// /tmp avoids exceeding macOS's Unix socket path limit under testing.T.TempDir.
	socket := filepath.Join(t.TempDir(), "s")
	if len(socket) > 90 {
		socket = filepath.Join("/tmp", strings.ReplaceAll(t.Name(), "/", "-")+".sock")
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	backend := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" {
			t.Error("frontend credentials crossed SDK boundary")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"model":"m","stream":true}` {
			t.Errorf("changed inference bytes %q", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: one\n\n")
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})}
	go backend.Serve(listener)
	defer backend.Close()
	api, _ := NewServer(socket, strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	front := httptest.NewServer(api)
	defer front.Close()
	r, _ := http.NewRequestWithContext(context.Background(), "POST", front.URL+"/v1/chat/completions", strings.NewReader(`{"model":"m","stream":true}`))
	r.Host = "127.0.0.1:8787"
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("i", 32))
	r.Header.Set("X-Api-Key", "must-not-cross")
	response, err := front.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || string(body) != "data: one\n\ndata: [DONE]\n\n" {
		t.Fatalf("stream failed: %d %q", response.StatusCode, body)
	}
}
