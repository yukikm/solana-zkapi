package egress

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedCAAuthenticatesTLSWithoutDisablingHostnameVerification(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "verified") }))
	defer server.Close()
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	file := filepath.Join(t.TempDir(), "ca.pem")
	os.WriteFile(file, data, 0600)
	sum := sha256.Sum256(data)
	config := Config{Mode: "direct", Routes: []Route{{Origin: server.URL, Prefix: "/"}}, ExtraCA: &PinnedCA{Path: file, SHA256: hex.EncodeToString(sum[:])}}
	relay, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	response, err := relay.client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	transport := relay.client.Transport.(*http.Transport)
	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("hostname verification disabled")
	}
	transport.TLSClientConfig.ServerName = "wrong-host.invalid"
	transport.CloseIdleConnections()
	if response, err = relay.client.Get(server.URL); err == nil {
		response.Body.Close()
		t.Fatal("wrong hostname accepted")
	}
	config.ExtraCA = nil
	untrusted, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	if response, err = untrusted.client.Get(server.URL); err == nil {
		response.Body.Close()
		t.Fatal("untrusted certificate accepted")
	}
}
func TestPinnedCARejectsWrongDigestLinksAndMutableFiles(t *testing.T) {
	for _, kind := range []string{"digest", "link", "mutable", "oversized", "invalid", "relative"} {
		t.Run(kind, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "ca.pem")
			data := []byte("invalid PEM")
			os.WriteFile(file, data, 0600)
			sum := sha256.Sum256(data)
			pin := &PinnedCA{Path: file, SHA256: hex.EncodeToString(sum[:])}
			switch kind {
			case "digest":
				pin.SHA256 = strings.Repeat("0", 64)
			case "link":
				pin.Path = file + ".link"
				os.Symlink(file, pin.Path)
			case "mutable":
				os.Chmod(file, 0666)
			case "oversized":
				os.WriteFile(file, make([]byte, 1024*1024+1), 0600)
			case "relative":
				pin.Path = "ca.pem"
			}
			if _, err := New(Config{Mode: "direct", Routes: []Route{{Origin: "https://example.invalid", Prefix: "/"}}, ExtraCA: pin}); err == nil {
				t.Fatal("unsafe CA accepted")
			}
		})
	}
}
