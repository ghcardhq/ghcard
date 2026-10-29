---
name: githubcard
description: Create embeddable GitHub profile and repository card images with the ghcard CLI, and add them to README files. Use when the user wants a GitHub stats card, a profile card, a repo card or banner, a social preview image for a repository, or to put such a card in a README or profile README (github.com/<user>/<user>). Also covers listing, deleting, and checking quota for GitHubCard cards.
---

# GitHubCard cards with `ghcard`

`ghcard` turns a GitHub username or `owner/repo` into a published card image
with stable SVG/PNG links and ready-made Markdown/HTML embeds. Card images
show live GitHub data, so a card never needs regenerating to stay current.

## Before you start

1. Check the CLI is installed: `ghcard --version`. If it is missing:
   `go install github.com/Cactusinhand/GithubCard-web/cli/cmd/ghcard@latest`
   (needs Go 1.25+), and make sure `$(go env GOPATH)/bin` is on `PATH`.
2. Check auth: `ghcard auth status --json`.
   - Exit code 3 / `NO_API_KEY` or `UNAUTHORIZED`: the user needs a key from
     https://githubcard.com/dashboard. Ask them to run
     `ghcard auth login` themselves, or to set `GHCARD_API_KEY`.
     Never ask the user to paste the key into the chat, and never echo,
     log, or write a key into a file in the repository.
   - Listing templates/palettes works without a key.

Always pass `--json` and read stdout as one JSON document:
`{"ok": true, "data": ...}` or
`{"ok": false, "error": {"code", "message", "retryable", "hint"}}`.

## Main flows

**Card for a profile or repo** (the common case):

```bash
ghcard card octocat --json
ghcard card octocat/hello-world --json
```

Use `data.urls.svg` / `data.urls.png` for links and `data.embed.markdown`
for a README. `data.created` is `false` when the identical card already
existed, which is expected and fine.

**Add it to a README** (inserts after the first heading, or replaces the
existing `<!-- ghcard:<subject> -->` block on later runs):

```bash
ghcard card octocat --readme README.md --json
```

For a GitHub *profile* README the file lives in the repo named after the
user (`<user>/<user>/README.md`). Show the user the diff before
committing; do not commit or push unless they ask.

**Choose a look** only if the user cares about style:

```bash
ghcard templates --scope profile --free --json   # or --scope repo
ghcard palettes --json
ghcard card octocat --template pro-terminal --palette sage --json
```

Template scope must match the subject: profile templates for a user,
repo templates for `owner/repo` (templates with scope `all` fit both).
Prefer templates with `"pro": false` unless the user has Pro
(`ghcard usage --json` → `data.tier`).

**Download the image** instead of linking it:
`ghcard card octocat --format png --output card.png --json`.

**Manage cards:** `ghcard cards list --json`, `ghcard usage --json`.
`ghcard cards delete <id> --yes --json` breaks every place the card is
embedded, so confirm with the user first.

## Handling errors

Branch on `error.code` (or the exit code), and use `error.hint`:

| Code / exit | What to do |
| --- | --- |
| `UNKNOWN_TEMPLATE`, `TEMPLATE_SCOPE_MISMATCH` (2) | List templates for the right scope and pick a valid id |
| `UNKNOWN_PALETTE` (2) | List palettes, or drop `--palette` |
| `INVALID_REQUEST` (2) | Fix the argument named in `error.details.field` |
| `PRO_TEMPLATE` (1) | Pick a free template, or tell the user it needs Pro |
| `SUBJECT_NOT_FOUND` (4) | Check spelling; private repositories are not supported |
| `NO_API_KEY`, `UNAUTHORIZED` (3) | See "Before you start" |
| `QUOTA_EXCEEDED` (5) | Stop. Tell the user the daily quota resets at 00:00 UTC (`error.details.resetAt`) |
| `GITHUB_DATA_NOT_READY`, `GITHUB_CAPACITY`, other `retryable: true` (6) | Wait (`error.details.retryAfterSeconds` if present) and retry once |

## Things to avoid

- Calling `ghcard card` repeatedly to "refresh" a card: each call costs
  quota and the link already shows live data.
- Hand-building `githubcard.com` URLs: use the links the CLI returns.
- Passing `--no-watermark` on a Free account: the server keeps the
  watermark anyway; mention that removing it is a Pro feature.

## MCP alternative

If the GitHubCard MCP server is configured (`ghcard mcp`), its tools
(`create_card`, `list_templates`, `list_palettes`, `list_cards`,
`delete_card`, `get_usage`) do the same things and return the same error
codes; use whichever is available.
