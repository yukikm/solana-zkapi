package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"solana-zkapi/clientd/internal/daemon"
)

// Runtime configuration contains public inputs; secrets arrive on stdin.
// Preserve the low-level serve contract for owner-writable 0644 files while
// rejecting symlinks, mutable shared inputs and unbounded configuration reads.
func readGatewayRuntime(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > limit {
		return nil, errors.New("bounded public configuration required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("configuration unavailable")
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) || !actual.Mode().IsRegular() || actual.Mode().Perm()&0022 != 0 {
		return nil, errors.New("configuration changed")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, errors.New("configuration exceeds bound")
	}
	return raw, nil
}

func configureGatewayFrontend(frontend *daemon.Server, runtimePath string) error {
	raw, err := readGatewayRuntime(runtimePath, 1024*1024)
	if err != nil {
		return errors.New("runtime configuration unavailable")
	}
	var runtime map[string]json.RawMessage
	if err = jsonDecode(raw, &runtime); err != nil {
		return errors.New("invalid runtime configuration")
	}
	encoded, present := runtime["gateway"]
	if !present {
		return nil
	}
	var gateway struct {
		Capabilities []string `json:"capabilities"`
		Mounts       []struct {
			Prefix      string `json:"prefix"`
			Service     string `json:"service"`
			Operation   string `json:"operation"`
			BindingHash string `json:"binding_hash"`
		} `json:"mounts"`
	}
	if string(encoded) == "null" || jsonDecode(encoded, &gateway) != nil || len(gateway.Capabilities) != 1 || gateway.Capabilities[0] != "finite_http_v1" || len(gateway.Mounts) == 0 {
		return errors.New("invalid gateway configuration")
	}
	prefixes := make([]string, len(gateway.Mounts))
	for i, mount := range gateway.Mounts {
		prefixes[i] = mount.Prefix
	}
	return frontend.ConfigureGateway(prefixes)
}
