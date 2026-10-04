package egress

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOneRouteForEveryNetworkClassAndNoRedirect(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://example.invalid", 307)
			return
		}
		_, _ = io.WriteString(w, "data: streamed\n\n")
	}))
	defer upstream.Close()
	relay, err := New(Config{Mode: "direct", AllowLocalHTTP: true, Routes: []Route{{Origin: upstream.URL, Prefix: "/"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/zkapi/v1/sessions", "/v1/messages/count_tokens", "/zkapi/v1/tree/root", "/rpc"} {
		r := httptest.NewRequest("POST", "/fetch", strings.NewReader("{}"))
		r.Header.Set("X-Zkapi-Target", upstream.URL+path)
		w := httptest.NewRecorder()
		relay.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("route %s: %d", path, w.Code)
		}
	}
	for _, target := range []string{"http://evil.invalid/rpc", upstream.URL + "/redirect", upstream.URL + "/foo/../rpc", upstream.URL + "/%72pc"} {
		r := httptest.NewRequest("GET", "/fetch", nil)
		r.Header.Set("X-Zkapi-Target", target)
		w := httptest.NewRecorder()
		relay.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatalf("unsafe target accepted: %s", target)
		}
	}
	if calls != 5 {
		t.Fatalf("unexpected outbound count %d", calls)
	}
}

func TestTorFailureNeverFallsBackForControlProviderIndexerRPC(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(200) }))
	defer upstream.Close()
	relay, err := New(Config{Mode: "tor", SOCKS5: "127.0.0.1:1", AllowLocalHTTP: true, Routes: []Route{{Origin: upstream.URL, Prefix: "/"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/zkapi/v1/sessions", "/v1/chat/completions", "/zkapi/v1/tree/root", "/rpc"} {
		r := httptest.NewRequest("POST", "/fetch", strings.NewReader("{}"))
		r.Header.Set("X-Zkapi-Target", upstream.URL+path)
		w := httptest.NewRecorder()
		relay.ServeHTTP(w, r)
		if w.Code != 503 {
			t.Fatalf("expected closed route, got %d", w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("Tor silently fell back to direct")
	}
}
