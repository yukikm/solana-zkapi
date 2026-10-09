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
		os.WriteFile(p, []byte(name), 0600)
		s := sha256.Sum256([]byte(name))
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
		if r.URL.Path == "/v1/models" {
			want = strings.TrimSpace(string(inference))
		}
		if r.Header.Get("Authorization") != "Bearer "+want {
			t.Error("wrong credential")
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
	for _, action := range []string{"status", "models", "purge-settled-bodies"} {
		if err := profileCommand([]string{"request", profile, action}, nil, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	if err := profileCommand([]string{"request", profile, "close"}, nil, io.Discard); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls != 4 {
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
