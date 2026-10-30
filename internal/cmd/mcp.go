package cmd

import (
	"github.com/spf13/cobra"

	"github.com/Cactusinhand/ghcard/internal/mcpserver"
)

func newMCPCmd(a *app) *cobra.Command {
	var allowWrites bool
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Run a Model Context Protocol server on stdio for AI agents",
		Long: `Run ghcard as an MCP server so AI agents can create and manage cards.

The server speaks MCP over stdin/stdout and uses the same API key as the
CLI (flag, $GHCARD_API_KEY, or the config file). Example client config:

  {
    "mcpServers": {
      "githubcard": {
        "command": "ghcard",
        "args": ["mcp"],
        "env": { "GHCARD_API_KEY": "ghc_live_..." }
      }
    }
  }

--allow-file-writes adds an update_readme tool that edits local Markdown
files. It is off by default.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, err := a.client()
			if err != nil {
				return err
			}
			return mcpserver.Run(cmd.Context(), mcpserver.Options{
				Client:          client,
				Version:         Version,
				AllowFileWrites: allowWrites,
			})
		},
	}
	cmd.Flags().BoolVar(&allowWrites, "allow-file-writes", false, "expose update_readme, which edits local Markdown files")
	return cmd
}
