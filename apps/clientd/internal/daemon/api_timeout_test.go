package daemon

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAPIProxyBudgetIncludesPreparationAndExecution(t *testing.T) {
	var calls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-r.Context().Done():
			return
		case <-time.After(80 * time.Millisecond):
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer backend.Close()
	server, err := NewServer("/unused", strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	if err != nil {
		t.Fatal(err)
	}
	transport := server.Backend.(*gatewayDeliveryProxy).proxy.(*httputil.ReverseProxy).Transport.(*operationTransport)
	if transport.api.ResponseHeaderTimeout != 900*time.Second {
		t.Fatal("API proxy must retain the full native preparation/execution budget")
	}
	// Scale the ordinary and API budgets down to exercise actual header waits.
	transport.ordinary.ResponseHeaderTimeout = 20 * time.Millisecond
	transport.api.ResponseHeaderTimeout = time.Second
	for _, selected := range []*http.Transport{transport.ordinary, transport.api} {
		selected.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", strings.TrimPrefix(backend.URL, "http://"))
		}
		defer selected.CloseIdleConnections()
	}
	for _, tc := range []struct {
		method, path string
		cancel       bool
		status       int
	}{
		{"POST", "/zkapi/v1/api/weather/lookup", false, http.StatusNoContent},
		{"POST", "/v1/chat/completions", false, http.StatusServiceUnavailable},
		{"GET", "/zkapi/v1/apis", false, http.StatusServiceUnavailable},
		{"POST", "/zkapi/v1/api/weather/lookup", true, http.StatusServiceUnavailable},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
		r.RemoteAddr, r.Host = "127.0.0.1:1234", "127.0.0.1:8787"
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("i", 32))
		r.Header.Set("X-Zkapi-Timeout", "900000") // A caller cannot extend ordinary routes.
		if tc.cancel {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Millisecond)
			defer cancel()
			r = r.WithContext(ctx)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s cancel=%t: got %d, want %d", tc.method, tc.path, tc.cancel, w.Code, tc.status)
		}
	}
	if calls.Load() != 4 {
		t.Fatalf("expected one attempt per request, got %d", calls.Load())
	}
}
