/**
 * The ghcard command tree.
 *
 * `run` takes its streams, environment and fetch as arguments so tests drive
 * the real commands without touching the user's terminal or config.
 */
import { Command, CommanderError } from 'commander';
import { Client, DEFAULT_BASE_URL } from './api.js';
import { resolveConfig, type Resolved } from './config.js';
import { Exit, Printer, UsageError, type Writer } from './output.js';
import { registerAuth } from './commands/auth.js';
import { registerCard, registerCards } from './commands/card.js';
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

function buildProgram(app: App): Command {
  const program = new Command('ghcard')
    .description(
      `ghcard turns a GitHub username or repository into an embeddable card image.

  ghcard card octocat                    # profile card, prints the link
  ghcard card octocat/hello-world        # repository card
  ghcard card octocat --embed markdown   # print a README snippet
  ghcard card octocat --readme README.md # insert or update it in a README

Output is human-readable on a terminal and JSON when piped or with --json.
Commands that create cards need an API key: create one at
https://githubcard.com/dashboard, then run 'ghcard auth login'.`
    )
    .version(`ghcard version ${VERSION}`, '-v, --version')
    .option('--json', 'write JSON to stdout (default when stdout is not a terminal)')
    .option('--api-key <key>', 'API key (overrides $GHCARD_API_KEY and the config file)')
    .option('--base-url <url>', 'API origin (default https://githubcard.com)')
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

  registerCard(program, app);
  registerCards(program, app);
  registerDesign(program, app);
  registerOpen(program, app);
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
  return program;
}

function allCommands(command: Command): Command[] {
  return command.commands.flatMap(child => [child, ...allCommands(child)]);
}

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
      // `ghcard` alone prints help and exits like `--help`.
      if (error.code === 'commander.executeSubCommandAsync' || error.exitCode === 0) return Exit.OK;
      // Flag parsing failed before preAction ran, so honour --json by hand.
      if (options.argv.includes('--json')) app.printer.json = true;
      return app.printer.failure(new UsageError(error.message.replace(/^error: /, '')));
    }
    return app.printer.failure(error);
  }
}
