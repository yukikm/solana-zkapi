package main

import "testing"

func TestListenAddressNeverResolvesHostnames(t *testing.T) {
	for _, value := range []string{"localhost:8787", "example.org:8787", "0.0.0.0:8787", "127.0.0.1:0", "127.0.0.1:65536", "::1:8787"} {
		if _, err := listenAddress(value); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	for _, value := range []string{"127.0.0.1:8787", "[::1]:8787"} {
		if _, err := listenAddress(value); err != nil {
			t.Fatalf("refused %s", value)
		}
	}
}
