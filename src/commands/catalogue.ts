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
    .helpGroup('Catalogue (no key needed):')
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
    .helpGroup('Catalogue (no key needed):')
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
    .helpGroup('Catalogue (no key needed):')
    .description('List the widget types a card can contain, their settings, and fonts')
    .argument('[type]', 'show the settings of one widget type')
    .action(async (type: string | undefined) => {
      const { components, fonts } = await (await app.client()).components();
      if (type) {
        const component = components.find(c => c.type === type);
        if (!component) throw new UsageError(`unknown widget type "${type}"; run \`ghcard components\``);
        app.printer.success(component, w => {
          w.write(`${component.type} (${component.scope}): ${component.description}\n`);
          if (!component.options?.length) return void w.write('No settings beyond x, y, width, height.\n');
          w.write('\n');
          table(
            w,
            ['SETTING', 'TYPE', 'DESCRIPTION'],
            component.options.map(o => [o.name, o.values ? o.values.join('|') : o.type, o.description])
          );
        });
        return;
      }
      app.printer.success({ components, fonts }, w => {
        table(w, ['TYPE', 'SCOPE', 'DESCRIPTION'], components.map(c => [c.type, c.scope, c.description]));
        if (fonts.length) {
          w.write('\nFonts (style.fontFamily):\n');
          table(w, ['VALUE', 'PLAN'], fonts.map(f => [f.value, f.pro ? 'pro' : 'free']));
        }
        w.write('\nRun `ghcard components <type>` for a widget\'s settings.\n');
      });
    });

  program
    .command('usage')
    .helpGroup('Account and agents:')
    .description("Show your plan and today's card quota")
    .action(async () => {
      const account = await (await app.authedClient()).usage();
      app.printer.success(account, w => {
        w.write(`Account  ${account.username} (${account.tier})\n`);
        w.write(`Cards    ${account.cards.used} of ${account.cards.limit} used today, resets ${account.cards.resetAt}\n`);
        w.write(
          `Plan     verified until ${account.tierExpiresAt}; visit https://githubcard.com/dashboard to renew\n`
        );
      });
    });
}
