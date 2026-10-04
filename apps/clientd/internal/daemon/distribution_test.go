package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestDistributionChecksWholeInstallAndExternalPin(t *testing.T) {
	dir := t.TempDir()
	source := []byte("installed SDK")
	digest := sha256.Sum256(source)
	file := filepath.Join(dir, "runtime.ts")
	if err := os.WriteFile(file, source, 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"schema": 1, "files": map[string]string{"runtime.ts": hex.EncodeToString(digest[:])}, "platform": "test", "upstream": "045b444ea1b52538d1b40273c7cb6ed09468a052"})
	path := filepath.Join(dir, "release.json")
	_ = os.WriteFile(path, data, 0600)
	sum := sha256.Sum256(data)
	pin := hex.EncodeToString(sum[:])
	if err := VerifyDistribution(path, pin); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "package.json"), []byte("shadow"), 0600)
	if VerifyDistribution(path, pin) == nil {
		t.Fatal("unlisted resolution input accepted")
	}
	_ = os.Remove(filepath.Join(dir, "package.json"))
	_ = os.WriteFile(file, []byte("tampered"), 0600)
	if VerifyDistribution(path, pin) == nil {
		t.Fatal("tampered dependency accepted")
	}
	if VerifyDistribution(path, "00") == nil {
		t.Fatal("missing external pin accepted")
	}
}

func TestDistributionRejectsFifoWithoutReading(t *testing.T) {
	dir := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(dir, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest, _ := json.Marshal(map[string]any{"schema": 1, "files": map[string]string{"fifo": strings.Repeat("0", 64)}})
	path := filepath.Join(dir, "release.json")
	if err := os.WriteFile(path, manifest, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(manifest)
	if err := VerifyDistribution(path, hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("FIFO accepted as an executable dependency")
	}
}
