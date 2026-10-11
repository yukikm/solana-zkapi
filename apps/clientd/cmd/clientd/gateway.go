package main

import (
	"encoding/json"
	"errors"
	"solana-zkapi/clientd/internal/daemon"
)

func configureGatewayFrontend(frontend *daemon.Server, runtimePath string) error {
	raw, err := privateRead(runtimePath, 1024*1024)
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
