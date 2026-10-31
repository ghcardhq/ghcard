/**
 * The ghcard command tree.
 *
 * `run` takes its streams, environment and fetch as arguments so tests drive
 * the real commands without touching the user's terminal or config.
 */
import { type Argument, Command, CommanderError, Help } from 'commander';
import { Client, DEFAULT_BASE_URL } from './api.js';
import { resolveConfig, type Resolved } from './config.js';
import { Exit, Printer, UsageError, type Writer } from './output.js';
import { registerAuth } from './commands/auth.js';
import { registerCreate, registerDelete, registerList } from './commands/card.js';
import { registerCatalogue } from './commands/catalogue.js';
import { registerDesign, registerOpen } from './commands/design.js';
import { registerMcp } from './commands/mcp.js';

declare const __GHCARD_VERSION__: string;
export const VERSION: string = typeof __GHCARD_VERSION__ === 'string' ? __GHCARD_VERSION__ : 'dev';

export interface Stream extends Writer {
  isTTY?: boolean;
}

export interface InputStream extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean;
}

export interface RunOptions {
  argv: string[];
  stdout: Stream;
  stderr: Stream;
  stdin: InputStream;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Opens a URL in the browser; injectable for tests. */
  openUrl?: (url: string) => Promise<void>;
}

/** Shared state for one invocation. */
export class App {
  printer: Printer;
  flags: { json: boolean; apiKey?: string; baseUrl?: string } = { json: false };

  constructor(readonly options: RunOptions) {
    this.printer = new Printer(!options.stdout.isTTY, options.stdout, options.stderr);
  }

  get userAgent(): string {
    return `ghcard-cli/${VERSION}`;
  }

  resolve(): Promise<Resolved> {
    return resolveConfig({ apiKey: this.flags.apiKey, baseUrl: this.flags.baseUrl }, DEFAULT_BASE_URL, this.options.env);
  }

  async client(): Promise<Client> {
    const r = await this.resolve();
    return this.clientFor(r.baseUrl, r.apiKey);
  }

  clientFor(baseUrl: string, apiKey: string): Client {
    return new Client({ baseUrl, apiKey, userAgent: this.userAgent, fetch: this.options.fetch });
  }

  /** Read all of stdin, up to `limit` bytes. */
  async readStdin(limit = 4 << 20): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.options.stdin) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      chunks.push(buffer);
      if (size >= limit) break;
    }
    return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
  }

  /** Read one line from stdin. */
  async readLine(): Promise<string | null> {
    let text = '';
    for await (const chunk of this.options.stdin) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline >= 0) return text.slice(0, newline);
    }
    return text === '' ? null : text;
  }
}

/**
 * Help in the order people read it: what the command does, how to call it,
 * its subcommands, then flags. Commander's default puts Usage first and
 * subcommands last, after every flag.
 */
class GhcardHelp extends Help {
  override subcommandTerm(sub: Command): string {
    return subcommandTerm(sub);
  }

  override formatHelp(cmd: Command, helper: Help): string {
    const width = helper.padWidth(cmd, helper);
    const item = (term: string, description: string) => helper.formatItem(term, width, description, helper);
    const lines: string[] = [];

    const description = helper.commandDescription(cmd);
    if (description) lines.push(helper.boxWrap(description, helper.helpWidth ?? 80), '');
    lines.push(`Usage:\n  ${helper.commandUsage(cmd)}`, '');

    const commands = this.groupItems([...cmd.commands], helper.visibleCommands(cmd), sub => sub.helpGroup() || 'Commands:');
    for (const [group, list] of commands) {
      lines.push(...this.formatItemList(group, list.map(sub => item(helper.subcommandTerm(sub), helper.subcommandDescription(sub))), helper));
    }

    const args = (visibleArguments(cmd).length ? helper.visibleArguments(cmd) : []).map(a => item(helper.argumentTerm(a), helper.argumentDescription(a)));
    lines.push(...this.formatItemList('Arguments:', args, helper));

    const options = helper.visibleOptions(cmd).map(o => item(helper.optionTerm(o), helper.optionDescription(o)));
    lines.push(...this.formatItemList('Options:', options, helper));

    const globals = helper.showGlobalOptions
      ? helper.visibleGlobalOptions(cmd).map(o => item(helper.optionTerm(o), helper.optionDescription(o)))
      : [];
    lines.push(...this.formatItemList('Global options:', globals, helper));

    return lines.join('\n');
  }
}

/** Every ghcard command, at any depth, uses GhcardHelp. */
class GhcardCommand extends Command {
  override createCommand(name?: string): GhcardCommand {
    return new GhcardCommand(name);
  }

  override createHelp(): Help {
    return Object.assign(new GhcardHelp(), this.configureHelp());
  }
}

/** A command group's catch-all `[command...]` is plumbing, not an argument. */
function visibleArguments(cmd: Command): readonly Argument[] {
  return cmd.commands.length > 0 ? [] : cmd.registeredArguments;
}

/**
 * List subcommands as "name <args>" without "[options]": every command takes
 * -h, so the marker adds width and nothing else.
 */
function subcommandTerm(sub: Command): string {
  const args = visibleArguments(sub).map(a => (a.required ? `<${a.name()}${a.variadic ? '...' : ''}>` : `[${a.name()}${a.variadic ? '...' : ''}]`));
  const aliases = sub.aliases();
  return [sub.name() + (aliases.length ? `|${aliases.join('|')}` : ''), ...args].join(' ');
}

function buildProgram(app: App): Command {
  const program = new GhcardCommand('ghcard')
    .description(
      `ghcard turns a GitHub username or repository into an embeddable card image.

Output is human-readable on a terminal and JSON when piped or with --json.
Commands that create cards need an API key: create one at
https://githubcard.com/dashboard, then run 'ghcard auth login'.`
    )
    .usage('<command> [options]')
    .version(`ghcard version ${VERSION}`, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help for a command')
    .helpCommand(false)
    .option('--json', 'write JSON to stdout (default when stdout is not a terminal)')
    .option('--api-key <key>', 'API key (overrides $GHCARD_API_KEY and the config file)')
    .option('--base-url <url>', 'API origin (default https://githubcard.com)')
    .addHelpText(
      'after',
      `
Examples:
  ghcard create octocat                     # profile card; prints its links
  ghcard create octocat/hello-world         # repository card
  ghcard create octocat --embed markdown    # just the README snippet
  ghcard create octocat --readme README.md  # insert or update it in a README

Run 'ghcard <command> --help' for details on a command.`
    )
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: text => app.options.stdout.write(text),
      // Commander's own error text is replaced by the envelope below.
      writeErr: () => undefined,
      outputError: () => undefined,
    })
    .hook('preAction', () => {
      const opts = program.opts<{ json?: boolean; apiKey?: string; baseUrl?: string }>();
      app.flags = { json: Boolean(opts.json), apiKey: opts.apiKey, baseUrl: opts.baseUrl };
      app.printer.json = app.flags.json || !app.options.stdout.isTTY;
    });

  registerCreate(program, app);
  registerList(program, app);
  registerDelete(program, app);
  registerOpen(program, app);
  registerDesign(program, app);
  registerCatalogue(program, app);
  registerAuth(program, app);
  registerMcp(program, app);

  // Subcommands inherit exitOverride and output routing.
  for (const command of allCommands(program)) {
    command.exitOverride().configureOutput({
      writeOut: text => app.options.stdout.write(text),
      writeErr: () => undefined,
      outputError: () => undefined,
    });
  }
  // `ghcard` or `ghcard auth` alone shows that command's help, like `--help`;
  // anything else that is not a subcommand is an unknown-command error.
  for (const command of [program, ...allCommands(program)]) {
    if (command.commands.length === 0) continue;
    command
      .usage('<command> [options]')
      .argument('[command...]')
      .allowUnknownOption()
      .action(([name]: string[]) => {
        if (name === undefined || name === 'help') return command.help();
        const known = command.commands.flatMap(sub => [sub.name(), ...sub.aliases()]);
        const close = RENAMED[name] ?? known.find(n => n.startsWith(name.slice(0, 3)));
        const hint = close ? ` (did you mean '${close}'?)` : '';
        throw new UsageError(`unknown command '${name}'${hint}`);
      });
  }
  return program;
}

function allCommands(command: Command): Command[] {
  return command.commands.flatMap(child => [child, ...allCommands(child)]);
}

/** Command names from before 0.1.0, pointed at their replacements. */
const RENAMED: Record<string, string> = { card: 'create', cards: 'list' };

/** Run the CLI and return the process exit code. */
export async function run(options: RunOptions): Promise<number> {
  const app = new App(options);
  const program = buildProgram(app);
  try {
    await program.parseAsync(options.argv, { from: 'user' });
    return Exit.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      ) {
        return Exit.OK;
      }
      // Flag parsing failed before preAction ran, so honour --json by hand.
      if (options.argv.includes('--json')) app.printer.json = true;
      return app.printer.failure(new UsageError(error.message.replace(/^error: /, '')));
    }
    return app.printer.failure(error);
  }
}
