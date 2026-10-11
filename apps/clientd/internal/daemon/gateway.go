package daemon

import (
	"errors"
	"net/http"
	"strings"
)

// ConfigureGateway only opens the local authenticated carrier boundary. The
// SDK independently validates the exact mounted operation and binding before
// authorization; this list never grants an arbitrary provider destination.
func (s *Server) ConfigureGateway(prefixes []string) error {
	if len(prefixes) > 64 {
		return errors.New("too many gateway mounts")
	}
	seen := make(map[string]bool)
	result := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		if prefix != "" && (!strings.HasPrefix(prefix, "/") || strings.HasSuffix(prefix, "/") || len(prefix) > 1024 || strings.ContainsAny(prefix, "%?#\\") || strings.Contains(prefix, "//")) {
			return errors.New("invalid gateway mount prefix")
		}
		for _, ch := range prefix {
			if ch < 0x21 || ch > 0x7e {
				return errors.New("invalid gateway mount prefix")
			}
		}
		for _, segment := range strings.Split(prefix, "/") {
			if segment == "." || segment == ".." {
				return errors.New("invalid gateway mount prefix")
			}
		}
		if reservedGatewayPath(prefix) {
			return errors.New("gateway mount collides with local control route")
		}
		if !seen[prefix] {
			seen[prefix] = true
			result = append(result, prefix)
		}
	}
	s.GatewayPrefixes = result
	return nil
}

func reservedGatewayPath(path string) bool {
	return path == "/admin" || strings.HasPrefix(path, "/admin/") || path == "/zkapi" || strings.HasPrefix(path, "/zkapi/") || path == "/v1/models"
}

func (s *Server) gatewayTarget(r *http.Request) bool {
	// Check decoded names too: an encoded management path cannot change roles.
	if reservedGatewayPath(r.URL.Path) {
		return false
	}
	path := r.URL.EscapedPath()
	for _, prefix := range s.GatewayPrefixes {
		if prefix == "" || path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}
