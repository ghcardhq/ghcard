// Package cmd defines the ghcard command tree.
package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Cactusinhand/GithubCard-web/cli/internal/api"
	"github.com/Cactusinhand/GithubCard-web/cli/internal/config"
	"github.com/Cactusinhand/GithubCard-web/cli/internal/output"
)

// Version is set at build time with -ldflags "-X .../cmd.Version=v1.2.3".
var Version = "dev"

type app struct {
	flagKey     string
	flagBaseURL string
	jsonOut     bool
	printer     *output.Printer
}

func (a *app) resolve() (config.Resolved, error) {
	return config.Resolve(a.flagKey, a.flagBaseURL, api.DefaultBaseURL)
}

func (a *app) client() (*api.Client, error) {
	r, err := a.resolve()
	if err != nil {
		return nil, err
	}
	return api.New(r.BaseURL, r.APIKey, "ghcard-cli/"+Version), nil
}

// Execute runs the CLI and returns the process exit code.
func Execute(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	a := &app{}
	root := newRoot(a)
	root.SetArgs(args)
	root.SetOut(stdout)
	root.SetErr(stderr)

	// Choose the output mode before any command runs. JSON is the default
	// when stdout is not a terminal, so pipes and agents get parseable output
	// without remembering a flag.
	root.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		a.printer = &output.Printer{JSON: a.jsonOut || !isTTY(stdout), Out: stdout, Err: stderr}
		return nil
	}
	a.printer = &output.Printer{JSON: a.jsonOut || !isTTY(stdout), Out: stdout, Err: stderr}

	err := root.ExecuteContext(ctx)
	if err == nil {
		return output.ExitOK
	}
	if a.printer == nil {
		a.printer = &output.Printer{JSON: !isTTY(stdout), Out: stdout, Err: stderr}
	}
	if isCobraUsageError(err) {
		err = &output.UsageError{Msg: err.Error()}
	}
	return a.printer.Failure(err)
}

// isTTY reports whether a stream (stdin, stdout) is an interactive terminal.
func isTTY(stream any) bool {
	f, ok := stream.(*os.File)
	return ok && output.IsTerminal(f)
}

func isCobraUsageError(err error) bool {
	var usage *output.UsageError
	if errors.As(err, &usage) {
		return false
	}
	msg := err.Error()
	for _, prefix := range []string{"unknown command", "unknown flag", "unknown shorthand", "accepts ", "requires ", "invalid argument", "flag needs", "required flag"} {
		if strings.HasPrefix(msg, prefix) {
			return true
		}
	}
	return false
}

func newRoot(a *app) *cobra.Command {
	root := &cobra.Command{
		Use:   "ghcard",
		Short: "Generate GitHub profile and repository cards from the command line",
		Long: `ghcard turns a GitHub username or repository into an embeddable card image.

  ghcard card octocat                    # profile card, prints the link
  ghcard card octocat/hello-world        # repository card
  ghcard card octocat --embed markdown   # print a README snippet
  ghcard card octocat --readme README.md # insert or update it in a README

Output is human-readable on a terminal and JSON when piped or with --json.
Commands that create cards need an API key: create one at
https://githubcard.com/dashboard, then run 'ghcard auth login'.`,
		Version:       Version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.PersistentFlags().BoolVar(&a.jsonOut, "json", false, "write JSON to stdout (default when stdout is not a terminal)")
	root.PersistentFlags().StringVar(&a.flagKey, "api-key", "", "API key (overrides $GHCARD_API_KEY and the config file)")
	root.PersistentFlags().StringVar(&a.flagBaseURL, "base-url", "", "API origin (default https://githubcard.com)")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return &output.UsageError{Msg: err.Error()}
	})

	root.AddCommand(
		newCardCmd(a),
		newCardsCmd(a),
		newDesignCmd(a),
		newOpenCmd(a),
		newTemplatesCmd(a),
		newPalettesCmd(a),
		newComponentsCmd(a),
		newUsageCmd(a),
		newAuthCmd(a),
		newMCPCmd(a),
	)
	return root
}

// parseSubject turns "user" or "user/repo" into its parts.
func parseSubject(arg string) (username, repo string, err error) {
	arg = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(arg, "https://github.com/"), "github.com/"))
	arg = strings.TrimSuffix(arg, "/")
	parts := strings.Split(arg, "/")
	switch {
	case len(parts) == 1 && parts[0] != "":
		return parts[0], "", nil
	case len(parts) == 2 && parts[0] != "" && parts[1] != "":
		return parts[0], parts[1], nil
	default:
		return "", "", &output.UsageError{Msg: fmt.Sprintf("%q is not a GitHub user or owner/repo", arg)}
	}
}
