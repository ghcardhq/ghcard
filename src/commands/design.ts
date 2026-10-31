import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { UsageError } from '../output.js';
import type { App } from '../app.js';
import { parseSubjectArg } from './shared.js';

export function registerDesign(program: Command, app: App): void {
  const design = program
    .command('design')
    .helpGroup('Cards:')
    .summary('Start or export a design document (layout JSON)')
    .description(
      `Work with card design documents (layout JSON).

A design document is the JSON the web editor saves: the artboard (size,
background, fonts, colours) and its layers (widgets with position, size and
settings). Start from a template or an existing card, edit the JSON, then
publish it with 'ghcard create <subject> --design design.json'.

Use a design when a template plus --palette is not enough: any hex background,
other fonts or colours, a different size, or adding/removing/moving widgets.

Editing rules:
  - The subject in a design file is ignored: the create command's argument
    decides whose data the card shows.
  - Layers are absolutely positioned (x, y, width, height). Removing one leaves
    its space empty; move or resize the others to fill it.
  - Each layer needs a unique "id" and a "type" from 'ghcard components';
    "layer" is only the stacking order and need not be contiguous.
  - artboard.showWatermark is decided by the server (Free: always on).
  - On Free, Pro fonts and backgrounds fail with PRO_FEATURE; fonts and
    backgrounds that free templates already use are fine.`
    )
    .addHelpText(
      'after',
      `
Examples:
  ghcard design init social -o design.json
  ghcard design init repo-og-compact --subject octocat/hello-world -o design.json
  ghcard design get <card-id> -o design.json
  ghcard create octocat --design design.json
`
    );

  design
    .command('init')
    .argument('<template>', 'template id from `ghcard templates`')
    .description("Write a template's layout as a design file (no key, no quota)")
    .option('--subject <subject>', 'user or owner/repo; picks the default background (default octocat)')
    .option('-p, --palette <id>', 'apply a background palette id')
    .option('-o, --output <file>', 'write to this file instead of stdout')
    .action(async (template: string, opts: { subject?: string; palette?: string; output?: string }) => {
      const { username, repo } = opts.subject ? parseSubjectArg(opts.subject) : { username: '', repo: '' };
      const doc = await (await app.client()).templateDesign(template, username, repo, opts.palette ?? '');
      await writeDesign(app, doc, opts.output);
    });

  design
    .command('get')
    .argument('<card-id>', 'card id from `ghcard list`')
    .description('Print the design of one of your cards')
    .option('-o, --output <file>', 'write to this file instead of stdout')
    .action(async (id: string, opts: { output?: string }) => {
      const doc = await (await app.client()).cardDesign(id);
      await writeDesign(app, doc, opts.output);
    });
}

/**
 * Save a design to a file, or print it. On stdout the design is the data
 * itself (wrapped in the JSON envelope only with an explicit --json), so it can
 * be redirected to a file either way.
 */
async function writeDesign(app: App, doc: Record<string, unknown>, path: string | undefined): Promise<void> {
  const pretty = `${JSON.stringify(doc, null, 2)}\n`;
  if (!path) {
    if (app.printer.json && !app.flags.json) {
      // Piped without --json: emit the bare document for `> file`.
      app.options.stdout.write(pretty);
      return;
    }
    app.printer.success(doc, w => w.write(pretty));
    return;
  }
  try {
    await writeFile(path, pretty, { mode: 0o644 });
  } catch (error) {
    throw new Error(`write ${path}: ${(error as Error).message}`);
  }
  app.printer.success({ output: path }, w => {
    w.write(`Wrote ${path}\nPublish it with: ghcard create <user | owner/repo> --design ${path}\n`);
  });
}

/** Load a design file ("-" for stdin) and check it is a JSON object. */
export async function readDesign(app: App, path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = path === '-' ? await app.readStdin() : await readFile(path, 'utf8');
  } catch (error) {
    throw new UsageError(`read design: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`${path} is not a JSON design object: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${path} is not a JSON design object`);
  }
  return parsed as Record<string, unknown>;
}

export function registerOpen(program: Command, app: App): void {
  program
    .command('open')
    .helpGroup('Cards:')
    .argument('<card-id>', 'card id from `ghcard list`')
    .description('Open one of your cards in the web editor')
    .option('--print', 'print the editor link without opening a browser')
    .action(async (id: string, opts: { print?: boolean }) => {
      const card = await (await app.client()).getCard(id);
      if (!opts.print && !app.printer.json && app.options.openUrl) {
        try {
          await app.options.openUrl(card.editUrl);
        } catch (error) {
          app.printer.info(`Could not open a browser: ${(error as Error).message}`);
        }
      }
      app.printer.success({ id: card.id, editUrl: card.editUrl }, w => w.write(`${card.editUrl}\n`));
    });
}
