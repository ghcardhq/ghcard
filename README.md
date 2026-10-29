# ghcard

Generate GitHub profile and repository cards from the command line, from CI,
or from an AI agent over MCP.

```bash
ghcard card octocat                     # profile card; prints SVG/PNG links
ghcard card octocat/hello-world         # repository card
ghcard card octocat --embed markdown    # just the README snippet
ghcard card octocat --readme README.md  # insert or update it in a README
ghcard card octocat -f png -o card.png  # download the image
```

## Install

```bash
go install github.com/Cactusinhand/GithubCard-web/cli/cmd/ghcard@latest
```

Or build from this directory, stamping a version:

```bash
go build -ldflags "-X github.com/Cactusinhand/GithubCard-web/cli/internal/cmd.Version=v0.1.0" -o ghcard ./cmd/ghcard
```

## Authenticate

Creating cards needs an API key. Create one on
[your dashboard](https://githubcard.com/dashboard), then:

```bash
ghcard auth login                          # paste the key at the prompt
echo "$KEY" | ghcard auth login --with-token
ghcard auth status
```

The key is saved to `<user config dir>/ghcard/config.json` with mode 0600.
`GHCARD_API_KEY` (or `--api-key`) overrides it, which is the way to pass a
key in CI. `ghcard auth logout` removes the saved key; revoke keys on the
dashboard.

Listing templates, palettes and components needs no key.

## Commands

| Command | What it does |
| --- | --- |
| `ghcard card <user\|owner/repo>` | Create a card, or reuse the identical one, and print its links |
| `ghcard cards list [--all]` | List the cards your account generated |
| `ghcard cards delete <id>... [--yes]` | Delete cards; their links stop working |
| `ghcard design init <template> [-o FILE]` | Write a template's layout as an editable design (no key, no quota) |
| `ghcard design get <card-id> [-o FILE]` | Export one of your cards' design |
| `ghcard open <card-id> [--print]` | Open a card in the web editor |
| `ghcard templates [--scope profile\|repo] [--free]` | Layout ids for `--template` |
| `ghcard palettes` | Background ids for `--palette` |
| `ghcard components` | Widget types a card can contain |
| `ghcard usage` | Your plan and today's card quota |
| `ghcard auth login\|status\|logout` | Manage the stored key |
| `ghcard mcp` | Run as an MCP server for AI agents |

`ghcard card` flags: `--template/-t`, `--palette/-p`, `--design/-d FILE|-`,
`--format/-f svg|png`, `--embed/-e markdown|html|url`, `--output/-o FILE`,
`--readme FILE`, `--snapshot`, `--dry-run` (check without creating or using
quota), `--no-watermark` (Pro).

### Custom layouts

```bash
ghcard design init social -o design.json      # or: ghcard design get <card-id> -o design.json
$EDITOR design.json                           # artboard size/colours/fonts, layers[]
ghcard card octocat --design design.json
```

The design's own subject is ignored; the `card` argument decides whose data
it shows. Layer types come from `ghcard components`. On Free, Pro fonts and
backgrounds fail with `PRO_FEATURE`. See
[Custom designs](../docs/public-api.md#custom-designs).

### Idempotent by design

The same subject, template, palette and watermark setting always return the
same card and link (`"created": false` on repeats). Running
`ghcard card me --readme README.md` on every CI push keeps one card and one
README block. Card images show live GitHub data, so there is no need to
regenerate a card to refresh it.

Every `ghcard card` call counts once against the daily quota (Free 100,
Pro 5000, reset 00:00 UTC). Failed calls are not counted.

## Scripting and agents

Output is human-readable on a terminal and a single JSON document when
stdout is piped, or with `--json`:

```json
{"ok": true,  "data": { ... }}
{"ok": false, "error": {"code": "UNKNOWN_TEMPLATE", "message": "...", "retryable": false, "hint": "..."}}
```

Progress messages go to stderr. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Other error (for example, a Pro-only template on Free) |
| 2 | Invalid usage or arguments; fix the command |
| 3 | Missing, invalid, or revoked API key |
| 4 | Not found (user, repository, or card) |
| 5 | Quota exhausted; see `error.details.retryAfterSeconds` |
| 6 | Temporarily unavailable; retrying is safe |

`cards delete` asks for confirmation on a terminal and requires `--yes`
otherwise.

## MCP server

`ghcard mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio. Tools: `create_card` (template or custom `design`),
`validate_card` (free dry run), `list_templates`, `list_palettes`,
`list_components`, `get_template_design`,
`get_card_design`, `list_cards`, `delete_card`, `get_usage`, and, only with
`--allow-file-writes`, `update_readme`.

Claude Code:

```bash
claude mcp add githubcard --env GHCARD_API_KEY=ghc_live_... -- ghcard mcp
```

Claude Desktop, Cursor, and other clients (`mcpServers` config):

```json
{
  "mcpServers": {
    "githubcard": {
      "command": "ghcard",
      "args": ["mcp"],
      "env": { "GHCARD_API_KEY": "ghc_live_..." }
    }
  }
}
```

Failed tool calls return `isError: true` with the same `code`, `retryable`
flag and a `hint` the model can act on.

## Claude Code skill

`skill/githubcard/SKILL.md` teaches Claude Code (and other agents that read
skills) when and how to use `ghcard`: the main flows, README editing, and
what to do for each error code. Install it for your user:

```bash
mkdir -p ~/.claude/skills && cp -R skill/githubcard ~/.claude/skills/
```

## Development

```bash
go test ./...
GHCARD_BASE_URL=http://localhost:5173 go run ./cmd/ghcard templates
```
