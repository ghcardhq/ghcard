# ghcard

Generate [GitHubCard](https://githubcard.com) profile and repository cards from
the command line, from CI, or from an AI agent over MCP.

```bash
npx -y @ghcardhq/ghcard create octocat                     # profile card; prints its README snippet
npx -y @ghcardhq/ghcard create octocat/hello-world         # repository card
npx -y @ghcardhq/ghcard create octocat --embed markdown    # just the README snippet
npx -y @ghcardhq/ghcard create octocat --readme README.md  # insert or update it in a README
npx -y @ghcardhq/ghcard create octocat -f png -o card.png  # download the image
```

## Install

Needs Node.js 20 or later.

```bash
npm install -g @ghcardhq/ghcard
```

Either way the command is `ghcard`. Or run it without installing:
`npx -y @ghcardhq/ghcard <command>`. The examples below
assume a global install.

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

Listing templates, palettes and components needs no key. On a terminal, a
command that needs a key and finds none offers to log in on the spot, then
carries on.

## Commands

| Command | What it does |
| --- | --- |
| `ghcard create <user\|owner/repo>` | Create a card, or reuse the identical one, and print its links |
| `ghcard list [--all]` | List the cards your account generated |
| `ghcard delete <id>... [--yes]` | Delete cards; their links stop working |
| `ghcard design init <template> [-o FILE]` | Write a template's layout as an editable design (no key, no quota) |
| `ghcard design get <card-id> [-o FILE]` | Export one of your cards' design |
| `ghcard open <card-id> [--print]` | Open a card in the web editor |
| `ghcard templates [--scope profile\|repo] [--free]` | Layout ids for `--template` |
| `ghcard palettes` | Background ids for `--palette` |
| `ghcard components` | Widget types a card can contain |
| `ghcard usage` | Your plan and today's card quota |
| `ghcard auth login\|status\|logout` | Manage the stored key |
| `ghcard mcp` | Run as an MCP server for AI agents |
| `ghcard completion bash\|zsh\|fish` | Print a shell completion script |

`ghcard create` flags: `--template/-t`, `--palette/-p`, `--design/-d FILE|-`,
`--format/-f svg|png`, `--embed/-e markdown|html|url`, `--output/-o FILE`,
`--readme FILE`, `--snapshot`, `--dry-run` (check without creating or using
quota), `--no-watermark` (Pro), `--verbose` (also print the image links).

On a terminal, `create` prints the card's Markdown snippet and its editor
link; `--verbose` adds the SVG, PNG and HTML links. Piped output and `--json`
always carry every link.

Shell completion:

```bash
echo 'eval "$(ghcard completion zsh)"' >> ~/.zshrc    # or bash: ~/.bashrc
```

### Custom layouts

```bash
ghcard design init social -o design.json      # or: ghcard design get <card-id> -o design.json
$EDITOR design.json                           # artboard size/colours/fonts, layers[]
ghcard create octocat --design design.json
```

The design's own subject is ignored; the `create` argument decides whose data
it shows. Layer types come from `ghcard components`. On Free, Pro fonts and
backgrounds fail with `PRO_FEATURE`, and `error.details.features` lists them.

### Idempotent by design

The same subject, template, palette and watermark setting always return the
same card and link (`"created": false` on repeats). Running
`ghcard create me --readme README.md` on every CI push keeps one card and one
README block. Card images show live GitHub data, so there is no need to
regenerate a card to refresh it.

Every `ghcard create` call counts once against the daily quota (Free 100,
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

The quickest way to use GitHubCard from an AI agent is the hosted server at
`https://githubcard.com/mcp`; setup for each client is in
[ghcardhq/githubcard-mcp](https://github.com/ghcardhq/githubcard-mcp).

`ghcard mcp` runs the same tools locally over stdio. It adds `update_readme`
when started with `--allow-file-writes`, so the agent can edit a README on
your disk. Tools: `create_card` (template or custom `design`),
`validate_card` (free dry run), `list_templates`, `list_palettes`,
`list_components`, `get_template_design`, `get_card_design`, `list_cards`,
`delete_card`, `get_usage`.

Claude Code:

```bash
claude mcp add githubcard --env GHCARD_API_KEY=ghc_live_... -- npx -y @ghcardhq/ghcard mcp
```

Claude Desktop, Cursor, and other clients (`mcpServers` config):

```json
{
  "mcpServers": {
    "githubcard": {
      "command": "npx",
      "args": ["-y", "@ghcardhq/ghcard", "mcp"],
      "env": { "GHCARD_API_KEY": "ghc_live_..." }
    }
  }
}
```

Failed tool calls return `isError: true` with the same `code`, `retryable`
flag and a `hint` the model can act on.

## Claude Code skill

The `githubcard` skill teaches Claude Code when and how to use `ghcard`. It
lives in [ghcardhq/skills](https://github.com/ghcardhq/skills):

```bash
claude plugin marketplace add ghcardhq/skills
claude plugin install githubcard@githubcard
```

## Development

```bash
npm install
npm test
npm run typecheck
GHCARD_BASE_URL=http://localhost:5173 npm run dev -- templates
```

Releases: bump `version` in `package.json`, then push a matching `v*` tag. The
release workflow publishes `@ghcardhq/ghcard` to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm
token is stored in the repository and each release carries provenance.

## License

MIT
