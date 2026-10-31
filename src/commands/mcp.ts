import type { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../mcp/server.js';
import { VERSION, type App } from '../app.js';

export function registerMcp(program: Command, app: App): void {
  program
    .command('mcp')
    .helpGroup('Account and agents:')
    .summary('Run an MCP server on stdio for AI agents')
    .description(
      `Run a Model Context Protocol server on stdio for AI agents.

The server speaks MCP over stdin/stdout and uses the same API key as the
CLI (flag, $GHCARD_API_KEY, or the config file). Example client config:

  {
    "mcpServers": {
      "githubcard": {
        "command": "npx",
        "args": ["-y", "ghcard", "mcp"],
        "env": { "GHCARD_API_KEY": "ghc_live_..." }
      }
    }
  }

No install at all: point the client at the hosted server instead,
https://githubcard.com/mcp, with an "Authorization: Bearer <key>" header.

--allow-file-writes adds an update_readme tool that edits local Markdown
files. It is off by default.`
    )
    .option('--allow-file-writes', 'expose update_readme, which edits local Markdown files')
    .action(async (opts: { allowFileWrites?: boolean }) => {
      const server = createServer({
        client: await app.client(),
        version: VERSION,
        allowFileWrites: Boolean(opts.allowFileWrites),
      });
      await server.connect(new StdioServerTransport());
    });
}
