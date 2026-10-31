import { spawn } from 'node:child_process';
import { run } from './app.js';

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
