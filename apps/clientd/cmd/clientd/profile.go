package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"solana-zkapi/clientd/internal/daemon"
	"solana-zkapi/clientd/internal/egress"
)

const commandHelp = `usage: clientd setup --profile DIR --distribution /install/release.json --sha256 TRUSTED_SHA256 --runtime-config /reviewed/runtime.json --runtime-sha256 TRUSTED_SHA256 --network-config /reviewed/network.json
       clientd run /absolute/profile (passphrase and optional wallet_seed_base64/initialize_key JSON on stdin)
       clientd request /absolute/profile status|upgrade-plan|model-availability|models|close|recover|reconcile|cancel-unsent|purge-settled-bodies|wallet (POST body JSON on stdin for wallet/reconcile)
       clientd openclaw-config /absolute/profile --model ID --context-window N --max-tokens N
       clientd serve /absolute/config.json (full secrets JSON on stdin)`

func jsonDecode(raw []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return errors.New("invalid JSON configuration")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON configuration")
	}
	return nil
}
func privateRead(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private regular file required")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("private file unavailable")
	}
	defer f.Close()
	actual, err := f.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return nil, errors.New("private file changed")
	}
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, errors.New("private file exceeds limit")
	}
	return raw, nil
}
func profilePath(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("absolute profile directory required")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return "", errors.New("private profile directory required")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != filepath.Clean(path) {
		return "", errors.New("canonical profile directory required")
	}
	return real, nil
}
func writePrivate(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return os.WriteFile(path, raw, 0600)
}
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func readProfile(path string) (Config, error) {
	var c Config
	root, err := profilePath(path)
	if err != nil {
		return c, err
	}
	raw, err := privateRead(filepath.Join(root, "config.json"), 1024*1024)
	if err != nil {
		return c, err
	}
	if err = jsonDecode(raw, &c); err != nil {
		return c, err
	}
	if c.RuntimeConfig != filepath.Join(root, "runtime.json") {
		return c, errors.New("profile runtime path changed")
	}
	if _, err = listenAddress(c.Listen); err != nil {
		return c, err
	}
	return c, nil
}
func profileCommand(args []string, input io.Reader, output io.Writer) error {
	if len(args) == 0 {
		return errors.New(commandHelp)
	}
	if args[0] == "help" || args[0] == "--help" {
		_, err := fmt.Fprintln(output, commandHelp)
		return err
	}
	if args[0] == "setup" {
		return setupProfile(args[1:], output)
	}
	if len(args) < 2 {
		return errors.New(commandHelp)
	}
	c, err := readProfile(args[1])
	if err != nil {
		return err
	}
	switch args[0] {
	case "run":
		if len(args) != 2 {
			return errors.New(commandHelp)
		}
		var supplied struct {
			Passphrase string `json:"passphrase"`
			WalletSeed string `json:"wallet_seed_base64,omitempty"`
			Initialize bool   `json:"initialize_key,omitempty"`
		}
		raw, err := io.ReadAll(io.LimitReader(input, 16*1024+1))
		if err != nil || len(raw) > 16*1024 {
			return errors.New("bounded secrets JSON required")
		}
		if err = jsonDecode(raw, &supplied); err != nil {
			return err
		}
		for i := range raw {
			raw[i] = 0
		}
		inference, err := privateRead(filepath.Join(args[1], "inference-token"), 128)
		if err != nil {
			return err
		}
		management, err := privateRead(filepath.Join(args[1], "management-token"), 128)
		if err != nil {
			return err
		}
		secret := Secrets{Inference: strings.TrimSpace(string(inference)), Management: strings.TrimSpace(string(management)), Passphrase: supplied.Passphrase, WalletSeed: supplied.WalletSeed, Initialize: supplied.Initialize}
		raw, err = json.Marshal(secret)
		if err != nil {
			return err
		}
		raw = append(raw, '\n')
		defer func() {
			for i := range raw {
				raw[i] = 0
			}
		}()
		return runConfig(c, bytes.NewReader(raw))
	case "request":
		return profileRequest(c, args[1:], input, output)
	case "openclaw-config":
		return openClawConfig(c, args[1:], output)
	default:
		return errors.New(commandHelp)
	}
}
func setupProfile(args []string, output io.Writer) error {
	f := flag.NewFlagSet("setup", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	profile := f.String("profile", "", "new private directory")
	release := f.String("distribution", "", "installed release manifest")
	pin := f.String("sha256", "", "independently trusted distribution digest")
	runtimePath := f.String("runtime-config", "", "reviewed deployment runtime JSON")
	runtimePin := f.String("runtime-sha256", "", "independently reviewed runtime configuration digest")
	networkPath := f.String("network-config", "", "reviewed explicit network routes")
	listen := f.String("listen", "127.0.0.1:8787", "numeric loopback address")
	if f.Parse(args) != nil || f.NArg() != 0 {
		return errors.New(commandHelp)
	}
	if !filepath.IsAbs(*profile) || !filepath.IsAbs(*runtimePath) || !filepath.IsAbs(*networkPath) {
		return errors.New("absolute setup paths required")
	}
	if _, err := listenAddress(*listen); err != nil {
		return err
	}
	if err := daemon.VerifyDistribution(*release, *pin); err != nil {
		return err
	}
	raw, err := os.ReadFile(*runtimePath)
	if err != nil {
		return errors.New("reviewed runtime unavailable")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != *runtimePin {
		return errors.New("reviewed runtime pin mismatch")
	}
	var runtime map[string]json.RawMessage
	if err = jsonDecode(raw, &runtime); err != nil {
		return err
	}
	for _, key := range []string{"manifest", "policy", "artifacts", "mode", "models", "rpc", "indexer"} {
		if len(runtime[key]) == 0 || string(runtime[key]) == "null" {
			return errors.New("reviewed runtime missing required field")
		}
	}
	// A copied deployment must be relocatable only through explicitly reviewed
	// absolute paths. Trust policy/artifact bytes are never derived from a server.
	var manifestPath string
	if json.Unmarshal(runtime["manifest"], &manifestPath) != nil || !filepath.IsAbs(manifestPath) {
		return errors.New("absolute reviewed manifest required")
	}
	if err := validateDeploymentPaths(runtime); err != nil {
		return err
	}
	var network egress.Config
	raw, err = os.ReadFile(*networkPath)
	if err != nil {
		return errors.New("network configuration unavailable")
	}
	if err = jsonDecode(raw, &network); err != nil {
		return err
	}
	if _, err = egress.New(network); err != nil {
		return err
	}
	raw, err = os.ReadFile(*release)
	if err != nil {
		return err
	}
	var manifest struct {
		Files map[string]string `json:"files"`
	}
	if json.Unmarshal(raw, &manifest) != nil {
		return errors.New("invalid release")
	}
	installed := filepath.Dir(*release)
	for _, name := range []string{"bin/clientd", "bin/node", "apps/clientd/runtime.ts", "bin/zkapi-client-prover", "bin/zkapi-client-verify"} {
		if len(manifest.Files[name]) != 64 {
			return errors.New("release is missing clientd artifacts")
		}
	}
	root := filepath.Clean(*profile)
	parent, err := filepath.EvalSymlinks(filepath.Dir(root))
	if err != nil {
		return errors.New("profile parent must already exist")
	}
	root = filepath.Join(parent, filepath.Base(root))
	if err = os.Mkdir(root, 0700); err != nil {
		return errors.New("profile already exists or cannot be created; never reset an existing profile")
	}
	// Retain partial setup on failure for inspection; never remove preexisting or
	// partially created private state and never initialize financial custody here.
	if err = os.Mkdir(filepath.Join(root, "journal"), 0700); err != nil {
		return err
	}
	if err = os.Mkdir(filepath.Join(root, "openclaw-agent"), 0700); err != nil {
		return err
	}
	if err = writePrivate(filepath.Join(root, "openclaw-agent", "settings.json"), map[string]any{"retry": map[string]any{"provider": map[string]int{"maxRetries": 0}}}); err != nil {
		return err
	}
	assign := func(key string, v any) { runtime[key], _ = json.Marshal(v) }
	assign("journal", filepath.Join(root, "journal"))
	assign("custody", filepath.Join(root, "custody.json"))
	note, err := randomToken()
	if err != nil {
		return err
	}
	assign("note_id", "note-"+note)
	for key, name := range map[string]string{"prover": "bin/zkapi-client-prover", "verifier": "bin/zkapi-client-verify"} {
		assign(key, map[string]string{"path": filepath.Join(installed, name), "sha256": manifest.Files[name]})
	}
	if err = writePrivate(filepath.Join(root, "runtime.json"), runtime); err != nil {
		return err
	}
	for _, name := range []string{"inference-token", "management-token"} {
		token, err := randomToken()
		if err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(root, name), []byte(token+"\n"), 0600); err != nil {
			return err
		}
	}
	c := Config{Distribution: *release, DistributionSHA256: *pin, Node: filepath.Join(installed, "bin/node"), NodeSHA256: manifest.Files["bin/node"], Runtime: filepath.Join(installed, "apps/clientd/runtime.ts"), RuntimeSHA256: manifest.Files["apps/clientd/runtime.ts"], RuntimeConfig: filepath.Join(root, "runtime.json"), Listen: *listen, Network: network}
	if err = writePrivate(filepath.Join(root, "config.json"), c); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]any{"profile": root, "base_url": "http://" + *listen + "/v1", "custody_initialized": false, "funded": false, "next": "run this profile with initialize_key:true exactly once; supply passphrase and wallet seed only on stdin"})
}
func profileRequest(c Config, args []string, input io.Reader, output io.Writer) error {
	if len(args) != 2 {
		return errors.New(commandHelp)
	}
	routes := map[string]string{"status": "/admin/status", "upgrade-plan": "/admin/upgrade-plan", "model-availability": "/admin/model-availability", "models": "/v1/models", "close": "/admin/close", "recover": "/admin/recover", "reconcile": "/admin/reconcile", "cancel-unsent": "/admin/cancel-unsent", "purge-settled-bodies": "/admin/purge-settled-bodies", "wallet": "/admin/wallet"}
	route, ok := routes[args[1]]
	if !ok {
		return errors.New("unsupported local request")
	}
	method := "POST"
	body := []byte("{}")
	if args[1] == "status" || args[1] == "models" || args[1] == "upgrade-plan" || args[1] == "model-availability" {
		method = "GET"
		body = nil
	} else if args[1] == "purge-settled-bodies" {
		body = nil
	} else if args[1] == "wallet" || args[1] == "reconcile" {
		var err error
		body, err = io.ReadAll(io.LimitReader(input, 1024*1024+1))
		if err != nil || len(body) > 1024*1024 || !json.Valid(body) {
			return errors.New("bounded command JSON required")
		}
	}
	name := "management-token"
	if args[1] == "models" {
		name = "inference-token"
	}
	token, err := privateRead(filepath.Join(args[0], name), 128)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(method, "http://"+c.Listen+route, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	request.Header.Set("Content-Type", "application/json")
	// No redirect, proxy, transport reuse, or mutation retry. An interrupted wallet
	// request is inspected with status/advance through the existing SDK journal.
	client := http.Client{Timeout: 5 * time.Minute, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("local request failed; inspect status before further action")
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(result) > 1024*1024 {
		return errors.New("invalid local response")
	}
	if _, err = output.Write(result); err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("local request returned HTTP %d; no automatic retry", response.StatusCode)
	}
	return nil
}
func openClawConfig(c Config, args []string, output io.Writer) error {
	f := flag.NewFlagSet("openclaw-config", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	model := f.String("model", "", "configured Chat model ID")
	contextWindow := f.Int("context-window", 0, "reviewed model context size")
	maxTokens := f.Int("max-tokens", 0, "reviewed output token cap")
	if f.Parse(args[1:]) != nil || f.NArg() != 0 || *model == "" || *contextWindow < 1 || *maxTokens < 1 || *maxTokens > *contextWindow {
		return errors.New("model, positive context-window and bounded max-tokens required")
	}
	raw, err := privateRead(c.RuntimeConfig, 1024*1024)
	if err != nil {
		return err
	}
	var runtime struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(raw, &runtime) != nil {
		return errors.New("invalid runtime models")
	}
	found := false
	for _, entry := range runtime.Models {
		var id string
		if json.Unmarshal(entry, &id) == nil {
			// Legacy model capabilities come from the authenticated tariff in the
			// SDK. An ID alone cannot establish the Chat API used by OpenClaw.
			if id == *model {
				return errors.New("OpenClaw requires an explicit model entry with chat in apis; migrate the reviewed legacy model configuration")
			}
			continue
		}
		var m struct {
			ID   string   `json:"id"`
			APIs []string `json:"apis"`
		}
		if json.Unmarshal(entry, &m) == nil && m.ID == *model {
			for _, api := range m.APIs {
				found = found || api == "chat"
			}
		}
	}
	if !found {
		return errors.New("model must be a configured Chat model")
	}
	modelEntry := map[string]any{"id": *model, "name": *model, "reasoning": false, "input": []string{"text"}, "contextWindow": *contextWindow, "maxTokens": *maxTokens, "compat": map[string]any{"supportsStore": false, "supportsDeveloperRole": false, "supportsPromptCacheKey": false, "maxTokensField": "max_tokens"}}
	provider := map[string]any{"baseUrl": "http://" + c.Listen + "/v1", "api": "openai-completions", "apiKey": map[string]string{"source": "file", "provider": "zkapi-local", "id": "value"}, "models": []any{modelEntry}}
	config := map[string]any{
		"secrets": map[string]any{"providers": map[string]any{"zkapi-local": map[string]any{"source": "file", "path": filepath.Join(args[0], "inference-token"), "mode": "singleValue"}}},
		"models":  map[string]any{"mode": "merge", "providers": map[string]any{"zkapi": provider}},
		"agents": map[string]any{
			"list":     []any{map[string]any{"id": "zkapi", "default": true, "agentDir": filepath.Join(args[0], "openclaw-agent")}},
			"defaults": map[string]any{"model": map[string]any{"primary": "zkapi/" + *model, "fallbacks": []string{}}, "maxConcurrent": 1, "embeddedAgent": map[string]string{"projectSettingsPolicy": "ignore"}},
		},
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(config)
}

func validateDeploymentPaths(runtime map[string]json.RawMessage) error {
	absolute := func(raw json.RawMessage) bool {
		var path string
		return json.Unmarshal(raw, &path) == nil && filepath.IsAbs(path)
	}
	var artifacts map[string]json.RawMessage
	if json.Unmarshal(runtime["artifacts"], &artifacts) != nil {
		return errors.New("invalid artifact paths")
	}
	for key, value := range artifacts {
		if key == "additional" {
			var additional map[string]json.RawMessage
			if json.Unmarshal(value, &additional) != nil {
				return errors.New("invalid additional artifact paths")
			}
			for _, path := range additional {
				if !absolute(path) {
					return errors.New("absolute artifact paths required")
				}
			}
		} else if !absolute(value) {
			return errors.New("absolute artifact paths required")
		}
	}
	if path, ok := runtime["tariff"]; ok && !absolute(path) {
		return errors.New("absolute tariff path required")
	}
	var models []json.RawMessage
	if json.Unmarshal(runtime["models"], &models) != nil {
		return errors.New("invalid model paths")
	}
	for _, entry := range models {
		var model map[string]json.RawMessage
		if json.Unmarshal(entry, &model) == nil {
			if path, ok := model["tariff"]; ok && !absolute(path) {
				return errors.New("absolute model tariff path required")
			}
		}
	}
	return nil
}
