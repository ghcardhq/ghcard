/**
 * The GitHubCard API as Model Context Protocol tools over stdio, so AI agents
 * (Claude Code, Claude Desktop, Cursor, …) can generate cards without
 * shelling out.
 *
 * Every tool calls the same Client the CLI uses. Tool failures are returned as
 * tool results (isError) carrying the API's stable error code, retryable flag,
 * and a hint, so the model can correct itself.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, NoApiKeyError, type CardRequest, type Client } from '../api.js';
import { markerId, upsertBlock } from '../readme.js';
import { hasAllWidgets, parseSubject, SubjectError } from '../subject.js';

export const INSTRUCTIONS = `GitHubCard turns a GitHub user or repository into an embeddable card image.

Typical flow:
1. Optionally call list_templates (scope "profile" or "repo") and list_palettes to pick ids.
2. Call create_card with the subject. It returns SVG/PNG links and Markdown/HTML embed snippets.
   It is idempotent: the same parameters return the same card and link.
3. To place it in a README, use update_readme with embed.markdown (or insert it yourself).
   Share urls (live, re-render with current data); snapshotUrls are frozen images.

Custom layouts (any hex background, size, font, or adding/removing/moving widgets):
call get_template_design (free, no quota) or get_card_design to get a design document,
edit it, check it with validate_card (free), then pass it as create_card's "design"
instead of template/palette.
Design document shape:
  artboard: {width, height (px, 100-4000), background: {color: a full CSS background,
             e.g. "#1e3a5f" or "radial-gradient(...) 0 0 / 22px 22px #0d1117"; a plain hex
             replaces any texture, so change only the trailing colour to keep it},
             style: {fontFamily, textColor, secondaryTextColor, accentColor, radius}}
  layers:   [{id (unique), type (from list_components), x, y, width, height (px from the
             artboard's top-left), layer (stacking order), style, ...widget settings}]
Layers are absolutely positioned: removing one leaves its space empty, and anything
outside the artboard is clipped, so move or resize neighbours yourself (validate_card
warns about clipped layers). Keep version and any other fields you do not change;
dataSource, ownerId, meta and showWatermark are replaced by the server.
Widgets scale to their box. Text colours come from artboard.style (textColor,
secondaryTextColor, accentColor) or a layer's style; when you change the background a
lot, set them too so text stays readable.
Plain solid colours are free; gradients and patterns are free only when they are a free
preset, a list_palettes palette, or a free template's own background. On Free, the editor's Pro fonts and background presets fail
with PRO_FEATURE (details.features lists each path); fonts and backgrounds that free
templates already use are fine.
Failed create_card calls are refunded. A first card can take a while to render: on
CARD_GENERATION_IN_PROGRESS or NETWORK_ERROR wait ~30s and repeat the identical call.

Each create_card call counts against a daily quota (get_usage shows what is left).
Do not call create_card in a loop to "refresh" a card: the link always shows live data.
Free accounts always get a small watermark.`;

export interface ServerOptions {
  client: Client;
  version: string;
  /** Enables update_readme. Off unless the user opted in. */
  allowFileWrites?: boolean;
}

/** What a failing tool returns to the model. */
export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  hint?: string;
  details?: Record<string, unknown>;
}

class ToolFailure extends Error {
  constructor(readonly body: ToolError) {
    super(body.message);
  }
}

function invalid(message: string): ToolFailure {
  return new ToolFailure({ code: 'INVALID_REQUEST', message, retryable: false });
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolFailure) return error.body;
  if (error instanceof SubjectError) return { code: 'INVALID_REQUEST', message: error.message, retryable: false };
  if (error instanceof NoApiKeyError) {
    return {
      code: 'NO_API_KEY',
      message: 'The GitHubCard MCP server has no API key.',
      retryable: false,
      hint: 'Ask the user to create a key at https://githubcard.com/dashboard and set GHCARD_API_KEY in the MCP server config (or run `ghcard auth login`).',
    };
  }
  if (!(error instanceof ApiError)) {
    return { code: 'ERROR', message: error instanceof Error ? error.message : String(error), retryable: false };
  }
  const te: ToolError = { code: error.code, message: error.message, retryable: error.retryable };
  if (error.retryAfterSeconds > 0) te.retryAfterSeconds = error.retryAfterSeconds;
  if (error.details) te.details = error.details;
  const code = error.code;
  if (error.status === 401 || code === 'UNAUTHORIZED') {
    te.hint = 'The API key is invalid or revoked. Ask the user for a new key from https://githubcard.com/dashboard.';
  } else if (error.status === 429) {
    te.hint = 'The daily card quota is used up. Tell the user; do not retry until resetAt.';
    te.retryable = false;
  } else if (code === 'UNKNOWN_TEMPLATE' || code === 'TEMPLATE_SCOPE_MISMATCH') {
    te.hint = "Call list_templates with the card's scope and use one of its ids.";
  } else if (code === 'UNKNOWN_PALETTE') {
    te.hint = 'Call list_palettes and use one of its ids, or omit palette.';
  } else if (code === 'PRO_TEMPLATE') {
    te.hint = 'That template needs Pro. Pick one with pro=false, or tell the user.';
  } else if (code === 'PRO_FEATURE') {
    te.hint =
      'The design uses a Pro font or background (details.features). Replace them with free ones, or tell the user it needs Pro.';
  } else if (code === 'INVALID_DESIGN') {
    te.hint = 'Fix the design as the message says. Start from get_template_design if unsure of the shape.';
  } else if (code === 'SUBJECT_NOT_FOUND') {
    te.hint = 'Check the username/repository spelling; private repositories are not supported.';
  } else if (code === 'CARD_GENERATION_IN_PROGRESS' || code === 'NETWORK_ERROR') {
    te.hint =
      'The card may still be rendering (a first card can take minutes). Wait ~30s and repeat the identical call; it resumes the same card. Give up after 5 attempts.';
  } else if (code === 'CARD_GENERATION_FAILED') {
    te.hint =
      'Rendering failed on the server, not because of the request. Repeat the identical call at most twice; if it still fails, tell the user the renderer is having problems.';
  } else if (te.retryable) {
    te.hint = 'Temporary problem. Wait ~30s and repeat the identical call; give up after 5 attempts.';
  }
  return te;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fail(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(toToolError(error)) }], isError: true };
}

/** Run a handler, turning thrown errors into isError results. */
function guarded<A>(handler: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };
}

// --- Input schemas ------------------------------------------------------------

const cardInput = {
  subject: z
    .string()
    .describe('GitHub username (e.g. octocat) or owner/repo (e.g. octocat/hello-world)'),
  template: z
    .string()
    .optional()
    .describe("template id from list_templates; omit for the subject's default layout"),
  palette: z
    .string()
    .optional()
    .describe(
      "background palette id from list_palettes; omit for the template's own background. For any other colour use design"
    ),
  format: z
    .string()
    .optional()
    .describe('which link to return as url: "svg" (default; best for README embeds) or "png". Both are always in urls'),
  watermark: z.boolean().optional().describe('false removes the watermark (Pro only; ignored on Free)'),
  design: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'a design document from get_template_design or get_card_design, possibly edited; replaces template and palette'
    ),
};

type CardInput = {
  subject: string;
  template?: string | undefined;
  palette?: string | undefined;
  format?: string | undefined;
  watermark?: boolean | undefined;
  design?: Record<string, unknown> | undefined;
};

/** Turn create_card/validate_card input into an API request. */
export function cardRequest(input: CardInput): CardRequest {
  const { username, repo } = parseSubject(input.subject);
  const req: CardRequest = { username };
  if (repo) Object.assign(req, { type: 'repo', repo });
  if (input.template) req.template = input.template;
  if (input.palette) req.palette = input.palette;
  if (input.format) req.format = input.format;
  if (input.watermark !== undefined) req.watermark = input.watermark;
  if (input.design !== undefined) {
    if (input.template || input.palette) throw invalid('pass either design or template/palette, not both');
    req.design = input.design;
  }
  return req;
}

/** Build the server with its tools registered. */
export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'githubcard', title: 'GitHubCard', version: options.version },
    { instructions: INSTRUCTIONS }
  );
  const c = options.client;

  server.registerTool(
    'create_card',
    {
      title: 'Create GitHub card',
      description:
        'Create (or reuse) a published card image for a GitHub profile or repository. Returns svg/png URLs and markdown/html embed snippets. Idempotent; counts once against the daily quota.',
      inputSchema: cardInput,
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (input: CardInput) => ({ ...(await c.createCard(cardRequest(input))) }))
  );

  server.registerTool(
    'validate_card',
    {
      title: 'Check a card request',
      description:
        'Dry run of create_card with the same inputs: checks template/palette ids, Pro features and the design document, without creating anything or using quota. warnings lists layers that reach outside the artboard (they would be clipped); fix those before create_card.',
      inputSchema: cardInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (input: CardInput) => ({ ...(await c.validateCard(cardRequest(input))) }))
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List card templates',
      description:
        'List card layouts with their ids, scope (profile/repo/all), size, widget types, and whether they need Pro.',
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe('profile or repo; omit for all. Results include scope=all templates, which fit both'),
        freeOnly: z.boolean().optional().describe('only templates available on the Free plan'),
        widgets: z
          .array(z.string())
          .optional()
          .describe('only templates containing all of these widget types (from list_components)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (input: { scope?: string | undefined; freeOnly?: boolean | undefined; widgets?: string[] | undefined }) => {
      if (input.scope && input.scope !== 'profile' && input.scope !== 'repo') {
        throw invalid('scope must be "profile" or "repo"');
      }
      let templates = await c.templates(input.scope ?? '');
      if (input.freeOnly) templates = templates.filter(t => !t.pro);
      if (input.widgets?.length) templates = templates.filter(t => hasAllWidgets(t.widgets ?? [], input.widgets!));
      return { templates };
    })
  );

  server.registerTool(
    'list_palettes',
    {
      title: 'List background palettes',
      description: 'List background palette ids accepted by create_card.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => ({ palettes: (await c.palettes()).palettes }))
  );

  server.registerTool(
    'list_components',
    {
      title: 'List widget types',
      description: 'List the widget (layer) types a design can contain, with the scope (profile/repo) each fits.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => ({ components: await c.components() }))
  );

  server.registerTool(
    'get_template_design',
    {
      title: "Get a template's design",
      description:
        "Return a template's layout as an editable design document (artboard + layers). Costs no quota. Edit it and pass it to create_card as design.",
      inputSchema: {
        template: z.string().describe('template id from list_templates'),
        subject: z
          .string()
          .optional()
          .describe('username or owner/repo the card is for; decides profile vs repo layouts'),
        palette: z
          .string()
          .optional()
          .describe("palette id to apply; replaces the template's background in the returned design"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (input: { template: string; subject?: string | undefined; palette?: string | undefined }) => {
      if (!input.template?.trim()) throw invalid('template is required');
      const { username, repo } = input.subject ? parseSubject(input.subject) : { username: '', repo: '' };
      return { design: await c.templateDesign(input.template, username, repo, input.palette ?? '') };
    })
  );

  const idInput = { id: z.string().describe('card id from create_card or list_cards') };

  server.registerTool(
    'get_card_design',
    {
      title: "Get a card's design",
      description:
        "Return the design document of one of the account's cards, to edit and re-submit through create_card as design (which creates a new card; the original is unchanged).",
      inputSchema: idInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (input: { id: string }) => {
      if (!input.id?.trim()) throw invalid('id is required');
      return { design: await c.cardDesign(input.id) };
    })
  );

  server.registerTool(
    'list_cards',
    {
      title: 'List my cards',
      description:
        'List cards this account created through the API, most recently requested first. Paginated with nextCursor.',
      inputSchema: {
        limit: z.number().int().optional().describe('page size 1-100 (default 20)'),
        cursor: z.string().optional().describe('nextCursor from a previous call'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (input: { limit?: number | undefined; cursor?: string | undefined }) => ({
      ...(await c.listCards(input.limit ?? 0, input.cursor ?? '')),
    }))
  );

  server.registerTool(
    'delete_card',
    {
      title: 'Delete a card',
      description:
        "Permanently delete one of the account's cards. Its links stop working everywhere they are embedded. Confirm with the user first.",
      inputSchema: idInput,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (input: { id: string }) => {
      if (!input.id?.trim()) throw invalid('id is required');
      await c.deleteCard(input.id);
      return { deleted: input.id };
    })
  );

  server.registerTool(
    'get_usage',
    {
      title: 'Get plan and quota',
      description:
        "Show the account's plan (free/pro) and how many cards it can still create today (cards.remaining, resets 00:00 UTC). The ai quota is reserved for future AI tools.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => ({ ...(await c.usage()) }))
  );

  if (options.allowFileWrites) {
    server.registerTool(
      'update_readme',
      {
        title: 'Insert card into README',
        description:
          'Insert or replace a card snippet in a local Markdown file between <!-- ghcard:… --> markers. Re-running replaces the block instead of duplicating it.',
        inputSchema: {
          path: z
            .string()
            .describe(
              "path to the Markdown file; relative paths resolve against the MCP server's working directory, so prefer an absolute path"
            ),
          subject: z
            .string()
            .describe("the card's subject (username or owner/repo); used to find an existing block"),
          snippet: z
            .string()
            .describe(
              "the embed.markdown value returned by create_card. A new block goes after the file's first heading (or at the top); an existing block for the subject is replaced"
            ),
        },
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      guarded(async (input: { path: string; subject: string; snippet: string }) => {
        if (!input.path || !input.snippet || !input.subject) throw invalid('path, subject, and snippet are required');
        if (!input.path.toLowerCase().endsWith('.md')) throw invalid('only Markdown (.md) files can be edited');
        try {
          const edit = await upsertBlock(input.path, markerId(input.subject), input.snippet);
          return { path: input.path, edit };
        } catch (error) {
          throw new ToolFailure({ code: 'FILE_ERROR', message: (error as Error).message, retryable: false });
        }
      })
    );
  }

  return server;
}
