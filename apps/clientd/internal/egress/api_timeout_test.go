package egress

import (
	"net/http"
	"testing"
	"time"
)

func TestGenericTimeoutRequiresExactConfiguredPOSTOperation(t *testing.T) {
	origin := "https://execution.example"
	path := "/zkapi/v1/api/catalog/lookup"
	relay, err := New(Config{Mode: "direct", Routes: []Route{{Origin: origin, Prefix: path}, {Origin: origin, Prefix: "/v1"}}})
	if err != nil {
		t.Fatal(err)
	}
	if relay.client.Timeout != 10*time.Minute || relay.apiClient.Transport == relay.client.Transport {
		t.Fatal("generic timeout must use a separate transport and retain the ordinary total deadline")
	}
	if relay.apiClient.Timeout != 660*time.Second || relay.apiClient.Transport.(*http.Transport).ResponseHeaderTimeout != 660*time.Second {
		t.Fatal("generic 600-second descriptor does not have transport overhead")
	}
	for _, tc := range []struct {
		method, origin, path string
		want                 bool
	}{
		{"POST", origin, path, true}, {"GET", origin, path, false}, {"POST", "https://control.example", path, false},
		{"POST", origin, path + "/extra", false}, {"POST", origin, "/zkapi/v1/api/catalog/unselected", false}, {"POST", origin, "/v1/chat/completions", false},
	} {
		if relay.isRegisteredOperation(tc.method, tc.origin, tc.path) != tc.want {
			t.Fatal("timeout escaped descriptor route", tc)
		}
	}
}
