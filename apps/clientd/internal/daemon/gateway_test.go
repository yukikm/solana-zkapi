package daemon

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayMountPreservesOpaqueRequestAndAuthBoundary(t *testing.T) {
	s, _ := NewServer("/unused", strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	if err := s.ConfigureGateway([]string{"/native"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s.Backend = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.RequestURI != "/native/v1/item%41?key=a&key=b%2f&empty=" {
			t.Errorf("target changed: %s", r.RequestURI)
		}
		if got := r.Header.Values("X-Feature"); len(got) != 2 || got[0] != "one" || got[1] != "two" {
			t.Errorf("headers changed: %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "\x00\xff\x10" {
			t.Errorf("body changed: %x", body)
		}
		w.WriteHeader(204)
	})
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:8"
		r.Host = "127.0.0.1:8787"
		r.Header.Set("Authorization", "Bearer "+strings.Repeat(token, 32))
		r.Header.Add("X-Feature", "one")
		r.Header.Add("X-Feature", "two")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if w := request("PATCH", "/native/v1/item%41?key=a&key=b%2f&empty=", "i", "\x00\xff\x10"); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		method, path, token, body string
		status                    int
	}{
		{"POST", "/native/v1/item?key=x", "m", "", 401},
		{"GET", "/native/item", "i", "body", 400},
		{"TRACE", "/native/item", "i", "", 404},
		{"POST", "/other/item", "i", "", 404},
		{"GET", "/admin/status?query=x", "i", "", 400},
	} {
		if w := request(tc.method, tc.path, tc.token, tc.body); w.Code != tc.status {
			t.Fatalf("%s: %d != %d", tc.path, w.Code, tc.status)
		}
	}
	if calls != 1 {
		t.Fatalf("unexpected backend requests: %d", calls)
	}
}

func TestGatewayCannotMountOverManagement(t *testing.T) {
	s, _ := NewServer("/unused", strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	for _, prefix := range []string{"/admin", "/admin/close", "/zkapi", "/zkapi/v1", "/v1/models", "/bad/", "/bad%2fpath", "/bad/../path"} {
		if s.ConfigureGateway([]string{prefix}) == nil {
			t.Fatalf("accepted %s", prefix)
		}
	}
	if err := s.ConfigureGateway([]string{""}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/admin/status", "/%61dmin/status", "/zkapi/v1/apis", "/v1/models"} {
		if s.gatewayTarget(httptest.NewRequest("GET", path, nil)) {
			t.Fatalf("gateway captured %s", path)
		}
	}
}
