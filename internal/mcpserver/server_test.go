package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ghcardhq/ghcard/internal/api"
)

func connect(t *testing.T, handler http.HandlerFunc, allowWrites bool, key string) *mcp.ClientSession {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	server := New(Options{Client: api.New(srv.URL, key, "test"), Version: "test", AllowFileWrites: allowWrites})

	ctx := context.Background()
	st, ct := mcp.NewInMemoryTransports()
	if _, err := server.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	session, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func toolNames(t *testing.T, s *mcp.ClientSession) []string {
	t.Helper()
	var names []string
	for tool, err := range s.Tools(context.Background(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tool.Name)
	}
	return names
}

func textOf(res *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func TestToolsAreListedAndFileWritesAreOptIn(t *testing.T) {
	noop := func(http.ResponseWriter, *http.Request) {}
	names := strings.Join(toolNames(t, connect(t, noop, false, "k")), ",")
	for _, want := range []string{"create_card", "list_templates", "list_palettes", "list_cards", "delete_card", "get_usage", "list_components", "get_template_design", "get_card_design", "validate_card"} {
		if !strings.Contains(names, want) {
			t.Errorf("missing tool %s in %s", want, names)
		}
	}
	if strings.Contains(names, "update_readme") {
		t.Error("update_readme must be off by default")
	}
	if !strings.Contains(strings.Join(toolNames(t, connect(t, noop, true, "k")), ","), "update_readme") {
		t.Error("update_readme should appear with AllowFileWrites")
	}
}

func TestCreateCardReturnsStructuredCard(t *testing.T) {
	var body map[string]any
	session := connect(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":"c1","created":true,"subject":"octocat/hello-world","url":"https://x/g/p.svg","urls":{"svg":"https://x/g/p.svg","png":"https://x/g/p.png"},"embed":{"markdown":"md","html":"h"},"usage":{"used":1,"limit":100,"remaining":99}}}`))
	}, false, "k")

	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "create_card",
		Arguments: map[string]any{"subject": "https://github.com/octocat/hello-world", "template": "repo-og-compact"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		t.Fatalf("tool error: %s", textOf(res))
	}
	if body["type"] != "repo" || body["username"] != "octocat" || body["repo"] != "hello-world" {
		t.Fatalf("request body = %v", body)
	}
	raw, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(raw), `"markdown":"md"`) || !strings.Contains(string(raw), `"id":"c1"`) {
		t.Fatalf("structured = %s", raw)
	}
}

func TestToolErrorsCarryCodeAndHint(t *testing.T) {
	session := connect(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"success":false,"code":"UNKNOWN_TEMPLATE","message":"Unknown template \"x\".","retryable":false}`))
	}, false, "k")

	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "create_card",
		Arguments: map[string]any{"subject": "octocat", "template": "x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := textOf(res)
	if !res.IsError || !strings.Contains(text, `"code":"UNKNOWN_TEMPLATE"`) || !strings.Contains(text, "list_templates") {
		t.Fatalf("IsError = %v, text = %s", res.IsError, text)
	}
}

func TestMissingKeyExplainsHowToFixIt(t *testing.T) {
	session := connect(t, func(http.ResponseWriter, *http.Request) {
		t.Fatal("no request should be sent without a key")
	}, false, "")
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_usage", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if text := textOf(res); !res.IsError || !strings.Contains(text, "NO_API_KEY") || !strings.Contains(text, "GHCARD_API_KEY") {
		t.Fatalf("text = %s", text)
	}
}

func TestUpdateReadmeEditsOnlyMarkdown(t *testing.T) {
	session := connect(t, func(http.ResponseWriter, *http.Request) {}, true, "k")
	dir := t.TempDir()
	md := filepath.Join(dir, "README.md")

	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "update_readme",
		Arguments: map[string]any{"path": md, "subject": "octocat", "snippet": "[![c](u)](l)"},
	})
	if err != nil || res.IsError {
		t.Fatalf("err = %v, text = %s", err, textOf(res))
	}
	if got, _ := os.ReadFile(md); !strings.Contains(string(got), "<!-- ghcard:octocat -->") {
		t.Fatalf("README = %s", got)
	}

	res, _ = session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "update_readme",
		Arguments: map[string]any{"path": filepath.Join(dir, "notes.txt"), "subject": "octocat", "snippet": "x"},
	})
	if !res.IsError {
		t.Fatal("non-Markdown files must be refused")
	}
}

func TestDesignRoundTrip(t *testing.T) {
	var posted map[string]any
	var templatePath, templateQuery string
	session := connect(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/templates/"):
			templatePath, templateQuery = r.URL.Path, r.URL.RawQuery
			_, _ = w.Write([]byte(`{"success":true,"data":{"version":1,"artboard":{"width":1200,"height":630},"layers":[{"id":"a","type":"avatar"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/cards":
			_ = json.NewDecoder(r.Body).Decode(&posted)
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"success":false,"code":"PRO_FEATURE","message":"The font \"Kalam\" requires Pro.","retryable":false,"features":[{"feature":"font","name":"Kalam"}]}`))
		default:
			http.NotFound(w, r)
		}
	}, false, "k")
	ctx := context.Background()

	res, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "get_template_design",
		Arguments: map[string]any{"template": "repo-og-compact", "subject": "octocat/hello-world"},
	})
	if err != nil || res.IsError {
		t.Fatalf("get_template_design: %v %s", err, textOf(res))
	}
	if templatePath != "/api/v1/templates/repo-og-compact/design" || !strings.Contains(templateQuery, "repo=hello-world") {
		t.Fatalf("request = %s?%s", templatePath, templateQuery)
	}
	var out DesignOutput
	raw, _ := json.Marshal(res.StructuredContent)
	_ = json.Unmarshal(raw, &out)
	if out.Design["artboard"] == nil {
		t.Fatalf("design = %s", raw)
	}

	res, err = session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "create_card",
		Arguments: map[string]any{"subject": "octocat/hello-world", "design": out.Design},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError || !strings.Contains(textOf(res), "PRO_FEATURE") || !strings.Contains(textOf(res), "free ones") {
		t.Fatalf("want PRO_FEATURE with hint, got %s", textOf(res))
	}
	if d, ok := posted["design"].(map[string]any); !ok || d["layers"] == nil {
		t.Fatalf("posted = %v", posted)
	}
	if _, ok := posted["template"]; ok {
		t.Fatalf("template must not be sent with design: %v", posted)
	}
}

func TestValidateCardIsADryRun(t *testing.T) {
	var path string
	var body map[string]any
	session := connect(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"success":true,"data":{"valid":true,"template":"custom","palette":null,"watermark":true,"artboard":{"width":1200,"height":400},"layers":3}}`))
	}, false, "k")
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "validate_card",
		Arguments: map[string]any{"subject": "octocat/hello-world", "design": map[string]any{"artboard": map[string]any{"width": 1200, "height": 400}, "layers": []any{}}},
	})
	if err != nil || res.IsError {
		t.Fatalf("validate_card: %v %s", err, textOf(res))
	}
	if path != "/api/v1/cards/validate" || body["repo"] != "hello-world" || body["design"] == nil {
		t.Fatalf("request = %s %v", path, body)
	}
	raw, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(raw), `"valid":true`) {
		t.Fatalf("structured = %s", raw)
	}
}
