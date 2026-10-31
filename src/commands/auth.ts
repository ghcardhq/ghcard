import type { Command } from 'commander';
import { NoApiKeyError } from '../api.js';
import { configPath, loadConfig, maskKey, saveConfig } from '../config.js';
import { UsageError } from '../output.js';
import type { App } from '../app.js';

export function registerAuth(program: Command, app: App): void {
  const auth = program.command('auth').description('Store, check, or remove your API key');

  auth
    .command('login')
    .description(
      `Save an API key so later commands can use it.

Create a key at https://githubcard.com/dashboard. The key is read from a
prompt, or from stdin with --with-token (so it never appears in shell
history), and is checked against the API before it is saved.`
    )
    .option('--with-token', 'read the key from stdin')
    .addHelpText('after', '\nExamples:\n  ghcard auth login\n  echo "$KEY" | ghcard auth login --with-token\n')
    .action(async (opts: { withToken?: boolean }) => {
      if (!opts.withToken && app.options.stdin.isTTY) {
        app.options.stderr.write('Paste your API key (from https://githubcard.com/dashboard): ');
      }
      const line = await app.readLine();
      if (line === null && (opts.withToken || !app.options.stdin.isTTY)) {
        throw new UsageError('no key on stdin');
      }
      const key = (line ?? '').trim();
      if (!key.startsWith('ghc_live_')) {
        throw new UsageError('that does not look like a GitHubCard API key (it should start with ghc_live_)');
      }

      const r = await app.resolve();
      const account = await app.clientFor(r.baseUrl, key).usage();

      const file = await loadConfig(app.options.env);
      file.apiKey = key;
      if (app.flags.baseUrl) file.baseUrl = app.flags.baseUrl;
      const path = await saveConfig(file, app.options.env);
      app.printer.success({ username: account.username, tier: account.tier, configPath: path }, w => {
        w.write(`Logged in as ${account.username} (${account.tier}). Key saved to ${path}\n`);
      });
    });

  auth
    .command('status')
    .description('Show which key is in use and whether it works')
    .action(async () => {
      const r = await app.resolve();
      if (!r.apiKey) throw new NoApiKeyError();
      const account = await app.clientFor(r.baseUrl, r.apiKey).usage();
      const info = {
        baseUrl: r.baseUrl,
        baseUrlSource: r.baseUrlSource,
        keySource: r.apiKeySource,
        configPath: configPath(app.options.env),
        key: maskKey(r.apiKey),
        username: account.username,
        tier: account.tier,
        tierExpiresAt: account.tierExpiresAt,
      };
      app.printer.success(info, w => {
        w.write(`Logged in as ${account.username} (${account.tier})\n`);
        w.write(`  Key     ${maskKey(r.apiKey)} (from ${r.apiKeySource})\n`);
        w.write(`  Server  ${r.baseUrl} (from ${r.baseUrlSource})\n`);
      });
    });

  auth
    .command('logout')
    .description(
      'Remove the saved key. This does not revoke it; revoke keys at https://githubcard.com/dashboard.'
    )
    .action(async () => {
      const file = await loadConfig(app.options.env);
      const had = Boolean(file.apiKey);
      delete file.apiKey;
      const path = await saveConfig(file, app.options.env);
      app.printer.success({ removed: had, configPath: path }, w => {
        w.write(
          had
            ? 'Removed the saved key. Revoke it at https://githubcard.com/dashboard if it may have leaked.\n'
            : 'No saved key.\n'
        );
      });
    });
}
