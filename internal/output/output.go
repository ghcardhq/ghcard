// Package output prints results for people and for programs.
//
// Human mode writes readable text. JSON mode (--json, or automatically when
// stdout is not a terminal) writes exactly one JSON document to stdout:
//
//	{"ok": true,  "data": ...}
//	{"ok": false, "error": {"code": "...", "message": "...", "retryable": bool}}
//
// Exit codes are stable so scripts and agents can branch without parsing:
// 0 ok, 1 error, 2 usage, 3 auth, 4 not found, 5 quota/rate limited,
// 6 temporarily unavailable (retry later).
package output

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/Cactusinhand/ghcard/internal/api"
)

const (
	ExitOK          = 0
	ExitError       = 1
	ExitUsage       = 2
	ExitAuth        = 3
	ExitNotFound    = 4
	ExitRateLimited = 5
	ExitUnavailable = 6
)

// Printer writes results in the selected mode.
type Printer struct {
	JSON bool
	Out  io.Writer
	Err  io.Writer
}

// IsTerminal reports whether f is an interactive terminal.
func IsTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// Success prints data. In human mode, render prints it; render may be nil to
// fall back to indented JSON.
func (p *Printer) Success(data any, render func(w io.Writer)) {
	if p.JSON || render == nil {
		p.writeJSON(map[string]any{"ok": true, "data": data})
		return
	}
	render(p.Out)
}

// Info writes a human-only note to stderr; JSON mode stays silent so stdout
// remains one parseable document.
func (p *Printer) Info(format string, args ...any) {
	if p.JSON {
		return
	}
	fmt.Fprintf(p.Err, format+"\n", args...)
}

// UsageError marks a mistake in how the command was invoked.
type UsageError struct{ Msg string }

func (e *UsageError) Error() string { return e.Msg }

// Failure prints err and returns the exit code for it.
func (p *Printer) Failure(err error) int {
	code, message, retryable, hint, details, exit := classify(err)
	if p.JSON {
		body := map[string]any{"code": code, "message": message, "retryable": retryable}
		if hint != "" {
			body["hint"] = hint
		}
		if len(details) > 0 {
			body["details"] = details
		}
		p.writeJSON(map[string]any{"ok": false, "error": body})
		return exit
	}
	fmt.Fprintf(p.Err, "Error: %s\n", message)
	if hint != "" {
		fmt.Fprintf(p.Err, "Hint: %s\n", hint)
	}
	return exit
}

func classify(err error) (code, message string, retryable bool, hint string, details map[string]any, exit int) {
	var usage *UsageError
	if errors.As(err, &usage) {
		return "USAGE", usage.Msg, false, "Run the command with --help for usage.", nil, ExitUsage
	}
	if errors.Is(err, api.ErrNoAPIKey) {
		return "NO_API_KEY", "no API key configured", false,
			"Create a key at https://githubcard.com/dashboard, then run `ghcard auth login` or set GHCARD_API_KEY.",
			nil, ExitAuth
	}
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return "ERROR", err.Error(), false, "", nil, ExitError
	}

	details = apiErr.Details
	if apiErr.RetryAfter > 0 {
		if details == nil {
			details = map[string]any{}
		}
		details["retryAfterSeconds"] = int(apiErr.RetryAfter / time.Second)
	}
	code, message, retryable = apiErr.Code, apiErr.Message, apiErr.Retryable
	switch {
	case apiErr.Status == 401 || code == "UNAUTHORIZED":
		hint = "The API key is missing, wrong, or revoked. Create a new one at https://githubcard.com/dashboard."
		exit = ExitAuth
	case apiErr.Status == 404:
		exit = ExitNotFound
	case apiErr.Status == 429:
		hint = "Daily card quota reached. It resets at 00:00 UTC; Pro raises the limit."
		if apiErr.RetryAfter > 0 {
			hint = fmt.Sprintf("Daily card quota reached. Retry in %s, or upgrade to Pro.", apiErr.RetryAfter.Round(time.Minute))
		}
		exit, retryable = ExitRateLimited, true
	case code == "PRO_TEMPLATE":
		hint = "Pick a free template with `ghcard templates`, or upgrade to Pro."
		exit = ExitError
	case code == "UNKNOWN_TEMPLATE" || code == "TEMPLATE_SCOPE_MISMATCH":
		hint = "List valid templates with `ghcard templates --scope profile|repo`."
		exit = ExitUsage
	case code == "UNKNOWN_PALETTE":
		hint = "List valid palettes with `ghcard palettes`."
		exit = ExitUsage
	case code == "INVALID_REQUEST":
		exit = ExitUsage
	case code == "PRO_FEATURE":
		hint = "The design uses a Pro font or background (details.features gives each path). Swap them for free ones, or upgrade to Pro."
		exit = ExitError
	case code == "INVALID_DESIGN":
		hint = "Fix the design as the message says; `ghcard design init <template>` gives a valid starting point."
		exit = ExitUsage
	case code == "CARD_GENERATION_IN_PROGRESS" || code == "NETWORK_ERROR":
		// A first render can outlast the client; repeating resumes it.
		hint = "The card may still be rendering. Wait ~30s and repeat the identical command; it resumes the same card. Give up after 5 attempts."
		exit, retryable = ExitUnavailable, true
	case code == "CARD_GENERATION_FAILED":
		hint = "Rendering failed on the server. Repeat the identical command at most twice; if it still fails, report a server-side rendering problem."
		exit, retryable = ExitUnavailable, true
	case retryable || apiErr.Status >= 500:
		retryable = true
		if apiErr.RetryAfter > 0 {
			hint = fmt.Sprintf("Temporary problem; retry in %s.", apiErr.RetryAfter.Round(time.Second))
		} else {
			hint = "Temporary problem. Wait ~30s and repeat the identical command; give up after 5 attempts."
		}
		exit = ExitUnavailable
	default:
		exit = ExitError
	}
	return
}

func (p *Printer) writeJSON(v any) {
	enc := json.NewEncoder(p.Out)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// Table writes aligned columns.
func Table(w io.Writer, header []string, rows [][]string) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(header, "\t"))
	for _, row := range rows {
		fmt.Fprintln(tw, strings.Join(row, "\t"))
	}
	_ = tw.Flush()
}
