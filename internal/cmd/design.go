package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/Cactusinhand/GithubCard-web/cli/internal/api"
	"github.com/Cactusinhand/GithubCard-web/cli/internal/output"
)

func newDesignCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "design",
		Short: "Work with card design documents (layout JSON)",
		Long: `A design document is the JSON the web editor saves: the artboard (size,
background, fonts, colours) and its layers (widgets with position, size and
settings). Start from a template or an existing card, edit the JSON, then
publish it with 'ghcard card <subject> --design design.json'.

Use a design when a template plus --palette is not enough: any hex background,
other fonts or colours, a different size, or adding/removing/moving widgets.

Editing rules:
  - The subject in a design file is ignored: the card command's argument
    decides whose data the card shows.
  - Layers are absolutely positioned (x, y, width, height). Removing one leaves
    its space empty; move or resize the others to fill it.
  - Each layer needs a unique "id" and a "type" from 'ghcard components';
    "layer" is only the stacking order and need not be contiguous.
  - artboard.showWatermark is decided by the server (Free: always on).
  - On Free, Pro fonts and backgrounds fail with PRO_FEATURE; fonts and
    backgrounds that free templates already use are fine.`,
		Example: `  ghcard design init social -o design.json
  ghcard design init repo-og-compact --subject octocat/hello-world -o design.json
  ghcard design get Qm3x8LkP2aZr7TnB -o design.json
  ghcard card octocat --design design.json`,
	}

	var subject, palette, outPath string
	initCmd := &cobra.Command{
		Use:   "init <template>",
		Short: "Write a template's layout as a design file (no key, no quota)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var username, repo string
			if subject != "" {
				var err error
				if username, repo, err = parseSubject(subject); err != nil {
					return err
				}
			}
			client, err := a.client()
			if err != nil {
				return err
			}
			design, err := client.TemplateDesign(cmd.Context(), args[0], username, repo, palette)
			if err != nil {
				return err
			}
			return writeDesign(a, design, outPath)
		},
	}
	initCmd.Flags().StringVar(&subject, "subject", "", "user or owner/repo; picks the default background (default octocat)")
	initCmd.Flags().StringVarP(&palette, "palette", "p", "", "apply a background palette id")
	initCmd.Flags().StringVarP(&outPath, "output", "o", "", "write to this file instead of stdout")

	var getOut string
	get := &cobra.Command{
		Use:   "get <card-id>",
		Short: "Print the design of one of your cards",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			design, err := client.CardDesign(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return writeDesign(a, design, getOut)
		},
	}
	get.Flags().StringVarP(&getOut, "output", "o", "", "write to this file instead of stdout")

	cmd.AddCommand(initCmd, get)
	return cmd
}

// writeDesign saves a design to a file, or prints it. On stdout the design
// is the data itself (wrapped in the JSON envelope in JSON mode), so it can
// be redirected to a file either way.
func writeDesign(a *app, design json.RawMessage, path string) error {
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, design, "", "  "); err != nil {
		return fmt.Errorf("format design: %w", err)
	}
	pretty.WriteByte('\n')
	if path == "" {
		if a.printer.JSON && !a.jsonOut {
			// Piped without --json: emit the bare document for `> file`.
			_, err := a.printer.Out.Write(pretty.Bytes())
			return err
		}
		a.printer.Success(design, func(w io.Writer) { _, _ = w.Write(pretty.Bytes()) })
		return nil
	}
	if err := os.WriteFile(path, pretty.Bytes(), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	a.printer.Success(map[string]string{"output": path}, func(w io.Writer) {
		fmt.Fprintf(w, "Wrote %s\nPublish it with: ghcard card <user | owner/repo> --design %s\n", path, path)
	})
	return nil
}

// readDesign loads a design file ("-" for stdin) and checks it is a JSON object.
func readDesign(cmd *cobra.Command, path string) (json.RawMessage, error) {
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(io.LimitReader(cmd.InOrStdin(), 4<<20))
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, &output.UsageError{Msg: fmt.Sprintf("read design: %v", err)}
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, &output.UsageError{Msg: fmt.Sprintf("%s is not a JSON design object: %v", path, err)}
	}
	return json.RawMessage(raw), nil
}

func newOpenCmd(a *app) *cobra.Command {
	var printOnly bool
	cmd := &cobra.Command{
		Use:   "open <card-id>",
		Short: "Open one of your cards in the web editor",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			card, err := findCard(cmd, client, args[0])
			if err != nil {
				return err
			}
			if !printOnly && !a.printer.JSON {
				if err := openBrowser(card.EditURL); err != nil {
					a.printer.Info("Could not open a browser: %v", err)
				}
			}
			a.printer.Success(map[string]string{"id": card.ID, "editUrl": card.EditURL}, func(w io.Writer) {
				fmt.Fprintln(w, card.EditURL)
			})
			return nil
		},
	}
	cmd.Flags().BoolVar(&printOnly, "print", false, "print the editor link without opening a browser")
	return cmd
}

func findCard(cmd *cobra.Command, client *api.Client, id string) (*api.Card, error) {
	cursor := ""
	for {
		page, err := client.ListCards(cmd.Context(), 100, cursor)
		if err != nil {
			return nil, err
		}
		for i := range page.Cards {
			if page.Cards[i].ID == id {
				return &page.Cards[i], nil
			}
		}
		if page.NextCursor == nil {
			return nil, &api.Error{Status: 404, Code: "CARD_NOT_FOUND", Message: "Card not found"}
		}
		cursor = *page.NextCursor
	}
}

func openBrowser(target string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}
