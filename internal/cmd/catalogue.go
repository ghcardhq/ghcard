package cmd

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/ghcardhq/ghcard/internal/api"
	"github.com/ghcardhq/ghcard/internal/config"
	"github.com/ghcardhq/ghcard/internal/output"
	"github.com/ghcardhq/ghcard/internal/subject"
)

func newTemplatesCmd(a *app) *cobra.Command {
	var scope string
	var freeOnly bool
	var widgets []string
	cmd := &cobra.Command{
		Use:   "templates",
		Short: "List card layouts (ids for --template)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if scope != "" && scope != "profile" && scope != "repo" {
				return &output.UsageError{Msg: "--scope must be profile or repo"}
			}
			client, err := a.client()
			if err != nil {
				return err
			}
			templates, err := client.Templates(cmd.Context(), scope)
			if err != nil {
				return err
			}
			if freeOnly {
				kept := templates[:0]
				for _, t := range templates {
					if !t.Pro {
						kept = append(kept, t)
					}
				}
				templates = kept
			}
			if len(widgets) > 0 {
				kept := templates[:0]
				for _, t := range templates {
					if subject.HasAllWidgets(t.Widgets, widgets) {
						kept = append(kept, t)
					}
				}
				templates = kept
			}
			a.printer.Success(templates, func(w io.Writer) {
				rows := make([][]string, 0, len(templates))
				for _, t := range templates {
					plan := "free"
					if t.Pro {
						plan = "pro"
					}
					rows = append(rows, []string{t.ID, t.Scope, fmt.Sprintf("%dx%d", t.Size.Width, t.Size.Height), plan, t.Name})
				}
				output.Table(w, []string{"ID", "SCOPE", "SIZE", "PLAN", "NAME"}, rows)
			})
			return nil
		},
	}
	cmd.Flags().StringVarP(&scope, "scope", "s", "", "only templates for profile or repo cards")
	cmd.Flags().BoolVar(&freeOnly, "free", false, "only templates available on the Free plan")
	cmd.Flags().StringSliceVarP(&widgets, "widget", "w", nil, "only templates containing these widget types (see `ghcard components`)")
	return cmd
}

func newPalettesCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "palettes",
		Short: "List background palettes (ids for --palette)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			palettes, err := client.Palettes(cmd.Context())
			if err != nil {
				return err
			}
			a.printer.Success(palettes, func(w io.Writer) {
				rows := make([][]string, 0, len(palettes.Palettes))
				for _, p := range palettes.Palettes {
					rows = append(rows, []string{p.ID, p.Kind, p.Name})
				}
				output.Table(w, []string{"ID", "KIND", "NAME"}, rows)
				if n := len(palettes.ProBackgrounds); n > 0 {
					fmt.Fprintf(w, "\nPro adds %d more backgrounds in the web editor.\n", n)
				}
			})
			return nil
		},
	}
}

func newComponentsCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "components",
		Short: "List the widget types a card can contain",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			components, err := client.Components(cmd.Context())
			if err != nil {
				return err
			}
			a.printer.Success(components, func(w io.Writer) {
				rows := make([][]string, 0, len(components))
				for _, c := range components {
					rows = append(rows, []string{c.Type, c.Scope, c.Description})
				}
				output.Table(w, []string{"TYPE", "SCOPE", "DESCRIPTION"}, rows)
			})
			return nil
		},
	}
}

func newUsageCmd(a *app) *cobra.Command {
	return &cobra.Command{
		Use:   "usage",
		Short: "Show your plan and today's card quota",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			account, err := client.Usage(cmd.Context())
			if err != nil {
				return err
			}
			a.printer.Success(account, func(w io.Writer) {
				fmt.Fprintf(w, "Account  %s (%s)\n", account.Username, account.Tier)
				fmt.Fprintf(w, "Cards    %d of %d used today, resets %s\n", account.Cards.Used, account.Cards.Limit, account.Cards.ResetAt)
				fmt.Fprintf(w, "Plan     verified until %s; visit https://githubcard.com/dashboard to renew\n", account.TierExpiresAt)
			})
			return nil
		},
	}
}

func newAuthCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "Store, check, or remove your API key",
	}

	var withToken bool
	login := &cobra.Command{
		Use:   "login",
		Short: "Save an API key to the config file",
		Long: `Save an API key so later commands can use it.

Create a key at https://githubcard.com/dashboard. The key is read from a
prompt, or from stdin with --with-token (so it never appears in shell
history), and is checked against the API before it is saved.`,
		Example: `  ghcard auth login
  echo "$KEY" | ghcard auth login --with-token`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var key string
			if withToken || !isTTY(cmd.InOrStdin()) {
				line, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
				if err != nil && line == "" {
					return &output.UsageError{Msg: "no key on stdin"}
				}
				key = strings.TrimSpace(line)
			} else {
				fmt.Fprint(a.printer.Err, "Paste your API key (from https://githubcard.com/dashboard): ")
				line, _ := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
				key = strings.TrimSpace(line)
			}
			if !strings.HasPrefix(key, "ghc_live_") {
				return &output.UsageError{Msg: "that does not look like a GitHubCard API key (ghc_live_…)"}
			}

			r, err := a.resolve()
			if err != nil {
				return err
			}
			account, err := api.New(r.BaseURL, key, "ghcard-cli/"+Version).Usage(cmd.Context())
			if err != nil {
				return err
			}

			file, err := config.Load()
			if err != nil {
				return err
			}
			file.APIKey = key
			if a.flagBaseURL != "" {
				file.BaseURL = a.flagBaseURL
			}
			path, err := config.Save(file)
			if err != nil {
				return err
			}
			a.printer.Success(map[string]any{"username": account.Username, "tier": account.Tier, "configPath": path}, func(w io.Writer) {
				fmt.Fprintf(w, "Logged in as %s (%s). Key saved to %s\n", account.Username, account.Tier, path)
			})
			return nil
		},
	}
	login.Flags().BoolVar(&withToken, "with-token", false, "read the key from stdin")

	status := &cobra.Command{
		Use:   "status",
		Short: "Show which key is in use and whether it works",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			r, err := a.resolve()
			if err != nil {
				return err
			}
			path, _ := config.Path()
			info := map[string]any{
				"baseUrl":       r.BaseURL,
				"baseUrlSource": r.BaseURLSource,
				"keySource":     r.APIKeySource,
				"configPath":    path,
			}
			if r.APIKey == "" {
				return api.ErrNoAPIKey
			}
			info["key"] = config.MaskKey(r.APIKey)
			account, err := api.New(r.BaseURL, r.APIKey, "ghcard-cli/"+Version).Usage(cmd.Context())
			if err != nil {
				return err
			}
			info["username"], info["tier"], info["tierExpiresAt"] = account.Username, account.Tier, account.TierExpiresAt
			a.printer.Success(info, func(w io.Writer) {
				fmt.Fprintf(w, "Logged in as %s (%s)\n", account.Username, account.Tier)
				fmt.Fprintf(w, "  Key     %s (from %s)\n", config.MaskKey(r.APIKey), r.APIKeySource)
				fmt.Fprintf(w, "  Server  %s (from %s)\n", r.BaseURL, r.BaseURLSource)
			})
			return nil
		},
	}

	logout := &cobra.Command{
		Use:   "logout",
		Short: "Remove the saved key from the config file",
		Long:  "Remove the saved key. This does not revoke it; revoke keys at https://githubcard.com/dashboard.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			file, err := config.Load()
			if err != nil {
				return err
			}
			had := file.APIKey != ""
			file.APIKey = ""
			path, err := config.Save(file)
			if err != nil {
				return err
			}
			a.printer.Success(map[string]any{"removed": had, "configPath": path}, func(w io.Writer) {
				if had {
					fmt.Fprintln(w, "Removed the saved key. Revoke it at https://githubcard.com/dashboard if it may have leaked.")
				} else {
					fmt.Fprintln(w, "No saved key.")
				}
			})
			return nil
		},
	}

	cmd.AddCommand(login, status, logout)
	return cmd
}
