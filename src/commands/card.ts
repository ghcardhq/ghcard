import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import type { Card, CardRequest, CreatedCard } from '../api.js';
import { markerId, upsertBlock } from '../readme.js';
import { table, UsageError } from '../output.js';
import type { App } from '../app.js';
import { parseSubjectArg } from './shared.js';
import { readDesign } from './design.js';

interface CardOptions {
  template?: string;
  palette?: string;
  format: string;
  embed?: string;
  output?: string;
  readme?: string;
  design?: string;
  watermark: boolean;
  snapshot?: boolean;
  dryRun?: boolean;
}

export function registerCreate(program: Command, app: App): void {
  program
    .command('create')
    .helpGroup('Cards:')
    .summary('Create a card for a user or repo and print its links')
    .argument('<subject>', 'user or owner/repo (a GitHub URL also works)')
    .description(
      `Create a card for a GitHub profile or repository, or reuse the identical one,
and print its link.

The request is idempotent: the same subject, template, palette and watermark
setting always return the same card and link, so it is safe to run in CI on
every push. Each call counts once against the daily card quota.

Links are live by default: they re-render with current GitHub data. Use
--snapshot for the immutable image captured when the card was created.

--format picks which link is printed and which image --output saves (svg by
default). --readme embeds the card's Markdown, which uses the live SVG link
(the frozen one with --snapshot). All flags combine; one call costs one
quota unit.

Without --template the subject's default layout is used. --design publishes a
custom layout instead (see 'ghcard design'); Pro fonts and backgrounds in it
need Pro. Free accounts always get the watermark; --no-watermark needs Pro.`
    )
    .option('-t, --template <id>', "layout id (see `ghcard templates`; default: the subject's default layout)")
    .option('-p, --palette <id>', "background palette id (see `ghcard palettes`; default: the template's own)")
    .option('-f, --format <format>', 'link format to print and download: svg or png', 'svg')
    .option('-e, --embed <kind>', 'print only a snippet: markdown, html, or url')
    .option('-o, --output <file>', 'also download the image to this file')
    .option('--readme <file>', "insert or update the card's Markdown in this file")
    .option('-d, --design <file>', 'publish this design file ("-" for stdin) instead of a template')
    .option('--no-watermark', 'remove the watermark (Pro)')
    .option('--snapshot', 'use the frozen image links instead of live ones')
    .option('--dry-run', 'check the request (ids, Pro features, design) without creating a card or using quota')
    .addHelpText(
      'after',
      `
Examples:
  ghcard create octocat
  ghcard create octocat/hello-world --template repo-dark-terminal
  ghcard create octocat --palette sage --embed markdown
  ghcard create octocat --format png --output card.png
  ghcard create octocat --readme README.md
  ghcard create octocat --design design.json --dry-run
  ghcard create octocat --design design.json
`
    )
    .action(async (subjectArg: string, opts: CardOptions) => {
      const { username, repo } = parseSubjectArg(subjectArg);
      if (opts.format !== 'svg' && opts.format !== 'png') throw new UsageError('--format must be svg or png');
      if (opts.embed && !['markdown', 'html', 'url'].includes(opts.embed)) {
        throw new UsageError('--embed must be markdown, html, or url');
      }

      const req: CardRequest = { username, format: opts.format };
      if (repo) Object.assign(req, { type: 'repo', repo });
      if (opts.template) req.template = opts.template;
      if (opts.palette) req.palette = opts.palette;
      if (opts.design) {
        if (opts.template || opts.palette) {
          throw new UsageError('--design cannot be combined with --template or --palette');
        }
        req.design = await readDesign(app, opts.design);
      }
      if (!opts.watermark) req.watermark = false;

      const client = await app.client();
      if (opts.dryRun) {
        const checked = await client.validateCard(req);
        app.printer.success(checked, w => {
          w.write(
            `Valid: template ${checked.template}, ${checked.artboard.width}x${checked.artboard.height}, ` +
              `${checked.layers} layers, watermark ${checked.watermark}. Nothing was created.\n`
          );
          for (const warning of checked.warnings ?? []) w.write(`  Warning: ${warning}\n`);
        });
        return;
      }

      app.printer.info(`Generating card for ${subjectArg}…`);
      const card = await client.createCard(req);
      if (!opts.watermark && card.watermark) app.printer.info('Note: the watermark stays on for Free accounts.');
      if (opts.snapshot) useSnapshotLinks(card, opts.format);

      const result: CreatedCard & {
        output?: string;
        readmePath?: string;
        readmeEdit?: string;
        warnings?: string[];
      } = { ...card };
      const warnings: string[] = [];
      if (opts.output) {
        // The card exists and costs quota already; a failed download must not
        // hide it or skip the README update.
        try {
          const body = await client.download(card.url);
          try {
            await writeFile(opts.output, body, { mode: 0o644 });
            result.output = opts.output;
          } catch (error) {
            warnings.push(`write ${opts.output}: ${(error as Error).message}`);
          }
        } catch (error) {
          warnings.push(`download failed (${(error as Error).message}); fetch ${card.url} later`);
        }
      }
      if (opts.readme) {
        const edit = await upsertBlock(opts.readme, markerId(card.subject), card.embed.markdown);
        result.readmePath = opts.readme;
        result.readmeEdit = edit;
      }
      if (warnings.length > 0) result.warnings = warnings;

      app.printer.success(result, w => {
        if (opts.embed === 'markdown') return void w.write(`${card.embed.markdown}\n`);
        if (opts.embed === 'html') return void w.write(`${card.embed.html}\n`);
        if (opts.embed === 'url') return void w.write(`${card.url}\n`);
        w.write(`${card.created ? 'Created' : 'Reused'} card ${card.id} for ${card.subject} (template ${card.template})\n`);
        w.write(`  SVG       ${card.urls.svg}\n`);
        w.write(`  PNG       ${card.urls.png}\n`);
        w.write(`  Markdown  ${card.embed.markdown}\n`);
        w.write(`  Edit      ${card.editUrl}\n`);
        if (result.output) w.write(`  Saved     ${resolvePath(result.output)}\n`);
        if (result.readmePath) w.write(`  README    ${result.readmePath} (${result.readmeEdit})\n`);
        for (const warning of warnings) w.write(`  Warning   ${warning}\n`);
        w.write(`Quota: ${card.usage.remaining} of ${card.usage.limit} cards left today\n`);
      });
    });
}

/** Swap every link for the immutable publication captured now. */
function useSnapshotLinks(card: CreatedCard, format: string): void {
  card.urls = card.snapshotUrls;
  card.url = format === 'png' ? card.snapshotUrls.png : card.snapshotUrls.svg;
  const alt = `GitHubCard for ${card.subject}`;
  const href = `https://github.com/${card.subject}`;
  card.embed = {
    markdown: `[![${alt}](${card.snapshotUrls.svg})](${href})`,
    html: `<a href="${href}"><img src="${card.snapshotUrls.svg}" alt="${alt}"></a>`,
  };
}

export function registerList(program: Command, app: App): void {
  program
    .command('list')
    .alias('ls')
    .helpGroup('Cards:')
    .summary('List the cards you created')
    .description('List the cards you created, most recently requested first.')
    .option('-n, --limit <n>', 'cards per page (1-100)', value => Number.parseInt(value, 10), 20)
    .option('--cursor <cursor>', 'continue from a previous page')
    .option('--all', 'fetch every page')
    .action(async (opts: { limit: number; cursor?: string; all?: boolean }) => {
      if (!Number.isInteger(opts.limit)) throw new UsageError('--limit must be a number');
      const client = await app.client();
      const all: Card[] = [];
      let cursor = opts.cursor ?? '';
      let next: string | null = null;
      for (;;) {
        const page = await client.listCards(opts.limit, cursor);
        all.push(...page.cards);
        next = page.nextCursor;
        if (!opts.all || next === null) break;
        cursor = next;
      }
      app.printer.success({ cards: all, nextCursor: next }, w => {
        if (all.length === 0) {
          w.write('No cards yet. Create one with `ghcard create <user>`.\n');
          return;
        }
        table(w, ['ID', 'SUBJECT', 'TEMPLATE', 'SVG'], all.map(c => [c.id, c.subject, c.template, c.urls.svg]));
        if (next !== null) w.write(`\nMore: ghcard list --cursor ${next} (or --all)\n`);
      });
    });
}

export function registerDelete(program: Command, app: App): void {
  program
    .command('delete')
    .alias('rm')
    .helpGroup('Cards:')
    .argument('<card-id...>', 'one or more card ids')
    .summary('Delete cards; their links stop working')
    .description(
      'Delete cards. Their links stop working everywhere they are embedded.\nAsks for confirmation on a terminal; pass --yes in scripts.'
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ids: string[], opts: { yes?: boolean }) => {
      if (!opts.yes && !app.printer.json) {
        app.options.stderr.write(`Delete ${ids.join(', ')}? Embedded links will break. [y/N] `);
        const answer = (await app.readLine()) ?? '';
        if (answer.trim().toLowerCase() !== 'y') throw new UsageError('cancelled');
      } else if (!opts.yes) {
        throw new UsageError('deleting without a terminal requires --yes');
      }
      const client = await app.client();
      for (const id of ids) await client.deleteCard(id);
      app.printer.success({ deleted: ids }, w => w.write(`Deleted ${ids.join(', ')}\n`));
    });
}
