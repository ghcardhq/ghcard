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

// lastBody is the most recent POST /cards body fakeAPI received.
var lastBody map[string]any

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
			lastBody = body
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
			url := svg
			if body["format"] == "png" {
				url = srv.URL + "/g/pub.png"
			}
			resp := map[string]any{"success": true, "data": map[string]any{
				"id": "card000000000001", "created": true, "subject": subject, "template": "social",
				"watermark": true, "url": url,
				"urls":  map[string]string{"svg": svg, "png": srv.URL + "/g/pub.png"},
				"embed": map[string]string{"markdown": "[![GitHubCard for " + subject + "](" + svg + ")](https://github.com/" + subject + ")", "html": "<a></a>"},
				"usage": map[string]any{"used": 1, "limit": 100, "remaining": 99},
			}}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(resp)
		case r.URL.Path == "/api/v1/templates":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"a","scope":"profile","widgets":["avatar","streak"]},{"id":"b","scope":"profile","widgets":["avatar"]}]}`))
		case r.URL.Path == "/api/v1/templates/social/design":
			_, _ = w.Write([]byte(`{"success":true,"data":{"version":1,"artboard":{"width":1200,"height":630},"layers":[]}}`))
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

func TestDesignInitThenCardWithDesign(t *testing.T) {
	srv, _ := fakeAPI(t, http.StatusCreated)
	t.Setenv("GHCARD_BASE_URL", srv.URL)
	t.Setenv("GHCARD_API_KEY", "{{SECRET_bt1vb4tt}}"+strings.Repeat("a", 32))
	path := filepath.Join(t.TempDir(), "design.json")

	// Piped without --json: the bare document, so `> design.json` works.
	code, stdout, stderr := run(t, "design", "init", "social")
	if code != 0 || !strings.HasPrefix(stdout, "{\n") || strings.Contains(stdout, `"ok"`) {
		t.Fatalf("init stdout: code=%d out=%q err=%q", code, stdout, stderr)
	}
	if code, _, stderr = run(t, "design", "init", "social", "-o", path); code != 0 {
		t.Fatalf("init -o: %d %s", code, stderr)
	}

	code, stdout, stderr = run(t, "card", "octocat", "--design", path)
	if code != 0 {
		t.Fatalf("card --design: %d %s %s", code, stdout, stderr)
	}
	design, ok := lastBody["design"].(map[string]any)
	if !ok || design["artboard"] == nil {
		t.Fatalf("posted design = %v", lastBody)
	}

	if code, _, _ = run(t, "card", "octocat", "--design", path, "--template", "social"); code != output.ExitUsage {
		t.Fatalf("--design with --template should be a usage error, got %d", code)
	}
	bad := filepath.Join(t.TempDir(), "bad.json")
	_ = os.WriteFile(bad, []byte("[1]"), 0o644)
	if code, _, _ = run(t, "card", "octocat", "--design", bad); code != output.ExitUsage {
		t.Fatalf("non-object design should be a usage error, got %d", code)
	}
}

func TestTemplatesFilterByWidget(t *testing.T) {
	srv, _ := fakeAPI(t, http.StatusCreated)
	t.Setenv("GHCARD_BASE_URL", srv.URL)
	code, stdout, stderr := run(t, "templates", "--widget", "Streak")
	if code != 0 {
		t.Fatalf("%d %s", code, stderr)
	}
	var out struct {
		Data []struct{ ID string } `json:"data"`
	}
	_ = json.Unmarshal([]byte(stdout), &out)
	if len(out.Data) != 1 || out.Data[0].ID != "a" {
		t.Fatalf("filtered = %s", stdout)
	}
}

func TestFailedDownloadStillReturnsCardAndUpdatesReadme(t *testing.T) {
	srv, _ := fakeAPI(t, http.StatusCreated)
	t.Setenv("GHCARD_BASE_URL", srv.URL)
	t.Setenv("GHCARD_API_KEY", "{{SECRET_bt1vb4tt}}"+strings.Repeat("a", 32))
	dir := t.TempDir()
	readmePath := filepath.Join(dir, "README.md")
	_ = os.WriteFile(readmePath, []byte("# Hi\n"), 0o644)

	// --format png points the download at /g/pub.png, which fakeAPI 404s.
	code, stdout, stderr := run(t, "card", "octocat", "--format", "png", "--output", filepath.Join(dir, "c.png"), "--readme", readmePath)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, `"warnings"`) || !strings.Contains(stdout, "download failed") {
		t.Fatalf("expected a download warning: %s", stdout)
	}
	body, _ := os.ReadFile(readmePath)
	if !strings.Contains(string(body), "ghcard:octocat") {
		t.Fatalf("README not updated: %s", body)
	}
}
