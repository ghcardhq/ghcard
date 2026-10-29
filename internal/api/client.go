// Package api is a typed client for the GitHubCard public API (/api/v1).
//
// It is the only place the CLI and the MCP server talk HTTP, so both see the
// same errors, retries, and rate-limit information.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the production API origin.
const DefaultBaseURL = "https://githubcard.com"

// Client calls the public API with one API key.
type Client struct {
	BaseURL    string
	APIKey     string
	UserAgent  string
	HTTPClient *http.Client
}

// New returns a client with sensible timeouts. Card generation renders and
// publishes an image, so its requests get a longer deadline than reads.
func New(baseURL, apiKey, userAgent string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		BaseURL:   strings.TrimRight(baseURL, "/"),
		APIKey:    apiKey,
		UserAgent: userAgent,
		// A first-time card renders and publishes an image, which can take
		// a few minutes on a cold renderer. Retrying after a timeout is safe:
		// the server resumes the same card.
		HTTPClient: &http.Client{Timeout: 5 * time.Minute},
	}
}

// RateLimit is the quota state the server reports on metered responses.
type RateLimit struct {
	Limit     int       `json:"limit"`
	Remaining int       `json:"remaining"`
	Reset     time.Time `json:"reset"`
}

// Error is a failed API call. Code is stable and safe to branch on; Message
// is for people.
type Error struct {
	Status     int            `json:"status"`
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	Retryable  bool           `json:"retryable"`
	RetryAfter time.Duration  `json:"-"`
	Details    map[string]any `json:"details,omitempty"`
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return e.Message
}

// ErrNoAPIKey is returned before any request when a key is required but missing.
var ErrNoAPIKey = errors.New("no API key configured")

type envelope struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, auth bool, out any) (*RateLimit, error) {
	if auth && c.APIKey == "" {
		return nil, ErrNoAPIKey
	}
	target := c.BaseURL + "/api/v1" + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, &Error{
			Code:      "NETWORK_ERROR",
			Message:   fmt.Sprintf("could not reach %s: %v", c.BaseURL, err),
			Retryable: true,
		}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, &Error{Status: resp.StatusCode, Code: "NETWORK_ERROR", Message: err.Error(), Retryable: true}
	}

	limit := parseRateLimit(resp.Header)
	if resp.StatusCode >= 400 {
		return limit, parseError(resp, raw)
	}
	if out == nil {
		return limit, nil
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil || env.Data == nil {
		return limit, &Error{
			Status:  resp.StatusCode,
			Code:    "BAD_RESPONSE",
			Message: "the server returned an unexpected response",
		}
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return limit, &Error{Status: resp.StatusCode, Code: "BAD_RESPONSE", Message: err.Error()}
	}
	return limit, nil
}

func parseRateLimit(h http.Header) *RateLimit {
	limit, err1 := strconv.Atoi(h.Get("X-RateLimit-Limit"))
	remaining, err2 := strconv.Atoi(h.Get("X-RateLimit-Remaining"))
	reset, err3 := strconv.ParseInt(h.Get("X-RateLimit-Reset"), 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	return &RateLimit{Limit: limit, Remaining: remaining, Reset: time.Unix(reset, 0).UTC()}
}

func parseError(resp *http.Response, raw []byte) error {
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	e := &Error{Status: resp.StatusCode, Details: map[string]any{}}
	if s, ok := body["code"].(string); ok {
		e.Code = s
	}
	if s, ok := body["message"].(string); ok {
		e.Message = s
	} else if s, ok := body["error"].(string); ok {
		e.Message = s
	}
	if b, ok := body["retryable"].(bool); ok {
		e.Retryable = b
	}
	for _, key := range []string{"field", "issues", "limit", "resetAt"} {
		if v, ok := body[key]; ok {
			e.Details[key] = v
		}
	}
	if len(e.Details) == 0 {
		e.Details = nil
	}
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
		e.RetryAfter = time.Duration(seconds) * time.Second
	}

	if e.Code == "" {
		switch {
		case resp.StatusCode == http.StatusUnauthorized:
			e.Code = "UNAUTHORIZED"
		case resp.StatusCode == http.StatusForbidden:
			e.Code = "FORBIDDEN"
		case resp.StatusCode == http.StatusNotFound:
			e.Code = "NOT_FOUND"
		case resp.StatusCode == http.StatusTooManyRequests:
			e.Code = "QUOTA_EXCEEDED"
		case resp.StatusCode >= 500:
			e.Code = "SERVICE_UNAVAILABLE"
			e.Retryable = true
		default:
			e.Code = "REQUEST_FAILED"
		}
	}
	if e.Message == "" {
		e.Message = http.StatusText(resp.StatusCode)
	}
	return e
}

// --- Data types -----------------------------------------------------------

// CardRequest is the body of POST /cards. Zero values are omitted, so the
// server applies its defaults.
type CardRequest struct {
	Type      string `json:"type,omitempty"`
	Username  string `json:"username"`
	Repo      string `json:"repo,omitempty"`
	Template  string `json:"template,omitempty"`
	Palette   string `json:"palette,omitempty"`
	Format    string `json:"format,omitempty"`
	Watermark *bool  `json:"watermark,omitempty"`
	// Design is a full design document used instead of Template/Palette.
	Design json.RawMessage `json:"design,omitempty"`
}

type CardURLs struct {
	SVG string `json:"svg"`
	PNG string `json:"png"`
}

type CardEmbed struct {
	Markdown string `json:"markdown"`
	HTML     string `json:"html"`
}

type Usage struct {
	Used      int    `json:"used"`
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
	ResetAt   string `json:"resetAt"`
}

// Card is one generated, published card.
type Card struct {
	ID            string  `json:"id"`
	DesignID      string  `json:"designId"`
	PublicationID string  `json:"publicationId"`
	Type          string  `json:"type"`
	Subject       string  `json:"subject"`
	Template      string  `json:"template"`
	Palette       *string `json:"palette"`
	Watermark     bool    `json:"watermark"`
	// URLs re-render with current GitHub data; SnapshotURLs never change.
	URLs         CardURLs  `json:"urls"`
	SnapshotURLs CardURLs  `json:"snapshotUrls"`
	Embed        CardEmbed `json:"embed"`
	EditURL      string    `json:"editUrl"`
	CreatedAt    string    `json:"createdAt"`
	UpdatedAt    string    `json:"updatedAt"`
}

// CreatedCard is the POST /cards response.
type CreatedCard struct {
	Card
	Created bool   `json:"created"`
	URL     string `json:"url"`
	Usage   Usage  `json:"usage"`
}

type CardPage struct {
	Cards      []Card  `json:"cards"`
	NextCursor *string `json:"nextCursor"`
}

type Size struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type Template struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Category     string   `json:"category"`
	Scope        string   `json:"scope"`
	Size         Size     `json:"size"`
	OGCompatible bool     `json:"ogCompatible"`
	Pro          bool     `json:"pro"`
	Widgets      []string `json:"widgets"`
	Family       string   `json:"family,omitempty"`
}

type Palette struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Background string `json:"background"`
	Pro        bool   `json:"pro"`
}

type ProBackground struct {
	Name  string `json:"name"`
	Group string `json:"group"`
	Pro   bool   `json:"pro"`
}

type Palettes struct {
	Palettes       []Palette       `json:"palettes"`
	ProBackgrounds []ProBackground `json:"proBackgrounds"`
}

type Component struct {
	Type        string `json:"type"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
}

type Account struct {
	Username      string `json:"username"`
	Tier          string `json:"tier"`
	TierExpiresAt string `json:"tierExpiresAt"`
	Cards         Usage  `json:"cards"`
	AI            Usage  `json:"ai"`
}

// --- Endpoints ------------------------------------------------------------

// CreateCard generates (or reuses) a card. Same parameters return the same card.
func (c *Client) CreateCard(ctx context.Context, req CardRequest) (*CreatedCard, *RateLimit, error) {
	var out CreatedCard
	limit, err := c.do(ctx, http.MethodPost, "/cards", nil, req, true, &out)
	if err != nil {
		return nil, limit, err
	}
	return &out, limit, nil
}

// ValidatedCard is what a dry run of CreateCard would produce.
type ValidatedCard struct {
	Valid     bool    `json:"valid"`
	Template  string  `json:"template"`
	Palette   *string `json:"palette"`
	Watermark bool    `json:"watermark"`
	Artboard  Size    `json:"artboard"`
	Layers    int     `json:"layers"`
}

// ValidateCard runs every CreateCard check without rendering, storing, or
// using quota. It does not check that the subject exists.
func (c *Client) ValidateCard(ctx context.Context, req CardRequest) (*ValidatedCard, error) {
	var out ValidatedCard
	if _, err := c.do(ctx, http.MethodPost, "/cards/validate", nil, req, true, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListCards returns one page of the account's cards, newest requested first.
func (c *Client) ListCards(ctx context.Context, limit int, cursor string) (*CardPage, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var out CardPage
	if _, err := c.do(ctx, http.MethodGet, "/cards", q, nil, true, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CardDesign returns a card's design document, ready to edit and send back
// as CardRequest.Design.
func (c *Client) CardDesign(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/cards/"+url.PathEscape(id)+"/design", nil, nil, true, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TemplateDesign returns a template's layout as a design document for the
// given subject (repo empty for a profile). No key needed, no quota used.
func (c *Client) TemplateDesign(ctx context.Context, template, username, repo, palette string) (json.RawMessage, error) {
	q := url.Values{}
	if username != "" {
		q.Set("username", username)
	}
	if repo != "" {
		q.Set("repo", repo)
	}
	if palette != "" {
		q.Set("palette", palette)
	}
	var out json.RawMessage
	if _, err := c.do(ctx, http.MethodGet, "/templates/"+url.PathEscape(template)+"/design", q, nil, false, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteCard deletes a card. Its links stop working.
func (c *Client) DeleteCard(ctx context.Context, id string) error {
	_, err := c.do(ctx, http.MethodDelete, "/cards/"+url.PathEscape(id), nil, nil, true, nil)
	return err
}

// Usage reports the key's tier and current-window usage.
func (c *Client) Usage(ctx context.Context) (*Account, error) {
	var out Account
	if _, err := c.do(ctx, http.MethodGet, "/usage", nil, nil, true, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Templates lists layouts; scope is "", "profile", or "repo". No key needed.
func (c *Client) Templates(ctx context.Context, scope string) ([]Template, error) {
	q := url.Values{}
	if scope != "" {
		q.Set("scope", scope)
	}
	var out []Template
	if _, err := c.do(ctx, http.MethodGet, "/templates", q, nil, false, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Palettes lists background palettes. No key needed.
func (c *Client) Palettes(ctx context.Context) (*Palettes, error) {
	var out Palettes
	if _, err := c.do(ctx, http.MethodGet, "/palettes", nil, nil, false, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Components lists widget types a card can contain. No key needed.
func (c *Client) Components(ctx context.Context) ([]Component, error) {
	var out []Component
	if _, err := c.do(ctx, http.MethodGet, "/components", nil, nil, false, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Download fetches a rendered card image (SVG or PNG) from a card URL.
// Card URLs are public, so no key is sent.
func (c *Client) Download(ctx context.Context, imageURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, "", err
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, "", &Error{Code: "NETWORK_ERROR", Message: err.Error(), Retryable: true}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, "", &Error{
			Status:    resp.StatusCode,
			Code:      "DOWNLOAD_FAILED",
			Message:   fmt.Sprintf("downloading %s returned %d", imageURL, resp.StatusCode),
			Retryable: resp.StatusCode >= 500,
		}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, "", &Error{Code: "NETWORK_ERROR", Message: err.Error(), Retryable: true}
	}
	return body, resp.Header.Get("Content-Type"), nil
}
