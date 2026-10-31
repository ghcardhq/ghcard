/** A fake GitHubCard API for tests: records requests, answers from routes. */
import { PassThrough } from 'node:stream';
import { run, type RunOptions } from '../src/app.js';

export interface Recorded {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Route = (req: Recorded) => Response | Promise<Response>;

export const BASE = 'https://api.test';

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function ok(data: unknown, init: ResponseInit = {}): Response {
  return json({ success: true, data }, init);
}

/** routes keys are "METHOD /path" (path without /api/v1), or a full URL for downloads. */
export function fakeApi(routes: Record<string, Route>) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const req: Recorded = {
      method,
      path,
      search: url.searchParams,
      headers: new Headers(init?.headers),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
    };
    requests.push(req);
    const route = routes[`${method} ${path}`] ?? routes[url.toString()];
    if (!route) return json({ code: 'NOT_FOUND', message: `no route ${method} ${path}` }, { status: 404 });
    return route(req);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

export const CARD = {
  id: 'AAAAAAAAAAAAAAAA',
  designId: 'design123456',
  publicationId: 'pub1234567890123',
  type: 'profile',
  subject: 'octocat',
  template: 'social',
  palette: null,
  watermark: true,
  urls: { svg: `${BASE}/octocat.svg?d=design123456`, png: `${BASE}/octocat.png?d=design123456` },
  snapshotUrls: { svg: `${BASE}/g/pub1234567890123.svg`, png: `${BASE}/g/pub1234567890123.png` },
  embed: {
    markdown: `[![GitHubCard for octocat](${BASE}/octocat.svg?d=design123456)](https://github.com/octocat)`,
    html: `<a href="https://github.com/octocat"><img src="${BASE}/octocat.svg?d=design123456" alt="GitHubCard for octocat"></a>`,
  },
  editUrl: `${BASE}/octocat/card/edit?d=design123456`,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

export const CREATED = {
  ...CARD,
  created: true,
  url: CARD.urls.svg,
  usage: { used: 1, limit: 100, remaining: 99, resetAt: '2026-11-01T00:00:00.000Z' },
};

export const KEY = `ghc_live_1_${'a'.repeat(32)}`;

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout, when it is JSON. */
  json: any;
}

/** Run the CLI with piped (non-TTY) stdout and an isolated config. */
export async function cli(
  argv: string[],
  options: {
    fetch: typeof fetch;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    tty?: boolean;
    retryDelaysMs?: readonly number[];
    openUrl?: RunOptions['openUrl'];
  }
): Promise<Result> {
  let stdout = '';
  let stderr = '';
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = options.tty ?? false;
  stdin.end(options.stdin ?? '');
  const code = await run({
    argv,
    stdout: { write: (s: string) => (stdout += s), isTTY: options.tty ?? false },
    stderr: { write: (s: string) => (stderr += s), isTTY: options.tty ?? false },
    stdin,
    env: { GHCARD_BASE_URL: BASE, ...options.env },
    fetch: options.fetch,
    retryDelaysMs: options.retryDelaysMs ?? [],
    openUrl: options.openUrl,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  return { code, stdout, stderr, json: parsed };
}
