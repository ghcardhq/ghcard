import type { Command } from 'commander';
import { hasAllWidgets } from '../subject.js';
import { table, UsageError } from '../output.js';
import type { App } from '../app.js';

function collect(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(',').map(v => v.trim()).filter(Boolean)];
}

export function registerCatalogue(program: Command, app: App): void {
  program
    .command('templates')
    .description('List card layouts (ids for --template)')
    .option('-s, --scope <scope>', 'only templates for profile or repo cards')
    .option('--free', 'only templates available on the Free plan')
    .option('-w, --widget <types>', 'only templates containing these widget types (see `ghcard components`)', collect, [])
    .action(async (opts: { scope?: string; free?: boolean; widget: string[] }) => {
      if (opts.scope && opts.scope !== 'profile' && opts.scope !== 'repo') {
        throw new UsageError('--scope must be profile or repo');
      }
      const client = await app.client();
      let templates = await client.templates(opts.scope ?? '');
      if (opts.free) templates = templates.filter(t => !t.pro);
      if (opts.widget.length > 0) templates = templates.filter(t => hasAllWidgets(t.widgets ?? [], opts.widget));
      app.printer.success(templates, w => {
        table(
          w,
          ['ID', 'SCOPE', 'SIZE', 'PLAN', 'NAME'],
          templates.map(t => [t.id, t.scope, `${t.size.width}x${t.size.height}`, t.pro ? 'pro' : 'free', t.name])
        );
      });
    });

  program
    .command('palettes')
    .description('List background palettes (ids for --palette)')
    .action(async () => {
      const palettes = await (await app.client()).palettes();
      app.printer.success(palettes, w => {
        table(w, ['ID', 'KIND', 'NAME'], palettes.palettes.map(p => [p.id, p.kind, p.name]));
        if (palettes.proBackgrounds?.length) {
          w.write(`\nPro adds ${palettes.proBackgrounds.length} more backgrounds in the web editor.\n`);
        }
      });
    });

  program
    .command('components')
    .description('List the widget types a card can contain')
    .action(async () => {
      const components = await (await app.client()).components();
      app.printer.success(components, w => {
        table(w, ['TYPE', 'SCOPE', 'DESCRIPTION'], components.map(c => [c.type, c.scope, c.description]));
      });
    });

  program
    .command('usage')
    .description("Show your plan and today's card quota")
    .action(async () => {
      const account = await (await app.client()).usage();
      app.printer.success(account, w => {
        w.write(`Account  ${account.username} (${account.tier})\n`);
        w.write(`Cards    ${account.cards.used} of ${account.cards.limit} used today, resets ${account.cards.resetAt}\n`);
        w.write(
          `Plan     verified until ${account.tierExpiresAt}; visit https://githubcard.com/dashboard to renew\n`
        );
      });
    });
}
