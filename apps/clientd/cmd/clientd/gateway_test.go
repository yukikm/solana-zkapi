package main

import (
	"os"
	"path/filepath"
	"reflect"
	"solana-zkapi/clientd/internal/daemon"
	"strings"
	"testing"
)

func TestGatewayRuntimePreservesPublicConfigurationPermissions(t *testing.T) {
	for _, mode := range []os.FileMode{0600, 0644} {
		for _, gateway := range []bool{false, true} {
			name := mode.String()
			if gateway {
				name += "/gateway"
			} else {
				name += "/legacy"
			}
			t.Run(name, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "runtime.json")
				raw := `{}`
				var expected []string
				if gateway {
					raw = `{"gateway":{"capabilities":["finite_http_v1"],"mounts":[{"prefix":"/catalog","service":"catalog","operation":"lookup","binding_hash":"fixture"}]}}`
					expected = []string{"/catalog"}
				}
				if err := os.WriteFile(path, []byte(raw), mode); err != nil {
					t.Fatal(err)
				}
				// Make the regression independent of the caller's umask.
				if err := os.Chmod(path, mode); err != nil {
					t.Fatal(err)
				}
				frontend := &daemon.Server{}
				if err := configureGatewayFrontend(frontend, path); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(frontend.GatewayPrefixes, expected) {
					t.Fatalf("mounts: got %v, want %v", frontend.GatewayPrefixes, expected)
				}
				if mode == 0644 {
					if _, err := privateRead(path, 1024*1024); err == nil {
						t.Fatal("secret-file reader accepted public permissions")
					}
				}
			})
		}
	}
}

func TestGatewayRuntimeRejectsUnsafeOrOversizedFiles(t *testing.T) {
	for _, kind := range []string{"group-writable", "world-writable", "symlink", "directory", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "runtime.json")
			if err := os.WriteFile(path, []byte(`{}`), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			switch kind {
			case "group-writable":
				err = os.Chmod(path, 0664)
			case "world-writable":
				err = os.Chmod(path, 0666)
			case "symlink":
				link := filepath.Join(root, "link.json")
				err = os.Symlink(path, link)
				path = link
			case "directory":
				path = root
			case "oversized":
				err = os.WriteFile(path, []byte(`{}`+strings.Repeat(" ", 1024*1024)), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			frontend := &daemon.Server{}
			if err := configureGatewayFrontend(frontend, path); err == nil {
				t.Fatal("accepted unsafe runtime configuration")
			}
			if len(frontend.GatewayPrefixes) != 0 {
				t.Fatal("unsafe configuration enabled gateway mounts")
			}
		})
	}
}
