//go:build ignore

// Fixture-only harness around the production Go HTTP frontend. Financial and
// provider fixtures live in run_codex_clientd_acceptance.ts, not this adapter.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"solana-zkapi/clientd/internal/daemon"
	"strconv"
)

func main() {
	var tokens struct {
		Inference  string `json:"inference_token"`
		Management string `json:"management_token"`
	}
	if len(os.Args) != 3 || json.NewDecoder(os.Stdin).Decode(&tokens) != nil {
		os.Exit(1)
	}
	port, err := strconv.Atoi(os.Args[2])
	if err != nil {
		os.Exit(1)
	}
	handler, err := daemon.NewServer(os.Args[1], tokens.Inference, tokens.Management, port)
	if err != nil {
		os.Exit(1)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+os.Args[2])
	if err != nil {
		os.Exit(1)
	}
	fmt.Println("READY")
	if http.Serve(listener, handler) != nil {
		os.Exit(1)
	}
}
