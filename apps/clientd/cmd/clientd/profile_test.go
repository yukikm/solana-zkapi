package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func profileFixture(t *testing.T) ([]string, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	install := filepath.Join(root, "install")
	if err = os.Mkdir(install, 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, name := range []string{"bin/clientd", "bin/node", "apps/clientd/runtime.ts", "bin/zkapi-client-prover", "bin/zkapi-client-verify"} {
		p := filepath.Join(install, name)
		os.MkdirAll(filepath.Dir(p), 0700)
		data := []byte(name)
		if name == "bin/node" {
			// Deliberate process stub: these tests verify Go's pinned validator ABI.
			// Runtime contract tests separately exercise the actual Node validator.
			data = []byte("#!/bin/sh\nprintf '%s\\n' '{\"schema\":1,\"valid\":true,\"manifestHash\":\"" + strings.Repeat("a", 64) + "\",\"mode\":\"direct_openrouter\",\"models\":[\"model/chat\"],\"operations\":[],\"custodyInitialized\":false,\"networkActions\":0}'\n")
		}
		os.WriteFile(p, data, 0700)
		s := sha256.Sum256(data)
		files[name] = hex.EncodeToString(s[:])
	}
	release := filepath.Join(install, "release.json")
	writePrivate(release, map[string]any{"schema": 1, "files": files, "platform": "test", "upstream": "test"})
	raw, _ := os.ReadFile(release)
	sum := sha256.Sum256(raw)
	runtime := filepath.Join(root, "reviewed.json")
	writePrivate(runtime, map[string]any{"manifest": "/reviewed/manifest.json", "policy": map[string]any{"anchor": map[string]string{"kind": "hash", "sha256": "unchanged-independent-pin"}}, "artifacts": map[string]string{}, "mode": "direct_openrouter", "models": []any{map[string]any{"id": "model/chat", "apis": []string{"chat"}}}, "rpc": "https://rpc.example", "indexer": "https://indexer.example"})
	raw, _ = os.ReadFile(runtime)
	runtimeSum := sha256.Sum256(raw)
	network := filepath.Join(root, "network.json")
	writePrivate(network, map[string]any{"mode": "direct", "routes": []any{map[string]string{"origin": "https://rpc.example", "prefix": "/"}}})
	profile := filepath.Join(root, "profile")
	return []string{"setup", "--profile", profile, "--distribution", release, "--sha256", hex.EncodeToString(sum[:]), "--runtime-config", runtime, "--runtime-sha256", hex.EncodeToString(runtimeSum[:]), "--network-config", network}, profile, runtime
}
func TestSetupPinsFreshStateAndKeepsTokensPrivate(t *testing.T) {
	args, profile, source := profileFixture(t)
	before, _ := os.ReadFile(source)
	var out bytes.Buffer
	if err := profileCommand(args, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	inference, _ := privateRead(filepath.Join(profile, "inference-token"), 128)
	management, _ := privateRead(filepath.Join(profile, "management-token"), 128)
	if len(strings.TrimSpace(string(inference))) != 64 || bytes.Equal(inference, management) {
		t.Fatal("separate random tokens required")
	}
	if strings.Contains(out.String(), strings.TrimSpace(string(inference))) || strings.Contains(out.String(), strings.TrimSpace(string(management))) {
		t.Fatal("token disclosed")
	}
	after, _ := os.ReadFile(source)
	if !bytes.Equal(before, after) {
		t.Fatal("reviewed input changed")
	}
	raw, _ := os.ReadFile(filepath.Join(profile, "runtime.json"))
	if !bytes.Contains(raw, []byte("unchanged-independent-pin")) {
		t.Fatal("trust pin lost")
	}
	if _, err := os.Stat(filepath.Join(profile, "custody.json")); !os.IsNotExist(err) {
		t.Fatal("setup initialized financial custody")
	}
	if err := profileCommand(args, strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("overwrote profile")
	}
	again, _ := os.ReadFile(filepath.Join(profile, "inference-token"))
	if !bytes.Equal(inference, again) {
		t.Fatal("token reset")
	}
}
func TestSetupRejectsUntrustedAndMutableInstallBeforeCreatingProfile(t *testing.T) {
	for _, kind := range []string{"digest", "runtime", "mutable", "listener"} {
		t.Run(kind, func(t *testing.T) {
			args, profile, _ := profileFixture(t)
			switch kind {
			case "digest":
				args[6] = strings.Repeat("0", 64)
			case "runtime":
				args[10] = strings.Repeat("0", 64)
			case "mutable":
				os.Chmod(filepath.Join(filepath.Dir(args[4]), "bin/node"), 0666)
			case "listener":
				args = append(args, "--listen", "0.0.0.0:8787")
			}
			if err := profileCommand(args, strings.NewReader(""), io.Discard); err == nil {
				t.Fatal("accepted untrusted setup")
			}
			if _, err := os.Stat(profile); !os.IsNotExist(err) {
				t.Fatal("profile created on validation failure")
			}
		})
	}
}
func TestProfileRejectsPermissiveAndLinkedTokenFiles(t *testing.T) {
	args, profile, _ := profileFixture(t)
	if err := profileCommand(args, nil, io.Discard); err != nil {
		t.Fatal(err)
	}
	token := filepath.Join(profile, "inference-token")
	os.Chmod(token, 0644)
	if _, err := privateRead(token, 128); err == nil {
		t.Fatal("world readable token accepted")
	}
	os.Chmod(token, 0600)
	linked := filepath.Join(profile, "linked")
	os.Symlink(token, linked)
	if _, err := privateRead(linked, 128); err == nil {
		t.Fatal("symlink token accepted")
	}
}
func TestOpenClawConfigReferencesOnlyInferenceTokenAndRejectsUnlistedModel(t *testing.T) {
	args, profile, _ := profileFixture(t)
	if err := profileCommand(args, nil, io.Discard); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	command := []string{"openclaw-config", profile, "--model", "model/chat", "--context-window", "128000", "--max-tokens", "1000"}
	if err := profileCommand(command, nil, &out); err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if json.Unmarshal(out.Bytes(), &config) != nil {
		t.Fatal("invalid JSON")
	}
	if strings.Contains(out.String(), "management-token") || !strings.Contains(out.String(), "inference-token") || !strings.Contains(out.String(), "openai-completions") {
		t.Fatal("bad credential boundary")
	}
	raw, _ := os.ReadFile(filepath.Join(profile, "inference-token"))
	if strings.Contains(out.String(), strings.TrimSpace(string(raw))) {
		t.Fatal("embedded token")
	}
	command[3] = "absent"
	if err := profileCommand(command, nil, io.Discard); err == nil {
		t.Fatal("unlisted model accepted")
	}
}
func TestOpenClawConfigRequiresExplicitChatCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name     string
		models   any
		tariff   string
		accepted bool
	}{
		{"legacy_anthropic", []string{"selected-model"}, "/reviewed/anthropic-tariff.json", false},
		{"legacy_openai", []string{"selected-model"}, "/reviewed/openai-tariff.json", false},
		{"explicit_messages", []any{map[string]any{"id": "selected-model", "provider": "anthropic", "apis": []string{"messages", "count_tokens"}, "tariff": "/reviewed/anthropic-tariff.json"}}, "", false},
		{"explicit_chat", []any{map[string]any{"id": "selected-model", "provider": "openai", "apis": []string{"chat", "responses"}, "tariff": "/reviewed/openai-tariff.json"}}, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args, profile, _ := profileFixture(t)
			if err := profileCommand(args, nil, io.Discard); err != nil {
				t.Fatal(err)
			}
			c, err := readProfile(profile)
			if err != nil {
				t.Fatal(err)
			}
			runtime := map[string]any{"mode": "proxy", "models": tc.models}
			if tc.tariff != "" {
				runtime["tariff"] = tc.tariff
			}
			if err := writePrivate(c.RuntimeConfig, runtime); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			err = profileCommand([]string{"openclaw-config", profile, "--model", "selected-model", "--context-window", "32000", "--max-tokens", "512"}, nil, &out)
			if !tc.accepted {
				if err == nil || out.Len() != 0 {
					t.Fatal("emitted OpenClaw configuration without explicit Chat capabilities")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var generated struct {
				Models struct {
					Providers map[string]struct {
						API string `json:"api"`
					} `json:"providers"`
				} `json:"models"`
			}
			if json.Unmarshal(out.Bytes(), &generated) != nil || generated.Models.Providers["zkapi"].API != "openai-completions" {
				t.Fatal("explicit Chat model did not produce the supported OpenClaw API")
			}
		})
	}
}
func TestProfileRequestSeparatesCredentialsAndDoesNotFollowRedirect(t *testing.T) {
	args, profile, _ := profileFixture(t)
	if err := profileCommand(args, nil, io.Discard); err != nil {
		t.Fatal(err)
	}
	inference, _ := os.ReadFile(filepath.Join(profile, "inference-token"))
	management, _ := os.ReadFile(filepath.Join(profile, "management-token"))
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		want := strings.TrimSpace(string(management))
		if r.URL.Path == "/v1/models" || r.URL.Path == "/zkapi/v1/apis" {
			want = strings.TrimSpace(string(inference))
		}
		if r.Header.Get("Authorization") != "Bearer "+want {
			t.Error("wrong credential")
		}
		if r.URL.Path == "/admin/upgrade-plan" || r.URL.Path == "/admin/model-availability" {
			body, err := io.ReadAll(r.Body)
			if err != nil || len(body) != 0 || r.Method != "GET" {
				t.Error("guidance must use empty GET")
			}
		}
		if r.URL.Path == "/admin/purge-settled-bodies" {
			body, err := io.ReadAll(r.Body)
			if err != nil || len(body) != 0 || r.Method != "POST" {
				t.Error("purge must use empty POST body")
			}
		}
		if r.URL.Path == "/admin/close" {
			w.Header().Set("Location", "/admin/wallet")
			w.WriteHeader(307)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{}")
	}))
	defer server.Close()
	c, _ := readProfile(profile)
	c.Listen = strings.TrimPrefix(server.URL, "http://")
	writePrivate(filepath.Join(profile, "config.json"), c)
	for _, action := range []string{"status", "models", "apis", "upgrade-plan", "model-availability", "purge-settled-bodies"} {
		if err := profileCommand([]string{"request", profile, action}, nil, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	if err := profileCommand([]string{"request", profile, "close"}, nil, io.Discard); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls != 7 {
		t.Fatal("request replayed")
	}
}
func TestRunCannotReplaceGeneratedTokensFromStdin(t *testing.T) {
	args, profile, _ := profileFixture(t)
	if err := profileCommand(args, nil, io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := profileCommand([]string{"run", profile}, strings.NewReader(`{"inference_token":"override","passphrase":"passphrase"}`), io.Discard); err == nil {
		t.Fatal("accepted override")
	}
}
func TestSetupRejectsRelativeArtifactAndTariffPaths(t *testing.T) {
	for _, payload := range []string{`{"artifacts":{"idl":"relative.json"},"models":[]}`, `{"artifacts":{"additional":{"extra":"relative.bin"}},"models":[]}`, `{"artifacts":{},"tariff":"relative.json","models":[]}`, `{"artifacts":{},"models":[{"id":"model","tariff":"relative.json"}]}`} {
		var runtime map[string]json.RawMessage
		json.Unmarshal([]byte(payload), &runtime)
		if err := validateDeploymentPaths(runtime); err == nil {
			t.Fatal("accepted relative deployment dependency")
		}
	}
}
func TestSetupDisablesOpenClawProviderRetriesInAgentSettings(t *testing.T) {
	args, profile, _ := profileFixture(t)
	if err := profileCommand(args, nil, io.Discard); err != nil {
		t.Fatal(err)
	}
	raw, err := privateRead(filepath.Join(profile, "openclaw-agent/settings.json"), 4096)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Retry struct {
			Provider struct {
				MaxRetries int `json:"maxRetries"`
			} `json:"provider"`
		} `json:"retry"`
	}
	if json.Unmarshal(raw, &settings) != nil || !bytes.Contains(raw, []byte(`"maxRetries": 0`)) {
		t.Fatal("retry policy missing")
	}
}

func replaceValidator(t *testing.T, args []string, script string) {
	t.Helper()
	root := filepath.Dir(args[4])
	node := filepath.Join(root, "bin/node")
	if err := os.WriteFile(node, []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(args[4])
	var release map[string]json.RawMessage
	json.Unmarshal(raw, &release)
	var files map[string]string
	json.Unmarshal(release["files"], &files)
	raw, _ = os.ReadFile(node)
	sum := sha256.Sum256(raw)
	files["bin/node"] = hex.EncodeToString(sum[:])
	release["files"], _ = json.Marshal(files)
	writePrivate(args[4], release)
	raw, _ = os.ReadFile(args[4])
	sum = sha256.Sum256(raw)
	args[6] = hex.EncodeToString(sum[:])
}
func TestSetupRejectsInvalidValidatorABIWithoutCreatingProfile(t *testing.T) {
	for _, script := range []string{"exit 2", "printf '%s' '{}'", "printf '%s' '{\"valid\":true}'", "printf '%s' 'SECRET_CANARY' >&2; exit 1", "printf '%s' '{'", "printf '%s' '{\"schema\":1,\"valid\":true,\"manifestHash\":\"" + strings.Repeat("a", 64) + "\",\"mode\":\"proxy\",\"models\":[],\"operations\":[],\"custodyInitialized\":false,\"networkActions\":0}'"} {
		args, profile, _ := profileFixture(t)
		replaceValidator(t, args, script)
		var output bytes.Buffer
		err := profileCommand(args, nil, &output)
		if err == nil || strings.Contains(err.Error(), "SECRET_CANARY") || output.Len() != 0 {
			t.Fatalf("invalid or private validator result accepted: %v", err)
		}
		if _, err := os.Stat(profile); !os.IsNotExist(err) {
			t.Fatal("failed validator created profile")
		}
	}
}
func TestSetupAPIOnlySkipsOpenClawAndReturnsAPIBase(t *testing.T) {
	args, profile, runtime := profileFixture(t)
	raw, _ := os.ReadFile(runtime)
	var configuration map[string]any
	json.Unmarshal(raw, &configuration)
	configuration["models"] = []any{}
	configuration["mode"] = "proxy"
	configuration["services"] = []any{map[string]string{"tariff": "/reviewed/api.json"}}
	writePrivate(runtime, configuration)
	raw, _ = os.ReadFile(runtime)
	sum := sha256.Sum256(raw)
	args[10] = hex.EncodeToString(sum[:])
	replaceValidator(t, args, "printf '%s\\n' '{\"schema\":1,\"valid\":true,\"manifestHash\":\""+strings.Repeat("a", 64)+"\",\"mode\":\"proxy\",\"models\":[],\"operations\":[{\"service\":\"catalog\",\"operation\":\"lookup\",\"endpoint\":\"/zkapi/v1/api/catalog/lookup\",\"tariffHash\":\""+strings.Repeat("b", 64)+"\"}],\"custodyInitialized\":false,\"networkActions\":0}'")
	var out bytes.Buffer
	if err := profileCommand(args, nil, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(profile, "openclaw-agent")); !os.IsNotExist(err) {
		t.Fatal("API-only OpenClaw files created")
	}
	if !strings.Contains(out.String(), `"api_base_url":"http://127.0.0.1:8787/zkapi/v1"`) {
		t.Fatal("API base missing")
	}
}
func TestServicePathsRequireClosedCanonicalContainer(t *testing.T) {
	for _, service := range []string{`null`, `{}`, `[{"tariff":"relative"}]`, `[{"tariff":"/a/../b"}]`, `[{"tariff":"/api","secret":"canary"}]`, `[{}]`} {
		var runtime map[string]json.RawMessage
		json.Unmarshal([]byte(`{"artifacts":{},"models":[],"services":`+service+`}`), &runtime)
		if validateDeploymentPaths(runtime) == nil {
			t.Fatal("accepted unsafe service container", service)
		}
	}
}
func TestAPICommandValidatesBeforeDispatchAndSendsExactlyOnce(t *testing.T) {
	args, profile, _ := profileFixture(t)
	if err := profileCommand(args, nil, io.Discard); err != nil {
		t.Fatal(err)
	}
	c, _ := readProfile(profile)
	tariff := filepath.Join(profile, "api.json")
	writePrivate(tariff, map[string]any{"api": map[string]string{"service": "catalog", "operation": "lookup", "request_max_bytes": "64", "response_max_bytes": "32", "timeout_seconds": "600"}})
	writePrivate(c.RuntimeConfig, map[string]any{"models": []any{}, "services": []any{map[string]string{"tariff": tariff}}})
	token, _ := privateRead(filepath.Join(profile, "inference-token"), 128)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/zkapi/v1/api/catalog/lookup" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+strings.TrimSpace(string(token)) || r.Header.Get("Idempotency-Key") != "00112233-4455-4677-8899-aabbccddeeff" {
			t.Error("wrong API request")
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	c.Listen = strings.TrimPrefix(server.URL, "http://")
	command := []string{profile, "--service", "catalog", "--operation", "lookup", "--operation-id", "00112233-4455-4677-8899-aabbccddeeff"}
	for _, body := range []string{"{", strings.Repeat(" ", 65), `{"query":`} {
		if profileAPIRequest(c, command, strings.NewReader(body), io.Discard, io.Discard) == nil {
			t.Fatal("invalid body accepted")
		}
	}
	for _, id := range []string{"", "00112233-4455-1677-8899-aabbccddeeff"} {
		bad := append([]string{}, command...)
		bad[6] = id
		if profileAPIRequest(c, bad, strings.NewReader("{}"), io.Discard, io.Discard) == nil {
			t.Fatal("invalid identity accepted")
		}
	}
	if calls != 0 {
		t.Fatal("invalid request dispatched")
	}
	var out, diagnostic bytes.Buffer
	if err := profileAPIRequest(c, command, strings.NewReader("{}"), &out, &diagnostic); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || out.String() != `{"ok":true}` || strings.Contains(diagnostic.String(), strings.TrimSpace(string(token))) {
		t.Fatal("API replayed or disclosed token")
	}
	if newLocalHTTPClient(apiRequestTimeout).Timeout != 15*time.Minute || apiDiscoveryTimeout != 30*time.Second {
		t.Fatal("generic deadline changed")
	}
}

func TestNativeHTTPDeadlineCoversResponseConsumptionWithoutReplay(t *testing.T) {
	calls := 0
	canceled := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		canceled <- struct{}{}
	}))
	defer server.Close()
	response, err := newLocalHTTPClient(20 * time.Millisecond).Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(response.Body)
	response.Body.Close()
	if err == nil {
		t.Fatal("body consumption outlived overall deadline")
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("deadline did not cancel request")
	}
	if calls != 1 {
		t.Fatal("uncertain API request replayed")
	}
}
