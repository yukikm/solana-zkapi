package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// VerifyDistribution starts from a separately trusted SHA256, checks every
// installed file, and rejects extra resolution-shadowing files and symlinks.
// Native release signing is optional to this hash trust route, never self-trust.
func VerifyDistribution(manifestPath, expected string) error {
	if !filepath.IsAbs(manifestPath) || len(expected) != 64 {
		return errors.New("distribution pin required")
	}
	bytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return errors.New("distribution manifest unavailable")
	}
	hash := sha256.Sum256(bytes)
	if hex.EncodeToString(hash[:]) != expected {
		return errors.New("distribution pin mismatch")
	}
	var manifest struct {
		Schema   int               `json:"schema"`
		Files    map[string]string `json:"files"`
		Platform string            `json:"platform"`
		Upstream string            `json:"upstream"`
	}
	if json.Unmarshal(bytes, &manifest) != nil || manifest.Schema != 1 || len(manifest.Files) == 0 {
		return errors.New("invalid distribution manifest")
	}
	root := filepath.Dir(manifestPath)
	seen := 0
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 {
			return errors.New("mutable or linked distribution")
		}
		if entry.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return errors.New("non-regular distribution file")
		}
		if path == manifestPath {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		want, ok := manifest.Files[filepath.ToSlash(relative)]
		if !ok {
			return errors.New("unlisted distribution file")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != want {
			return errors.New("distribution file mismatch")
		}
		seen++
		return nil
	})
	if err != nil {
		return err
	}
	if seen != len(manifest.Files) {
		return errors.New("missing distribution file")
	}
	return nil
}
