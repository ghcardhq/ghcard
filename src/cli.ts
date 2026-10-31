import { spawn } from 'node:child_process';
import net from 'node:net';
import { run } from './app.js';

// Node gives each address only 250ms to connect before trying the next one
// (happy eyeballs). On slow or distant links every attempt can lose that
// race, so fetch fails with ETIMEDOUT while curl gets through. Go and curl
// wait much longer; 2s per address keeps a dead IPv6 route cheap.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

/** Open a URL with the platform's default handler. */
function openUrl(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const code = await run({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  openUrl,
});
// `ghcard mcp` keeps serving after run() returns; only set the code.
process.exitCode = code;
