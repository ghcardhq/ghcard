package cmd

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Cactusinhand/ghcard/internal/api"
	"github.com/Cactusinhand/ghcard/internal/output"
	"github.com/Cactusinhand/ghcard/internal/readme"
)

type cardResult struct {
	*api.CreatedCard
	Output     string `json:"output,omitempty"`
	ReadmePath string `json:"readmePath,omitempty"`
	ReadmeEdit string `json:"readmeEdit,omitempty"`
	// Warnings are problems after the card was created, such as a failed
	// download. The card and its links are still valid.
	Warnings []string `json:"warnings,omitempty"`
}

func newCardCmd(a *app) *cobra.Command {
	var (
		template, palette, format, embed, outPath, readmePath, designPath string
		noWatermark, snapshot, dryRun                                     bool
	)
	cmd := &cobra.Command{
		Use:   "card <user | owner/repo>",
		Short: "Create a card (or reuse the identical one) and print its link",
		Long: `Create a published card for a GitHub profile or repository.

The request is idempotent: the same subject, template, palette and watermark
setting always return the same card and link, so it is safe to run in CI on
every push. Each call counts once against the daily card quota.

Links are live by default: they re-render with current GitHub data. Use
--snapshot for the immutable image captured when the card was created.

--format picks which link is printed and which image --output saves (svg by
default). --readme always embeds the live SVG link, which renders sharpest on
GitHub. All flags combine; one call costs one quota unit.

Without --template the subject's default layout is used. --design publishes a
custom layout instead (see 'ghcard design'); Pro fonts and backgrounds in it
need Pro. Free accounts always get the watermark; --no-watermark needs Pro.`,
		Example: `  ghcard card octocat
  ghcard card octocat/hello-world --template repo-dark-terminal
  ghcard card octocat --palette sage --embed markdown
  ghcard card octocat --format png --output card.png
  ghcard card octocat --readme README.md
  ghcard card octocat --design design.json --dry-run
  ghcard card octocat --design design.json`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			username, repo, err := parseSubject(args[0])
			if err != nil {
				return err
			}
			if format != "svg" && format != "png" {
				return &output.UsageError{Msg: "--format must be svg or png"}
			}
			if embed != "" && embed != "markdown" && embed != "html" && embed != "url" {
				return &output.UsageError{Msg: "--embed must be markdown, html, or url"}
			}

			req := api.CardRequest{Username: username, Template: template, Palette: palette, Format: format}
			if repo != "" {
				req.Type, req.Repo = "repo", repo
			}
			if designPath != "" {
				if template != "" || palette != "" {
					return &output.UsageError{Msg: "--design cannot be combined with --template or --palette"}
				}
				if req.Design, err = readDesign(cmd, designPath); err != nil {
					return err
				}
			}
			if noWatermark {
				off := false
				req.Watermark = &off
			}

			client, err := a.client()
			if err != nil {
				return err
			}
			if dryRun {
				checked, err := client.ValidateCard(cmd.Context(), req)
				if err != nil {
					return err
				}
				a.printer.Success(checked, func(w io.Writer) {
					fmt.Fprintf(w, "Valid: template %s, %dx%d, %d layers, watermark %v. Nothing was created.\n",
						checked.Template, checked.Artboard.Width, checked.Artboard.Height, checked.Layers, checked.Watermark)
					for _, warning := range checked.Warnings {
						fmt.Fprintf(w, "  Warning: %s\n", warning)
					}
				})
				return nil
			}
			a.printer.Info("Generating card for %s…", args[0])
			card, _, err := client.CreateCard(cmd.Context(), req)
			if err != nil {
				return err
			}
			if noWatermark && card.Watermark {
				a.printer.Info("Note: the watermark stays on for Free accounts.")
			}

			if snapshot {
				// Swap every link for the immutable publication captured now.
				card.URLs = card.SnapshotURLs
				card.URL = card.SnapshotURLs.SVG
				if format == "png" {
					card.URL = card.SnapshotURLs.PNG
				}
				alt := "GitHubCard for " + card.Subject
				href := "https://github.com/" + card.Subject
				card.Embed.Markdown = fmt.Sprintf("[![%s](%s)](%s)", alt, card.SnapshotURLs.SVG, href)
				card.Embed.HTML = fmt.Sprintf(`<a href="%s"><img src="%s" alt="%s"></a>`, href, card.SnapshotURLs.SVG, alt)
			}

			result := cardResult{CreatedCard: card}
			if outPath != "" {
				// The card exists and costs quota already; a failed download
				// must not hide it or skip the README update.
				if body, _, err := client.Download(cmd.Context(), card.URL); err != nil {
					result.Warnings = append(result.Warnings, fmt.Sprintf("download failed (%v); fetch %s later", err, card.URL))
				} else if err := os.WriteFile(outPath, body, 0o644); err != nil {
					result.Warnings = append(result.Warnings, fmt.Sprintf("write %s: %v", outPath, err))
				} else {
					result.Output = outPath
				}
			}
			if readmePath != "" {
				snippet := card.Embed.Markdown
				edit, err := readme.Upsert(readmePath, readme.MarkerID(card.Subject), snippet)
				if err != nil {
					return err
				}
				result.ReadmePath, result.ReadmeEdit = readmePath, string(edit)
			}

			a.printer.Success(result, func(w io.Writer) {
				switch embed {
				case "markdown":
					fmt.Fprintln(w, card.Embed.Markdown)
					return
				case "html":
					fmt.Fprintln(w, card.Embed.HTML)
					return
				case "url":
					fmt.Fprintln(w, card.URL)
					return
				}
				state := "Created"
				if !card.Created {
					state = "Reused"
				}
				fmt.Fprintf(w, "%s card %s for %s (template %s)\n", state, card.ID, card.Subject, card.Template)
				fmt.Fprintf(w, "  SVG       %s\n", card.URLs.SVG)
				fmt.Fprintf(w, "  PNG       %s\n", card.URLs.PNG)
				fmt.Fprintf(w, "  Markdown  %s\n", card.Embed.Markdown)
				fmt.Fprintf(w, "  Edit      %s\n", card.EditURL)
				if result.Output != "" {
					abs, _ := filepath.Abs(result.Output)
					fmt.Fprintf(w, "  Saved     %s\n", abs)
				}
				if result.ReadmePath != "" {
					fmt.Fprintf(w, "  README    %s (%s)\n", result.ReadmePath, result.ReadmeEdit)
				}
				for _, warning := range result.Warnings {
					fmt.Fprintf(w, "  Warning   %s\n", warning)
				}
				fmt.Fprintf(w, "Quota: %d of %d cards left today\n", card.Usage.Remaining, card.Usage.Limit)
			})
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&template, "template", "t", "", "layout id (see `ghcard templates`; default: the subject's default layout)")
	f.StringVarP(&palette, "palette", "p", "", "background palette id (see `ghcard palettes`; default: the template's own)")
	f.StringVarP(&format, "format", "f", "svg", "link format to print and download: svg or png")
	f.StringVarP(&embed, "embed", "e", "", "print only a snippet: markdown, html, or url")
	f.StringVarP(&outPath, "output", "o", "", "also download the image to this file")
	f.StringVar(&readmePath, "readme", "", "insert or update the card's Markdown in this file")
	f.StringVarP(&designPath, "design", "d", "", "publish this design file (\"-\" for stdin) instead of a template")
	f.BoolVar(&noWatermark, "no-watermark", false, "remove the watermark (Pro)")
	f.BoolVar(&snapshot, "snapshot", false, "use the frozen image links instead of live ones")
	f.BoolVar(&dryRun, "dry-run", false, "check the request (ids, Pro features, design) without creating a card or using quota")
	return cmd
}

func newCardsCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cards",
		Short: "List or delete the cards this account generated",
	}

	var limit int
	var cursor string
	var all bool
	list := &cobra.Command{
		Use:     "list",
		Short:   "List your cards, most recently requested first",
		Aliases: []string{"ls"},
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			var cards []api.Card
			var next *string
			for {
				page, err := client.ListCards(cmd.Context(), limit, cursor)
				if err != nil {
					return err
				}
				cards = append(cards, page.Cards...)
				next = page.NextCursor
				if !all || next == nil {
					break
				}
				cursor = *next
			}
			a.printer.Success(map[string]any{"cards": cards, "nextCursor": next}, func(w io.Writer) {
				if len(cards) == 0 {
					fmt.Fprintln(w, "No cards yet. Create one with `ghcard card <user>`.")
					return
				}
				rows := make([][]string, 0, len(cards))
				for _, c := range cards {
					rows = append(rows, []string{c.ID, c.Subject, c.Template, c.URLs.SVG})
				}
				output.Table(w, []string{"ID", "SUBJECT", "TEMPLATE", "SVG"}, rows)
				if next != nil {
					fmt.Fprintf(w, "\nMore: ghcard cards list --cursor %s (or --all)\n", *next)
				}
			})
			return nil
		},
	}
	list.Flags().IntVarP(&limit, "limit", "n", 20, "cards per page (1-100)")
	list.Flags().StringVar(&cursor, "cursor", "", "continue from a previous page")
	list.Flags().BoolVar(&all, "all", false, "fetch every page")

	var yes bool
	del := &cobra.Command{
		Use:     "delete <card-id>...",
		Short:   "Delete cards; their links stop working",
		Aliases: []string{"rm"},
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !yes && !a.printer.JSON {
				fmt.Fprintf(a.printer.Err, "Delete %s? Embedded links will break. [y/N] ", strings.Join(args, ", "))
				var answer string
				_, _ = fmt.Fscanln(cmd.InOrStdin(), &answer)
				if !strings.EqualFold(strings.TrimSpace(answer), "y") {
					return &output.UsageError{Msg: "cancelled"}
				}
			} else if !yes {
				return &output.UsageError{Msg: "deleting without a terminal requires --yes"}
			}
			client, err := a.client()
			if err != nil {
				return err
			}
			for _, id := range args {
				if err := client.DeleteCard(cmd.Context(), id); err != nil {
					return err
				}
			}
			a.printer.Success(map[string]any{"deleted": args}, func(w io.Writer) {
				fmt.Fprintf(w, "Deleted %s\n", strings.Join(args, ", "))
			})
			return nil
		},
	}
	del.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")

	cmd.AddCommand(list, del)
	return cmd
}
