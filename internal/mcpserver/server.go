// Package mcpserver exposes the GitHubCard API as Model Context Protocol
// tools over stdio, so AI agents (Claude Code, Claude Desktop, Cursor, …) can
// generate cards without shelling out.
//
// Every tool calls the same api.Client the CLI uses. Tool failures are
// returned as tool results (IsError) carrying the API's stable error code,
// retryable flag, and a hint, so the model can correct itself.
package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/Cactusinhand/GithubCard-web/cli/internal/api"
	"github.com/Cactusinhand/GithubCard-web/cli/internal/readme"
)

const instructions = `GitHubCard turns a GitHub user or repository into an embeddable card image.

Typical flow:
1. Optionally call list_templates (scope "profile" or "repo") and list_palettes to pick ids.
2. Call create_card with the subject. It returns SVG/PNG links and Markdown/HTML embed snippets.
   It is idempotent: the same parameters return the same card and link.
3. To place it in a README, use update_readme (or insert embed.markdown yourself).

Each create_card call counts against a daily quota (get_usage shows what is left).
Do not call create_card in a loop to "refresh" a card: the link always shows live data.
Free accounts always get a small watermark.`

// Options configures the server.
type Options struct {
	Client  *api.Client
	Version string
	// AllowFileWrites enables update_readme. Off unless the user opted in.
	AllowFileWrites bool
}

// toolError is what a failing tool returns to the model.
type toolError struct {
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	Retryable  bool           `json:"retryable"`
	RetryAfter int            `json:"retryAfterSeconds,omitempty"`
	Hint       string         `json:"hint,omitempty"`
	Details    map[string]any `json:"details,omitempty"`
}

func (e *toolError) Error() string {
	raw, _ := json.Marshal(e)
	return string(raw)
}

func toToolError(err error) error {
	if errors.Is(err, api.ErrNoAPIKey) {
		return &toolError{
			Code:    "NO_API_KEY",
			Message: "The GitHubCard MCP server has no API key.",
			Hint:    "Ask the user to create a key at https://githubcard.com/dashboard and set GHCARD_API_KEY in the MCP server config (or run `ghcard auth login`).",
		}
	}
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return &toolError{Code: "ERROR", Message: err.Error()}
	}
	te := &toolError{
		Code:      apiErr.Code,
		Message:   apiErr.Message,
		Retryable: apiErr.Retryable,
		Details:   apiErr.Details,
	}
	if apiErr.RetryAfter > 0 {
		te.RetryAfter = int(apiErr.RetryAfter / time.Second)
	}
	switch {
	case apiErr.Status == 401:
		te.Hint = "The API key is invalid or revoked. Ask the user for a new key from https://githubcard.com/dashboard."
	case apiErr.Status == 429:
		te.Hint = "The daily card quota is used up. Tell the user; do not retry until resetAt."
		te.Retryable = false
	case apiErr.Code == "UNKNOWN_TEMPLATE" || apiErr.Code == "TEMPLATE_SCOPE_MISMATCH":
		te.Hint = "Call list_templates with the card's scope and use one of its ids."
	case apiErr.Code == "UNKNOWN_PALETTE":
		te.Hint = "Call list_palettes and use one of its ids, or omit palette."
	case apiErr.Code == "PRO_TEMPLATE":
		te.Hint = "That template needs Pro. Pick one with pro=false, or tell the user."
	case apiErr.Code == "SUBJECT_NOT_FOUND":
		te.Hint = "Check the username/repository spelling; private repositories are not supported."
	case te.Retryable:
		te.Hint = "Temporary problem. Retrying once after a short wait is safe."
	}
	return te
}

// --- Tool inputs and outputs ---------------------------------------------

type CreateCardInput struct {
	Subject   string `json:"subject" jsonschema:"GitHub username (e.g. octocat) or owner/repo (e.g. octocat/hello-world)"`
	Template  string `json:"template,omitempty" jsonschema:"template id from list_templates; omit for the subject's default layout"`
	Palette   string `json:"palette,omitempty" jsonschema:"background palette id from list_palettes; omit for the template's own background"`
	Format    string `json:"format,omitempty" jsonschema:"svg (default) or png: which link to return as url"`
	Watermark *bool  `json:"watermark,omitempty" jsonschema:"false removes the watermark (Pro only; ignored on Free)"`
}

type CreateCardOutput struct {
	*api.CreatedCard
}

type ListTemplatesInput struct {
	Scope    string `json:"scope,omitempty" jsonschema:"profile or repo; omit for all"`
	FreeOnly bool   `json:"freeOnly,omitempty" jsonschema:"only templates available on the Free plan"`
}

type ListTemplatesOutput struct {
	Templates []api.Template `json:"templates"`
}

type ListPalettesOutput struct {
	Palettes []api.Palette `json:"palettes"`
}

type ListCardsInput struct {
	Limit  int    `json:"limit,omitempty" jsonschema:"page size 1-100 (default 20)"`
	Cursor string `json:"cursor,omitempty" jsonschema:"nextCursor from a previous call"`
}

type ListCardsOutput struct {
	*api.CardPage
}

type DeleteCardInput struct {
	ID string `json:"id" jsonschema:"card id from create_card or list_cards"`
}

type DeleteCardOutput struct {
	Deleted string `json:"deleted"`
}

type Empty struct{}

type UsageOutput struct {
	*api.Account
}

type UpdateReadmeInput struct {
	Path    string `json:"path" jsonschema:"path to the Markdown file, e.g. README.md"`
	Subject string `json:"subject" jsonschema:"the card's subject (username or owner/repo); used to find an existing block"`
	Snippet string `json:"snippet" jsonschema:"the embed.markdown value returned by create_card"`
}

type UpdateReadmeOutput struct {
	Path string `json:"path"`
	Edit string `json:"edit" jsonschema:"created, inserted, updated, or unchanged"`
}

// New builds the server with its tools registered.
func New(opts Options) *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "githubcard", Title: "GitHubCard", Version: opts.Version},
		&mcp.ServerOptions{Instructions: instructions},
	)
	c := opts.Client
	notDestructive := false
	openWorld := true

	mcp.AddTool(server, &mcp.Tool{
		Name:        "create_card",
		Title:       "Create GitHub card",
		Description: "Create (or reuse) a published card image for a GitHub profile or repository. Returns svg/png URLs and markdown/html embed snippets. Idempotent; counts once against the daily quota.",
		Annotations: &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: &notDestructive, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in CreateCardInput) (*mcp.CallToolResult, CreateCardOutput, error) {
		username, repo, err := splitSubject(in.Subject)
		if err != nil {
			return nil, CreateCardOutput{}, err
		}
		req := api.CardRequest{Username: username, Template: in.Template, Palette: in.Palette, Format: in.Format, Watermark: in.Watermark}
		if repo != "" {
			req.Type, req.Repo = "repo", repo
		}
		card, _, err := c.CreateCard(ctx, req)
		if err != nil {
			return nil, CreateCardOutput{}, toToolError(err)
		}
		return nil, CreateCardOutput{card}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_templates",
		Title:       "List card templates",
		Description: "List card layouts with their ids, scope (profile/repo/all), size, and whether they need Pro.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in ListTemplatesInput) (*mcp.CallToolResult, ListTemplatesOutput, error) {
		if in.Scope != "" && in.Scope != "profile" && in.Scope != "repo" {
			return nil, ListTemplatesOutput{}, &toolError{Code: "INVALID_REQUEST", Message: `scope must be "profile" or "repo"`}
		}
		templates, err := c.Templates(ctx, in.Scope)
		if err != nil {
			return nil, ListTemplatesOutput{}, toToolError(err)
		}
		if in.FreeOnly {
			kept := templates[:0]
			for _, t := range templates {
				if !t.Pro {
					kept = append(kept, t)
				}
			}
			templates = kept
		}
		return nil, ListTemplatesOutput{Templates: templates}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_palettes",
		Title:       "List background palettes",
		Description: "List background palette ids accepted by create_card.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ Empty) (*mcp.CallToolResult, ListPalettesOutput, error) {
		palettes, err := c.Palettes(ctx)
		if err != nil {
			return nil, ListPalettesOutput{}, toToolError(err)
		}
		return nil, ListPalettesOutput{Palettes: palettes.Palettes}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_cards",
		Title:       "List my cards",
		Description: "List cards this account created through the API, most recently requested first. Paginated with nextCursor.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in ListCardsInput) (*mcp.CallToolResult, ListCardsOutput, error) {
		page, err := c.ListCards(ctx, in.Limit, in.Cursor)
		if err != nil {
			return nil, ListCardsOutput{}, toToolError(err)
		}
		return nil, ListCardsOutput{page}, nil
	})

	destructive := true
	mcp.AddTool(server, &mcp.Tool{
		Name:        "delete_card",
		Title:       "Delete a card",
		Description: "Permanently delete one of the account's cards. Its links stop working everywhere they are embedded. Confirm with the user first.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: &destructive, IdempotentHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in DeleteCardInput) (*mcp.CallToolResult, DeleteCardOutput, error) {
		if strings.TrimSpace(in.ID) == "" {
			return nil, DeleteCardOutput{}, &toolError{Code: "INVALID_REQUEST", Message: "id is required"}
		}
		if err := c.DeleteCard(ctx, in.ID); err != nil {
			return nil, DeleteCardOutput{}, toToolError(err)
		}
		return nil, DeleteCardOutput{Deleted: in.ID}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_usage",
		Title:       "Get plan and quota",
		Description: "Show the account's plan (free/pro) and how many cards it can still create today.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ Empty) (*mcp.CallToolResult, UsageOutput, error) {
		account, err := c.Usage(ctx)
		if err != nil {
			return nil, UsageOutput{}, toToolError(err)
		}
		return nil, UsageOutput{account}, nil
	})

	if opts.AllowFileWrites {
		mcp.AddTool(server, &mcp.Tool{
			Name:        "update_readme",
			Title:       "Insert card into README",
			Description: "Insert or replace a card snippet in a local Markdown file between <!-- ghcard:… --> markers. Re-running replaces the block instead of duplicating it.",
			Annotations: &mcp.ToolAnnotations{DestructiveHint: &notDestructive, IdempotentHint: true},
		}, func(_ context.Context, _ *mcp.CallToolRequest, in UpdateReadmeInput) (*mcp.CallToolResult, UpdateReadmeOutput, error) {
			if in.Path == "" || in.Snippet == "" || in.Subject == "" {
				return nil, UpdateReadmeOutput{}, &toolError{Code: "INVALID_REQUEST", Message: "path, subject, and snippet are required"}
			}
			if !strings.HasSuffix(strings.ToLower(in.Path), ".md") {
				return nil, UpdateReadmeOutput{}, &toolError{Code: "INVALID_REQUEST", Message: "only Markdown (.md) files can be edited"}
			}
			edit, err := readme.Upsert(in.Path, readme.MarkerID(in.Subject), in.Snippet)
			if err != nil {
				return nil, UpdateReadmeOutput{}, &toolError{Code: "FILE_ERROR", Message: err.Error()}
			}
			return nil, UpdateReadmeOutput{Path: in.Path, Edit: string(edit)}, nil
		})
	}

	return server
}

// Run serves over stdio until the client disconnects.
func Run(ctx context.Context, opts Options) error {
	return New(opts).Run(ctx, &mcp.StdioTransport{})
}

func splitSubject(subject string) (string, string, error) {
	s := strings.TrimSpace(subject)
	s = strings.TrimPrefix(strings.TrimPrefix(s, "https://"), "github.com/")
	s = strings.TrimSuffix(s, "/")
	parts := strings.Split(s, "/")
	switch {
	case len(parts) == 1 && parts[0] != "":
		return parts[0], "", nil
	case len(parts) == 2 && parts[0] != "" && parts[1] != "":
		return parts[0], parts[1], nil
	}
	return "", "", &toolError{
		Code:    "INVALID_REQUEST",
		Message: fmt.Sprintf("%q is not a GitHub username or owner/repo", subject),
	}
}
