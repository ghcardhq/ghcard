package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Cactusinhand/GithubCard-web/cli/internal/output"
)

// fakeAPI serves just enough of /api/v1 for command tests.
func fakeAPI(t *testing.T, cardStatus int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var posts atomic.Int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/cards":
			posts.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if cardStatus != http.StatusCreated {
				w.WriteHeader(cardStatus)
				_, _ = w.Write([]byte(`{"success":false,"code":"PRO_TEMPLATE","message":"Template \"pro-x\" requires GitHubCard Pro.","retryable":false}`))
				return
			}
			subject := body["username"].(string)
			if repo, ok := body["repo"].(string); ok {
				subject += "/" + repo
			}
			svg := srv.URL + "/g/pub.svg"
			resp := map[string]any{"success": true, "data": map[string]any{
				"id": "card000000000001", "created": true, "subject": subject, "template": "social",
				"watermark": true, "url": svg,
				"urls":  map[string]string{"svg": svg, "png": srv.URL + "/g/pub.png"},
				"embed": map[string]string{"markdown": "[![GitHubCard for " + subject + "](" + svg + ")](https://github.com/" + subject + ")", "html": "<a></a>"},
				"usage": map[string]any{"used": 1, "limit": 100, "remaining": 99},
			}}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(resp)
		case r.URL.Path == "/g/pub.svg":
			_, _ = w.Write([]byte("<svg/>"))
		case r.URL.Path == "/api/v1/usage":
			_, _ = w.Write([]byte(`{"success":true,"data":{"username":"octocat","tier":"free","tierExpiresAt":"2026-11-28T00:00:00Z","cards":{"used":1,"limit":100,"remaining":99},"ai":{"used":0,"limit":10,"remaining":10}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &posts
}

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	t.Setenv("GHCARD_CONFIG", filepath.Join(t.TempDir(), "config.json"))
	var stdout, stderr bytes.Buffer
	code := Execute(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestCardPrintsJSONWhenNotATerminal(t *testing.T) {
	srv, _ := fakeAPI(t, http.StatusCreated)
	t.Setenv("GHCARD_API_KEY", "ghc_live_1_"+strings.Repeat("a", 32))

	code, stdout, _ := run(t, "card", "octocat/hello-world", "--base-url", srv.URL)
	if code != output.ExitOK {
		t.Fatalf("exit = %d, stdout = %s", code, stdout)
	}
	var doc struct {
		OK   bool `json:"ok"`
		Data struct {
			Subject string `json:"subject"`
			Created bool   `json:"created"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("stdout is not one JSON document: %v\n%s", err, stdout)
	}
	if !doc.OK || doc.Data.Subject != "octocat/hello-world" || !doc.Data.Created {
		t.Fatalf("doc = %+v", doc)
	}
}

func TestCardDownloadsAndUpdatesReadme(t *testing.T) {
	srv, _ := fakeAPI(t, http.StatusCreated)
	t.Setenv("GHCARD_API_KEY", "ghc_live_1_"+strings.Repeat("a", 32))
	dir := t.TempDir()
	img := filepath.Join(dir, "card.svg")
	md := filepath.Join(dir, "README.md")
	if err := os.WriteFile(md, []byte("# Me\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, stdout, _ := run(t, "card", "octocat", "--base-url", srv.URL, "--output", img, "--readme", md)
	if code != 0 {
		t.Fatalf("exit = %d: %s", code, stdout)
	}
	if got, _ := os.ReadFile(img); string(got) != "<svg/>" {
		t.Fatalf("image = %q", got)
	}
	readme, _ := os.ReadFile(md)
	if !strings.Contains(string(readme), "<!-- ghcard:octocat -->") {
		t.Fatalf("README = %s", readme)
	}
	if !strings.Contains(stdout, `"readmeEdit": "inserted"`) {
		t.Fatalf("stdout = %s", stdout)
	}
}

func TestExitCodes(t *testing.T) {
	srv, posts := fakeAPI(t, http.StatusForbidden)

	t.Setenv("GHCARD_API_KEY", "")
	if code, _, _ := run(t, "usage", "--base-url", srv.URL); code != output.ExitAuth {
		t.Fatalf("missing key exit = %d, want %d", code, output.ExitAuth)
	}

	t.Setenv("GHCARD_API_KEY", "ghc_live_1_"+strings.Repeat("a", 32))
	if code, _, _ := run(t, "card", "a/b/c", "--base-url", srv.URL); code != output.ExitUsage {
		t.Fatalf("bad subject exit = %d, want %d", code, output.ExitUsage)
	}
	if code, _, _ := run(t, "card", "octocat", "--format", "gif", "--base-url", srv.URL); code != output.ExitUsage {
		t.Fatalf("bad format exit = %d", code)
	}
	if posts.Load() != 0 {
		t.Fatal("usage errors must not reach the API")
	}

	code, stdout, _ := run(t, "card", "octocat", "--template", "pro-x", "--base-url", srv.URL)
	if code != output.ExitError || !strings.Contains(stdout, `"code": "PRO_TEMPLATE"`) || !strings.Contains(stdout, "ghcard templates") {
		t.Fatalf("pro template exit = %d, stdout = %s", code, stdout)
	}

	if code, _, _ := run(t, "nope"); code != output.ExitUsage {
		t.Fatalf("unknown command exit = %d", code)
	}
}

func TestDeleteWithoutTerminalNeedsYes(t *testing.T) {
	t.Setenv("GHCARD_API_KEY", "ghc_live_1_"+strings.Repeat("a", 32))
	code, stdout, _ := run(t, "cards", "delete", "card000000000001", "--base-url", "http://127.0.0.1:1")
	if code != output.ExitUsage || !strings.Contains(stdout, "--yes") {
		t.Fatalf("exit = %d, stdout = %s", code, stdout)
	}
}

func TestAuthLoginVerifiesAndSavesPrivately(t *testing.T) {
	srv, _ := fakeAPI(t, http.StatusCreated)
	cfg := filepath.Join(t.TempDir(), "ghcard", "config.json")
	t.Setenv("GHCARD_CONFIG", cfg)
	t.Setenv("GHCARD_API_KEY", "")

	root := []string{"auth", "login", "--with-token", "--base-url", srv.URL}
	var stdout, stderr bytes.Buffer
	a := &app{}
	cmd := newRoot(a)
	cmd.SetArgs(root)
	cmd.SetIn(strings.NewReader("ghc_live_1_" + strings.Repeat("a", 32) + "\n"))
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	a.printer = &output.Printer{JSON: true, Out: &stdout, Err: &stderr}
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v", info.Mode().Perm())
	}
	raw, _ := io.ReadAll(bytes.NewReader(stdout.Bytes()))
	if !strings.Contains(string(raw), `"username": "octocat"`) {
		t.Fatalf("stdout = %s", raw)
	}
}

func TestParseSubject(t *testing.T) {
	cases := map[string][2]string{
		"octocat":                                {"octocat", ""},
		"octocat/hello-world":                    {"octocat", "hello-world"},
		"https://github.com/octocat/hello-world": {"octocat", "hello-world"},
		"github.com/octocat/":                    {"octocat", ""},
	}
	for in, want := range cases {
		u, r, err := parseSubject(in)
		if err != nil || u != want[0] || r != want[1] {
			t.Errorf("parseSubject(%q) = %q, %q, %v", in, u, r, err)
		}
	}
	if _, _, err := parseSubject("a/b/c"); err == nil {
		t.Error("expected error for a/b/c")
	}
}
