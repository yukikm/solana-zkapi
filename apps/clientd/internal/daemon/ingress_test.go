package daemon

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGatewayRawIngressRejectsNormalizedDuplicates(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if string(body) != "x" {
			t.Errorf("body changed %q", body)
		}
		w.WriteHeader(204)
	})}
	server.SetKeepAlivesEnabled(false)
	go server.Serve(GatewayListener(listener))
	t.Cleanup(func() { server.Close() })
	for _, extra := range []string{"Content-Length: 1\r\n", "Transfer-Encoding: chunked\r\n", "Content-Type: b\r\n", "Host: again\r\n", "Idempotency-Key: first\r\nIdempotency-Key: second\r\n", " folded: value\r\n", strings.Repeat("x", GatewayMaxHeaderBytes+1)} {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(time.Second))
		io.WriteString(conn, "POST / HTTP/1.1\r\nHost: local\r\nContent-Type: a\r\nContent-Length: 1\r\n"+extra+"\r\nx")
		response, _ := http.ReadResponse(bufio.NewReader(conn), nil)
		if response != nil {
			if response.StatusCode < 400 {
				t.Errorf("accepted duplicate/header limit: %d", response.StatusCode)
			}
			response.Body.Close()
		}
		conn.Close()
	}
	if calls.Load() != 0 {
		t.Fatal("invalid request reached backend")
	}
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	io.WriteString(conn, "POST / HTTP/1.1\r\nHost: local\r\nContent-Type: a\r\nContent-Length: 1\r\nX-Tag: a\r\nX-Tag: b\r\n\r\nx")
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 || calls.Load() != 1 {
		t.Fatal("valid request lost")
	}
}

func TestGatewayRawIngressSupportsCombinedBindingBounds(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := "/" + strings.Repeat("a", 8191)
	value := strings.Repeat("b", 32768-len("x-blob"))
	server := &http.Server{ReadHeaderTimeout: time.Second, MaxHeaderBytes: GatewayMaxHeaderBytes, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RequestURI != target || r.Header.Get("X-Blob") != value {
			t.Error("maximum valid target or header changed")
		}
		w.WriteHeader(204)
	})}
	server.SetKeepAlivesEnabled(false)
	go server.Serve(GatewayListener(listener))
	t.Cleanup(func() { server.Close() })
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	io.WriteString(conn, "GET "+target+" HTTP/1.1\r\nHost: local\r\nX-Blob: "+value+"\r\n\r\n")
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatalf("valid combined binding bounds rejected: %d", response.StatusCode)
	}
}
