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
  verbose?: boolean;
}

export function registerCreate(program: Command, app: App): void {
  program
    .command('create')
    .helpGroup('Cards:')
    .summary('Create a card for a user or repo and print its links')
    .argument('<subject>', 'user or owner/repo (a GitHub URL also works)')
    .description(
      `Create a card for a GitHub profile or repository and print its README snippet.

Running it again with the same options returns the same card and link, so it is
safe in CI. Each run counts once against the daily quota; the flags combine in
one run. Links show live GitHub data; --snapshot gives a frozen image instead.`
    )
    .option('-t, --template <id>', 'layout id from `ghcard templates` (default: the subject\'s own)')
    .option('-p, --palette <id>', 'background id from `ghcard palettes`')
    .option('-d, --design <file>', 'use a design file from `ghcard design` ("-" for stdin)')
    .option('--readme <file>', 'insert or update the card in this Markdown file')
    .option('-o, --output <file>', 'also save the image to this file')
    .option('-f, --format <format>', 'image format for the link and --output: svg or png', 'svg')
    .option('-e, --embed <kind>', 'print only this: markdown, html, or url')
    .option('--snapshot', 'link to a frozen image instead of the live one')
    .option('--no-watermark', 'remove the watermark (Pro)')
    .option('--dry-run', 'check the request without creating a card or using quota')
    .option('--verbose', 'also print the SVG, PNG and HTML links')
    .addHelpText(
      'after',
      `
Examples:
  ghcard create octocat --readme README.md          # add it to a README
  ghcard create octocat/hello-world -t repo-og-compact
  ghcard create octocat -f png -o card.png          # save a PNG
  ghcard create octocat --design design.json --dry-run
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

      const client = await app.authedClient();
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
        w.write(`${card.created ? 'Created' : 'Reused'} card for ${card.subject} (${card.template})\n\n`);
        if (result.readmePath) {
          w.write(`  ${readmeVerb(result.readmeEdit)} ${result.readmePath}\n`);
        } else {
          w.write(`  ${card.embed.markdown}\n`);
        }
        w.write('\n');
        if (opts.verbose) {
          w.write(`  SVG   ${card.urls.svg}\n`);
          w.write(`  PNG   ${card.urls.png}\n`);
          w.write(`  HTML  ${card.embed.html}\n`);
          w.write(`  ID    ${card.id}\n`);
        }
        w.write(`  Edit  ${card.editUrl}\n`);
        if (result.output) w.write(`  Saved ${resolvePath(result.output)}\n`);
        for (const warning of warnings) w.write(`  Warning: ${warning}\n`);
        w.write(`\n${card.usage.remaining} of ${card.usage.limit} cards left today.`);
        w.write(opts.verbose ? '\n' : ' --verbose shows the image links.\n');
      });
    });
}

function readmeVerb(edit: string | undefined): string {
  if (edit === 'created') return 'Created';
  if (edit === 'unchanged') return 'Already up to date:';
  if (edit === 'updated') return 'Updated';
  return 'Added to';
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
      const client = await app.authedClient();
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
      const client = await app.authedClient();
      for (const id of ids) await client.deleteCard(id);
      app.printer.success({ deleted: ids }, w => w.write(`Deleted ${ids.join(', ')}\n`));
    });
}
