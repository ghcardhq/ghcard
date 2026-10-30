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
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/Cactusinhand/ghcard/internal/api"
	"github.com/Cactusinhand/ghcard/internal/readme"
	"github.com/Cactusinhand/ghcard/internal/subject"
)

const instructions = `GitHubCard turns a GitHub user or repository into an embeddable card image.

Typical flow:
1. Optionally call list_templates (scope "profile" or "repo") and list_palettes to pick ids.
2. Call create_card with the subject. It returns SVG/PNG links and Markdown/HTML embed snippets.
   It is idempotent: the same parameters return the same card and link.
3. To place it in a README, use update_readme with embed.markdown (or insert it yourself).
   Share urls (live, re-render with current data); snapshotUrls are frozen images.

Custom layouts (any hex background, size, font, or adding/removing/moving widgets):
call get_template_design (free, no quota) or get_card_design to get a design document,
edit it, check it with validate_card (free), then pass it as create_card's "design"
instead of template/palette.
Design document shape:
  artboard: {width, height (px, 100-4000), background: {color: a full CSS background,
             e.g. "#1e3a5f" or "radial-gradient(...) 0 0 / 22px 22px #0d1117"; a plain hex
             replaces any texture, so change only the trailing colour to keep it},
             style: {fontFamily, textColor, secondaryTextColor, accentColor, radius}}
  layers:   [{id (unique), type (from list_components), x, y, width, height (px from the
             artboard's top-left), layer (stacking order), style, ...widget settings}]
Layers are absolutely positioned: removing one leaves its space empty, and anything
outside the artboard is clipped, so move or resize neighbours yourself (validate_card
warns about clipped layers). Keep version and any other fields you do not change;
dataSource, ownerId, meta and showWatermark are replaced by the server.
Widgets scale to their box. Text colours come from artboard.style (textColor,
secondaryTextColor, accentColor) or a layer's style; when you change the background a
lot, set them too so text stays readable.
Plain solid colours are free; gradients and patterns are free only when they are a free
preset, a list_palettes palette, or a free template's own background. On Free, the editor's Pro fonts and background presets fail
with PRO_FEATURE (details.features lists each path); fonts and backgrounds that free
templates already use are fine.
Failed create_card calls are refunded. A first card can take a while to render: on
CARD_GENERATION_IN_PROGRESS or NETWORK_ERROR wait ~30s and repeat the identical call.

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
	case apiErr.Code == "PRO_FEATURE":
		te.Hint = "The design uses a Pro font or background (details.features). Replace them with free ones, or tell the user it needs Pro."
	case apiErr.Code == "INVALID_DESIGN":
		te.Hint = "Fix the design as the message says. Start from get_template_design if unsure of the shape."
	case apiErr.Code == "SUBJECT_NOT_FOUND":
		te.Hint = "Check the username/repository spelling; private repositories are not supported."
	case apiErr.Code == "CARD_GENERATION_IN_PROGRESS" || apiErr.Code == "NETWORK_ERROR":
		te.Hint = "The card may still be rendering (a first card can take minutes). Wait ~30s and repeat the identical call; it resumes the same card. Give up after 5 attempts."
	case apiErr.Code == "CARD_GENERATION_FAILED":
		te.Hint = "Rendering failed on the server, not because of the request. Repeat the identical call at most twice; if it still fails, tell the user the renderer is having problems."
	case te.Retryable:
		te.Hint = "Temporary problem. Wait ~30s and repeat the identical call; give up after 5 attempts."
	}
	return te
}

// --- Tool inputs and outputs ---------------------------------------------

type CreateCardInput struct {
	Subject   string         `json:"subject" jsonschema:"GitHub username (e.g. octocat) or owner/repo (e.g. octocat/hello-world)"`
	Template  string         `json:"template,omitempty" jsonschema:"template id from list_templates; omit for the subject's default layout"`
	Palette   string         `json:"palette,omitempty" jsonschema:"background palette id from list_palettes; omit for the template's own background. For any other colour use design"`
	Format    string         `json:"format,omitempty" jsonschema:"which link to return as url: \"svg\" (default; best for README embeds) or \"png\". Both are always in urls"`
	Watermark *bool          `json:"watermark,omitempty" jsonschema:"false removes the watermark (Pro only; ignored on Free)"`
	Design    map[string]any `json:"design,omitempty" jsonschema:"a design document from get_template_design or get_card_design, possibly edited; replaces template and palette"`
}

type TemplateDesignInput struct {
	Template string `json:"template" jsonschema:"template id from list_templates"`
	Subject  string `json:"subject,omitempty" jsonschema:"username or owner/repo the card is for; decides profile vs repo layouts"`
	Palette  string `json:"palette,omitempty" jsonschema:"palette id to apply; replaces the template's background in the returned design"`
}

type DesignOutput struct {
	Design map[string]any `json:"design"`
}

type ListComponentsOutput struct {
	Components []api.Component `json:"components"`
}

type CreateCardOutput struct {
	*api.CreatedCard
}

type ListTemplatesInput struct {
	Scope    string   `json:"scope,omitempty" jsonschema:"profile or repo; omit for all. Results include scope=all templates, which fit both"`
	FreeOnly bool     `json:"freeOnly,omitempty" jsonschema:"only templates available on the Free plan"`
	Widgets  []string `json:"widgets,omitempty" jsonschema:"only templates containing all of these widget types (from list_components)"`
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
	Path    string `json:"path" jsonschema:"path to the Markdown file; relative paths resolve against the MCP server's working directory, so prefer an absolute path"`
	Subject string `json:"subject" jsonschema:"the card's subject (username or owner/repo); used to find an existing block"`
	Snippet string `json:"snippet" jsonschema:"the embed.markdown value returned by create_card. A new block goes after the file's first heading (or at the top); an existing block for the subject is replaced"`
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
		req, err := cardRequest(in)
		if err != nil {
			return nil, CreateCardOutput{}, err
		}
		card, _, err := c.CreateCard(ctx, req)
		if err != nil {
			return nil, CreateCardOutput{}, toToolError(err)
		}
		return nil, CreateCardOutput{card}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "validate_card",
		Title:       "Check a card request",
		Description: "Dry run of create_card with the same inputs: checks template/palette ids, Pro features and the design document, without creating anything or using quota. warnings lists layers that reach outside the artboard (they would be clipped); fix those before create_card.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in CreateCardInput) (*mcp.CallToolResult, *api.ValidatedCard, error) {
		req, err := cardRequest(in)
		if err != nil {
			return nil, nil, err
		}
		checked, err := c.ValidateCard(ctx, req)
		if err != nil {
			return nil, nil, toToolError(err)
		}
		return nil, checked, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_templates",
		Title:       "List card templates",
		Description: "List card layouts with their ids, scope (profile/repo/all), size, widget types, and whether they need Pro.",
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
		if len(in.Widgets) > 0 {
			kept := templates[:0]
			for _, t := range templates {
				if subject.HasAllWidgets(t.Widgets, in.Widgets) {
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
		Name:        "list_components",
		Title:       "List widget types",
		Description: "List the widget (layer) types a design can contain, with the scope (profile/repo) each fits.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ Empty) (*mcp.CallToolResult, ListComponentsOutput, error) {
		components, err := c.Components(ctx)
		if err != nil {
			return nil, ListComponentsOutput{}, toToolError(err)
		}
		return nil, ListComponentsOutput{Components: components}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_template_design",
		Title:       "Get a template's design",
		Description: "Return a template's layout as an editable design document (artboard + layers). Costs no quota. Edit it and pass it to create_card as design.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in TemplateDesignInput) (*mcp.CallToolResult, DesignOutput, error) {
		if strings.TrimSpace(in.Template) == "" {
			return nil, DesignOutput{}, &toolError{Code: "INVALID_REQUEST", Message: "template is required"}
		}
		var username, repo string
		if in.Subject != "" {
			var err error
			if username, repo, err = splitSubject(in.Subject); err != nil {
				return nil, DesignOutput{}, err
			}
		}
		raw, err := c.TemplateDesign(ctx, in.Template, username, repo, in.Palette)
		if err != nil {
			return nil, DesignOutput{}, toToolError(err)
		}
		return designOutput(raw)
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_card_design",
		Title:       "Get a card's design",
		Description: "Return the design document of one of the account's cards, to edit and re-submit through create_card as design (which creates a new card; the original is unchanged).",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &openWorld},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in DeleteCardInput) (*mcp.CallToolResult, DesignOutput, error) {
		if strings.TrimSpace(in.ID) == "" {
			return nil, DesignOutput{}, &toolError{Code: "INVALID_REQUEST", Message: "id is required"}
		}
		raw, err := c.CardDesign(ctx, in.ID)
		if err != nil {
			return nil, DesignOutput{}, toToolError(err)
		}
		return designOutput(raw)
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
		Description: "Show the account's plan (free/pro) and how many cards it can still create today (cards.remaining, resets 00:00 UTC). The ai quota is reserved for future AI tools.",
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

func designOutput(raw json.RawMessage) (*mcp.CallToolResult, DesignOutput, error) {
	var design map[string]any
	if err := json.Unmarshal(raw, &design); err != nil {
		return nil, DesignOutput{}, &toolError{Code: "BAD_RESPONSE", Message: err.Error()}
	}
	return nil, DesignOutput{Design: design}, nil
}

// cardRequest turns create_card/validate_card input into an API request.
func cardRequest(in CreateCardInput) (api.CardRequest, error) {
	username, repo, err := splitSubject(in.Subject)
	if err != nil {
		return api.CardRequest{}, err
	}
	req := api.CardRequest{Username: username, Template: in.Template, Palette: in.Palette, Format: in.Format, Watermark: in.Watermark}
	if repo != "" {
		req.Type, req.Repo = "repo", repo
	}
	if in.Design != nil {
		if in.Template != "" || in.Palette != "" {
			return api.CardRequest{}, &toolError{Code: "INVALID_REQUEST", Message: "pass either design or template/palette, not both"}
		}
		raw, err := json.Marshal(in.Design)
		if err != nil {
			return api.CardRequest{}, &toolError{Code: "INVALID_REQUEST", Message: err.Error()}
		}
		req.Design = raw
	}
	return req, nil
}

// Run serves over stdio until the client disconnects.
func Run(ctx context.Context, opts Options) error {
	return New(opts).Run(ctx, &mcp.StdioTransport{})
}

func splitSubject(input string) (string, string, error) {
	username, repo, err := subject.Parse(input)
	if err != nil {
		return "", "", &toolError{Code: "INVALID_REQUEST", Message: err.Error()}
	}
	return username, repo, nil
}
