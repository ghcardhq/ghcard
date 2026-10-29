// Package config resolves the CLI's API key and server URL.
//
// Precedence, highest first: command-line flag, environment variable
// (GHCARD_API_KEY, GHCARD_BASE_URL), then the config file written by
// `ghcard auth login`. Environment variables let CI jobs and AI agents run
// without touching the user's config file.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const (
	EnvAPIKey  = "GHCARD_API_KEY"
	EnvBaseURL = "GHCARD_BASE_URL"
	EnvConfig  = "GHCARD_CONFIG"
)

// File is the on-disk config. It holds a secret, so it is written 0600.
type File struct {
	APIKey  string `json:"apiKey,omitempty"`
	BaseURL string `json:"baseUrl,omitempty"`
}

// Path returns the config file location: $GHCARD_CONFIG, or
// <user config dir>/ghcard/config.json.
func Path() (string, error) {
	if p := os.Getenv(EnvConfig); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find config directory: %w", err)
	}
	return filepath.Join(dir, "ghcard", "config.json"), nil
}

// Load reads the config file. A missing file is an empty config.
func Load() (File, error) {
	path, err := Path()
	if err != nil {
		return File{}, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return File{}, nil
	}
	if err != nil {
		return File{}, fmt.Errorf("read %s: %w", path, err)
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return File{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return f, nil
}

// Save writes the config file with owner-only permissions.
func Save(f File) (string, error) {
	path, err := Path()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return "", fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", fmt.Errorf("replace %s: %w", path, err)
	}
	return path, nil
}

// Source names where a resolved value came from, for `ghcard auth status`.
type Source string

const (
	SourceFlag    Source = "flag"
	SourceEnv     Source = "env"
	SourceFile    Source = "config"
	SourceDefault Source = "default"
	SourceNone    Source = "none"
)

// Resolved is the effective configuration for one invocation.
type Resolved struct {
	APIKey        string
	APIKeySource  Source
	BaseURL       string
	BaseURLSource Source
}

// Resolve applies flag > env > file > default.
func Resolve(flagKey, flagBaseURL, defaultBaseURL string) (Resolved, error) {
	file, err := Load()
	if err != nil {
		return Resolved{}, err
	}
	r := Resolved{APIKeySource: SourceNone}
	switch {
	case flagKey != "":
		r.APIKey, r.APIKeySource = flagKey, SourceFlag
	case os.Getenv(EnvAPIKey) != "":
		r.APIKey, r.APIKeySource = os.Getenv(EnvAPIKey), SourceEnv
	case file.APIKey != "":
		r.APIKey, r.APIKeySource = file.APIKey, SourceFile
	}
	switch {
	case flagBaseURL != "":
		r.BaseURL, r.BaseURLSource = flagBaseURL, SourceFlag
	case os.Getenv(EnvBaseURL) != "":
		r.BaseURL, r.BaseURLSource = os.Getenv(EnvBaseURL), SourceEnv
	case file.BaseURL != "":
		r.BaseURL, r.BaseURLSource = file.BaseURL, SourceFile
	default:
		r.BaseURL, r.BaseURLSource = defaultBaseURL, SourceDefault
	}
	return r, nil
}

// MaskKey shows enough of a key to recognise it and none of the secret.
func MaskKey(key string) string {
	if len(key) <= 20 {
		return "****"
	}
	return key[:20] + "…"
}
