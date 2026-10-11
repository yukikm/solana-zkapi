package daemon

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type deliveryWriter struct {
	*httptest.ResponseRecorder
	failWrite, failFlush bool
}

func (w *deliveryWriter) Write(body []byte) (int, error) {
	if w.failWrite {
		return 0, io.ErrClosedPipe
	}
	return w.ResponseRecorder.Write(body)
}

func (w *deliveryWriter) FlushError() error {
	if w.failFlush {
		return io.ErrClosedPipe
	}
	w.ResponseRecorder.Flush()
	return nil
}

func TestGatewayAcknowledgesOnlySuccessfulFrontendDelivery(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "s")
	if len(socket) > 90 {
		socket = filepath.Join("/tmp", "zkapi-delivery-test.sock")
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var acks atomic.Int32
	acknowledged := make(chan struct{}, 10)
	const token = "612a28fe-f356-4d3d-9846-053e43186902"
	const operation = "df14163e-bd61-4439-93cb-ad7c7a09e811"
	backend := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == gatewayDeliveryPath {
			if r.Method != "POST" || r.Header.Get(gatewayDeliveryHeader) != token {
				t.Error("invalid delivery acknowledgement")
			}
			acks.Add(1)
			acknowledged <- struct{}{}
			w.WriteHeader(204)
			return
		}
		if r.Header.Get(gatewayDeliveryHeader) != "" {
			t.Error("caller spoof crossed private boundary")
		}
		if r.Header.Get("Idempotency-Key") != operation {
			t.Error("Connection nomination erased local operation identity")
		}
		w.Header().Set(gatewayDeliveryHeader, token)
		_, _ = io.WriteString(w, "complete gateway response")
	})}
	go backend.Serve(listener)
	t.Cleanup(func() { backend.Close() })
	api, err := NewServer(socket, strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	if err != nil {
		t.Fatal(err)
	}
	if err = api.ConfigureGateway([]string{"/native"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name         string
		write, flush bool
		want         int32
	}{
		{"complete", false, false, 1},
		{"disconnected during copy", true, false, 0},
		{"disconnected before flush", false, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			acks.Store(0)
			r := httptest.NewRequest("GET", "/native/result?x=a&x=b%2f", nil)
			r.RemoteAddr = "127.0.0.1:8"
			r.Host = "127.0.0.1:8787"
			r.Header.Set("Authorization", "Bearer "+strings.Repeat("i", 32))
			r.Header.Set("Connection", "Idempotency-Key")
			r.Header.Set("Idempotency-Key", operation)
			r.Header.Set(gatewayDeliveryHeader, "spoofed")
			w := &deliveryWriter{ResponseRecorder: httptest.NewRecorder(), failWrite: tc.write, failFlush: tc.flush}
			conn := &gatewayConn{}
			r = r.WithContext(GatewayConnContext(r.Context(), conn))
			r = r.WithContext(context.WithValue(r.Context(), http.ServerContextKey, &http.Server{}))
			func() {
				defer func() {
					if recovered := recover(); recovered != nil && recovered != http.ErrAbortHandler {
						panic(recovered)
					}
				}()
				api.ServeHTTP(w, r)
			}()
			if acks.Load() != 0 {
				t.Fatal("acknowledged before net/http finalization")
			}
			GatewayConnState(conn, http.StateClosed)
			if tc.want == 1 {
				select {
				case <-acknowledged:
				case <-time.After(time.Second):
					t.Fatal("missing final delivery acknowledgement")
				}
			}
			if got := acks.Load(); got != tc.want {
				t.Fatalf("acknowledgements %d, want %d", got, tc.want)
			}
			if w.Header().Get(gatewayDeliveryHeader) != "" {
				t.Fatal("private delivery token leaked")
			}
		})
	}
}

type finalFramingListener struct {
	net.Listener
	fail  bool
	final chan struct{}
}
type finalFramingConn struct {
	net.Conn
	fail  bool
	final chan struct{}
}

func (l *finalFramingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &finalFramingConn{Conn: conn, fail: l.fail, final: l.final}, nil
}
func (c *finalFramingConn) Write(p []byte) (int, error) {
	if bytes.HasPrefix(p, []byte("0\r\n")) {
		c.final <- struct{}{}
		if c.fail {
			return 0, io.ErrClosedPipe
		}
	}
	return c.Conn.Write(p)
}

func TestGatewayFinalFramingFailureRetainsDeliveryHold(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete trailers", true: "failed final trailer write"}[fail], func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			final := make(chan struct{}, 1)
			acknowledged := make(chan struct{}, 1)
			closed := make(chan struct{}, 1)
			server := &http.Server{ConnContext: GatewayConnContext, ConnState: func(conn net.Conn, state http.ConnState) {
				GatewayConnState(conn, state)
				if state == http.StateClosed {
					closed <- struct{}{}
				}
			}, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Trailer", "X-Final")
				w.WriteHeader(200)
				_, _ = io.WriteString(w, "payload")
				_ = http.NewResponseController(w).Flush()
				w.Header().Set("X-Final", "complete")
				conn := r.Context().Value(gatewayConnectionKey{}).(*gatewayConn)
				conn.deliveryMu.Lock()
				conn.acknowledge = func() { acknowledged <- struct{}{} }
				conn.deliveryMu.Unlock()
			})}
			server.SetKeepAlivesEnabled(false)
			go server.Serve(GatewayListener(&finalFramingListener{Listener: listener, fail: fail, final: final}))
			t.Cleanup(func() { server.Close() })
			conn, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(time.Second))
			_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: local\r\n\r\n")
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal(err)
			}
			_, err = io.ReadAll(response.Body)
			response.Body.Close()
			if fail && err == nil {
				t.Fatal("missing trailers should truncate response")
			}
			if !fail && (err != nil || response.Trailer.Get("X-Final") != "complete") {
				t.Fatalf("lost trailers: %v", err)
			}
			select {
			case <-final:
			case <-time.After(time.Second):
				t.Fatal("final framing not observed")
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("connection not finalized")
			}
			if fail {
				select {
				case <-acknowledged:
					t.Fatal("failed terminal framing acknowledged")
				case <-time.After(20 * time.Millisecond):
				}
			} else {
				select {
				case <-acknowledged:
				case <-time.After(time.Second):
					t.Fatal("complete response not acknowledged")
				}
			}
		})
	}
}

func TestGatewayRejectsUpgradesAndAbsoluteTargets(t *testing.T) {
	api, _ := NewServer("/unused", strings.Repeat("i", 32), strings.Repeat("m", 32), 8787)
	if err := api.ConfigureGateway([]string{"/native"}); err != nil {
		t.Fatal(err)
	}
	api.Backend = http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unsupported transport reached SDK") })
	for _, tc := range []struct{ target, header, value string }{
		{"http://127.0.0.1:8787/native/result", "", ""},
		{"/native/result", "Upgrade", "websocket"},
		{"/native/result", "Connection", "keep-alive, Upgrade"},
	} {
		r := httptest.NewRequest("GET", tc.target, nil)
		r.RemoteAddr, r.Host = "127.0.0.1:8", "127.0.0.1:8787"
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("i", 32))
		if tc.header != "" {
			r.Header.Set(tc.header, tc.value)
		}
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("accepted unsupported transport: %d", w.Code)
		}
	}
}
