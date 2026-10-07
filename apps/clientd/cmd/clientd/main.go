// clientd is the Go localhost frontend to the shared Solana SDK state machine.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"solana-zkapi/clientd/internal/daemon"
	"solana-zkapi/clientd/internal/egress"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	Distribution       string        `json:"distribution"`
	DistributionSHA256 string        `json:"distribution_sha256"`
	Node               string        `json:"node"`
	NodeSHA256         string        `json:"node_sha256"`
	Runtime            string        `json:"runtime"`
	RuntimeSHA256      string        `json:"runtime_sha256"`
	RuntimeConfig      string        `json:"runtime_config"`
	Listen             string        `json:"listen"`
	Network            egress.Config `json:"network"`
}
type Secrets struct {
	Inference  string `json:"inference_token"`
	Management string `json:"management_token"`
	Passphrase string `json:"passphrase"`
	WalletSeed string `json:"wallet_seed_base64,omitempty"`
	Initialize bool   `json:"initialize_key,omitempty"`
}

func pinned(path, digest string) error {
	if !filepath.IsAbs(path) || len(digest) != 64 {
		return errors.New("absolute pinned artifact required")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
		return errors.New("unsafe executable artifact")
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(bytes)
	if hex.EncodeToString(sum[:]) != digest {
		return errors.New("artifact digest mismatch")
	}
	return nil
}
func listenAddress(value string) (*net.TCPAddr, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return nil, errors.New("numeric loopback listener required")
	}
	ip := net.ParseIP(host)
	port, err := strconv.Atoi(portText)
	if err != nil || ip == nil || !ip.IsLoopback() || port < 1 || port > 65535 {
		return nil, errors.New("numeric loopback listener required")
	}
	return &net.TCPAddr{IP: ip, Port: port}, nil
}

func run() error {
	if len(os.Args) >= 2 && os.Args[1] != "serve" {
		return profileCommand(os.Args[1:], os.Stdin, os.Stdout)
	}
	if len(os.Args) != 3 || os.Args[1] != "serve" {
		return errors.New(commandHelp)
	}
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		return errors.New("configuration unavailable")
	}
	var c Config
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil {
		return errors.New("invalid configuration")
	}
	return runConfig(c, os.Stdin)
}

func runConfig(c Config, secretInput io.Reader) error {
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8787"
	}
	address, err := listenAddress(c.Listen)
	if err != nil {
		return err
	}
	if err = daemon.VerifyDistribution(c.Distribution, c.DistributionSHA256); err != nil {
		return err
	}
	if err = pinned(c.Node, c.NodeSHA256); err != nil {
		return err
	}
	if err = pinned(c.Runtime, c.RuntimeSHA256); err != nil {
		return err
	}
	for _, p := range []string{c.Node, c.Runtime} {
		rel, e := filepath.Rel(filepath.Dir(c.Distribution), p)
		if e != nil || rel == ".." || strings.HasPrefix(rel, "../") {
			return errors.New("runtime must be inside pinned distribution")
		}
	}
	return serve(c, address, secretInput)
}

func serve(c Config, address *net.TCPAddr, secretInput io.Reader) error {
	input := bufio.NewReader(io.LimitReader(secretInput, 16*1024))
	line, err := input.ReadBytes('\n')
	if err != nil {
		return errors.New("secrets JSON line required on stdin")
	}
	var secret Secrets
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&secret) != nil {
		return errors.New("invalid secret input")
	}
	for i := range line {
		line[i] = 0
	}
	if len(secret.Passphrase) < 16 {
		return errors.New("passphrase is too short")
	}
	// Short private paths also fit macOS's sockaddr_un limit. Sockets disappear on normal exit.
	dir, err := os.MkdirTemp("", "zkapi-clientd-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err = os.Chmod(dir, 0700); err != nil {
		return err
	}
	relaySocket, sdkSocket := filepath.Join(dir, "net.sock"), filepath.Join(dir, "sdk.sock")
	relay, err := egress.New(c.Network)
	if err != nil {
		return err
	}
	network, err := net.Listen("unix", relaySocket)
	if err != nil {
		return err
	}
	_ = os.Chmod(relaySocket, 0600)
	netServer := &http.Server{Handler: relay, ReadHeaderTimeout: 10 * time.Second}
	defer netServer.Close()
	go func() { _ = netServer.Serve(network) }()
	frontend, err := daemon.NewServer(sdkSocket, secret.Inference, secret.Management, address.Port)
	if err != nil {
		return err
	}
	child := exec.Command(c.Node, c.Runtime, c.RuntimeConfig, sdkSocket, relaySocket)
	child.Env = []string{"PATH=" + filepath.Dir(c.Node), "RAYON_NUM_THREADS=4"}
	child.Stderr = io.Discard
	stdin, err := child.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stdout, err := child.StdoutPipe()
	if err != nil {
		return err
	}
	if err = child.Start(); err != nil {
		return errors.New("SDK runtime start failed")
	}
	// Exactly one goroutine reaps the process. A closed channel publishes exit
	// to every cleanup path without racing exec.Cmd.ProcessState or double Wait.
	childDone := make(chan struct{})
	go func() { _ = child.Wait(); close(childDone) }()
	defer func() {
		select {
		case <-childDone:
			return
		default:
			_ = child.Process.Kill()
			<-childDone
		}
	}()
	if err = json.NewEncoder(stdin).Encode(map[string]any{"passphrase": secret.Passphrase, "wallet_seed_base64": secret.WalletSeed, "initialize_key": secret.Initialize}); err != nil {
		return errors.New("SDK secret handoff failed")
	}
	// Keep this private pipe open as the runtime's supervisor lifetime signal.
	// SIGKILL cannot run Go defers, but the OS still closes the write end so the
	// SDK can release its journal lock instead of orphaning the next restart.
	secret.Passphrase = ""
	secret.WalletSeed = ""
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		ready <- scanner.Scan() && scanner.Text() == "READY"
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case ok := <-ready:
		if !ok {
			return errors.New("SDK failed trust, custody or recovery validation")
		}
	case <-time.After(5 * time.Minute):
		return errors.New("SDK startup timed out")
	}
	listener, err := net.ListenTCP("tcp", address)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: frontend, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	ended := make(chan error, 1)
	go func() { ended <- server.Serve(listener) }()
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, syscall.SIGTERM, os.Interrupt)
	defer signal.Stop(interrupt)
	fmt.Fprintln(os.Stdout, "clientd listening on "+c.Listen+"; mode is fixed by configuration")
	select {
	case <-interrupt:
	case <-childDone:
		_ = server.Close()
		return errors.New("SDK stopped; unresolved operations retained")
	case <-ended:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = child.Process.Signal(syscall.SIGTERM)
	select {
	case <-childDone:
	case <-ctx.Done():
		_ = child.Process.Kill()
		<-childDone
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
