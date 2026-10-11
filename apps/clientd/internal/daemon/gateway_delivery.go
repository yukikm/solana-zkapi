package daemon

import (
	"context"
	"io"
	"net"
	"net/http"
	"regexp"
)

type gatewayConnectionKey struct{}

// GatewayConnContext associates the single request with its raw connection.
func GatewayConnContext(ctx context.Context, conn net.Conn) context.Context {
	if gateway, ok := conn.(*gatewayConn); ok {
		return context.WithValue(ctx, gatewayConnectionKey{}, gateway)
	}
	return ctx
}

// StateClosed is reported by net/http only after finishRequest has attempted
// the final chunk/trailer flush. A handler Flush alone precedes that framing.
func GatewayConnState(conn net.Conn, state http.ConnState) {
	if gateway, ok := conn.(*gatewayConn); ok && state == http.StateClosed {
		gateway.deliveryMu.Lock()
		ack := gateway.acknowledge
		if gateway.writeFailed {
			ack = nil
		}
		gateway.acknowledge = nil
		gateway.deliveryMu.Unlock()
		if ack != nil {
			go ack()
		}
	}
}

const gatewayDeliveryHeader = "X-Zkapi-Frontend-Delivery"
const gatewayDeliveryPath = "/zkapi/_frontend-delivery"

var gatewayDeliveryToken = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type gatewayDeliveryProxy struct {
	proxy  http.Handler
	client *http.Client
}

func (p *gatewayDeliveryProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.proxy.ServeHTTP(w, r)
	state, ok := r.Context().Value(gatewayContextKey{}).(*gatewayForwardState)
	if !ok || state.delivery == "" || r.Context().Err() != nil {
		return
	}
	// The runtime's Unix-socket finish does not establish local delivery. Only
	// acknowledge after the outer copy and flush have both succeeded. Proxy
	// body errors abort above; any missing acknowledgement keeps the SDK hold.
	if err := http.NewResponseController(w).Flush(); err != nil || r.Context().Err() != nil {
		return
	}
	conn, ok := r.Context().Value(gatewayConnectionKey{}).(*gatewayConn)
	if !ok {
		return
	}
	conn.deliveryMu.Lock()
	conn.acknowledge = func() { p.acknowledge(state.delivery) }
	conn.deliveryMu.Unlock()
}

func (p *gatewayDeliveryProxy) acknowledge(token string) {
	// The HTTP request context is canceled during net/http finalization. This
	// bounded private acknowledgement makes no business request or retry.
	ack, err := http.NewRequest(http.MethodPost, "http://sdk.local"+gatewayDeliveryPath, nil)
	if err != nil {
		return
	}
	ack.Header.Set(gatewayDeliveryHeader, token)
	response, err := p.client.Do(ack)
	if err == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		_ = response.Body.Close()
	}
}
