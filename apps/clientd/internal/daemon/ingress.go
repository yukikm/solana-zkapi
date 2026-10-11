package daemon

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
)

// Allow the binding's 8 KiB target and 32 KiB semantic headers together,
// including HTTP delimiters and local authentication/transport fields.
const GatewayMaxHeaderBytes = 48 * 1024

// GatewayListener validates singleton fields before net/http can normalize
// repeated Content-Length values. The HTTP server must disable keep-alives:
// every accepted connection carries one request and never an implicit replay.
func GatewayListener(listener net.Listener) net.Listener { return &gatewayListener{listener} }

type gatewayListener struct{ net.Listener }

func (l *gatewayListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &gatewayConn{Conn: conn, reader: bufio.NewReaderSize(conn, 4096)}, nil
}

type gatewayConn struct {
	net.Conn
	reader      *bufio.Reader
	prefix      *bytes.Reader
	initialized bool
	deliveryMu  sync.Mutex
	writeFailed bool
	acknowledge func()
}

func (c *gatewayConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if err != nil || n != len(p) {
		c.deliveryMu.Lock()
		c.writeFailed = true
		c.deliveryMu.Unlock()
	}
	return n, err
}

func (c *gatewayConn) Read(p []byte) (int, error) {
	if !c.initialized {
		c.initialized = true
		var prefix bytes.Buffer
		seen := map[string]bool{}
		for index := 0; ; index++ {
			var lineBuffer bytes.Buffer
			for {
				part, err := c.reader.ReadSlice('\n')
				if prefix.Len()+lineBuffer.Len()+len(part) > GatewayMaxHeaderBytes {
					return 0, errors.New("gateway header limit")
				}
				lineBuffer.Write(part)
				if err == bufio.ErrBufferFull {
					continue
				}
				if err != nil {
					return 0, err
				}
				break
			}
			line := lineBuffer.String()
			prefix.WriteString(line)
			if prefix.Len() > GatewayMaxHeaderBytes {
				return 0, errors.New("gateway header limit")
			}
			if !strings.HasSuffix(line, "\r\n") {
				return 0, errors.New("invalid HTTP header framing")
			}
			if index > 0 && line == "\r\n" {
				break
			}
			if index == 0 {
				continue
			}
			if line[0] == ' ' || line[0] == '\t' {
				return 0, errors.New("folded HTTP field forbidden")
			}
			colon := strings.IndexByte(line, ':')
			if colon <= 0 {
				return 0, errors.New("invalid HTTP header")
			}
			name := strings.ToLower(line[:colon])
			switch name {
			case "host", "content-length", "transfer-encoding", "content-type", "content-encoding", "authorization", "cookie", "accept-encoding", "x-api-key", "idempotency-key":
				if seen[name] {
					return 0, errors.New("duplicate singleton HTTP field")
				}
				seen[name] = true
			}
		}
		// net/http accepts chunked framing with Content-Length and removes the
		// latter. Reject the ambiguity before that lossy normalization.
		if seen["content-length"] && seen["transfer-encoding"] {
			return 0, errors.New("conflicting HTTP framing")
		}
		c.prefix = bytes.NewReader(prefix.Bytes())
	}
	if c.prefix == nil {
		return 0, errors.New("invalid HTTP ingress")
	}
	if c.prefix.Len() > 0 {
		return c.prefix.Read(p)
	}
	return c.reader.Read(p)
}

var _ io.Reader = (*gatewayConn)(nil)
