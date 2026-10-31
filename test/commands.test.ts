import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { goDuration } from '../src/output.js';
import { CARD, CREATED, KEY, cli, fakeApi, json, ok } from './helpers.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ghcard-cmd-'));
  env = { GHCARD_CONFIG: join(dir, 'config.json'), GHCARD_API_KEY: KEY };
});

describe('ghcard card', () => {
  it('prints one JSON document when piped', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['card', 'octocat'], { fetch: api.fetch, env });
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.id).toBe(CARD.id);
    expect(r.stderr).toBe('');
  });

  it('sends a repo subject as type repo', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    await cli(['card', 'https://github.com/octocat/hello-world.git'], { fetch: api.fetch, env });
    expect(api.requests[0]!.body).toMatchObject({ type: 'repo', username: 'octocat', repo: 'hello-world' });
  });

  it('downloads the image and inserts the README block', async () => {
    const api = fakeApi({
      'POST /cards': () => ok(CREATED),
      [CREATED.url]: () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    });
    const out = join(dir, 'card.svg');
    const readme = join(dir, 'README.md');
    await writeFile(readme, '# Me\n');
    const r = await cli(['card', 'octocat', '-o', out, '--readme', readme], { fetch: api.fetch, env });

    expect(r.code).toBe(0);
    expect(r.json.data.readmeEdit).toBe('inserted');
    expect(r.json.data.output).toBe(out);
    expect(await readFile(out, 'utf8')).toBe('<svg/>');
    expect(await readFile(readme, 'utf8')).toContain(CARD.embed.markdown);
  });

  it('keeps going with a warning when the download fails', async () => {
    const api = fakeApi({
      'POST /cards': () => ok({ ...CREATED, url: CARD.urls.png }),
      [CARD.urls.png]: () => new Response('nope', { status: 502 }),
    });
    const readme = join(dir, 'README.md');
    const r = await cli(['card', 'octocat', '-f', 'png', '-o', join(dir, 'c.png'), '--readme', readme], {
      fetch: api.fetch,
      env,
    });
    expect(r.code).toBe(0);
    expect(r.json.data.warnings[0]).toContain('download failed');
    expect(await readFile(readme, 'utf8')).toContain('ghcard:octocat');
  });

  it('uses snapshot links with --snapshot', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['card', 'octocat', '--snapshot'], { fetch: api.fetch, env });
    expect(r.json.data.url).toBe(CARD.snapshotUrls.svg);
    expect(r.json.data.embed.markdown).toContain(CARD.snapshotUrls.svg);
  });

  it('sends watermark:false only with --no-watermark', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    await cli(['card', 'octocat'], { fetch: api.fetch, env });
    await cli(['card', 'octocat', '--no-watermark'], { fetch: api.fetch, env });
    expect(api.requests[0]!.body).not.toHaveProperty('watermark');
    expect(api.requests[1]!.body).toMatchObject({ watermark: false });
  });

  it('dry run validates and creates nothing', async () => {
    const api = fakeApi({
      'POST /cards/validate': () =>
        ok({ valid: true, warnings: [], template: 'social', palette: null, watermark: true, artboard: { width: 1200, height: 630 }, layers: 5 }),
    });
    const r = await cli(['card', 'octocat', '--dry-run'], { fetch: api.fetch, env });
    expect(r.json.data.valid).toBe(true);
    expect(api.requests.map(q => q.path)).toEqual(['/cards/validate']);
  });

  it.each([
    [['card', 'a/b/c'], 2],
    [['card', 'octocat', '--format', 'gif'], 2],
    [['card', 'octocat', '--embed', 'xml'], 2],
    [['nope'], 2],
    [['card'], 2],
  ])('%j exits %i without calling the API', async (argv, code) => {
    const api = fakeApi({});
    const r = await cli(argv, { fetch: api.fetch, env });
    expect(r.code).toBe(code);
    expect(r.json.error.code).toBe('USAGE');
    expect(api.requests).toHaveLength(0);
  });

  it('exits 3 without a key', async () => {
    const api = fakeApi({});
    const r = await cli(['card', 'octocat'], { fetch: api.fetch, env: { GHCARD_CONFIG: env.GHCARD_CONFIG } });
    expect(r.code).toBe(3);
    expect(r.json.error.code).toBe('NO_API_KEY');
  });

  it.each([
    [{ code: 'PRO_TEMPLATE', message: 'x' }, 403, 1, 'ghcard templates'],
    [{ code: 'UNKNOWN_TEMPLATE', message: 'x' }, 400, 2, '--scope profile|repo'],
    [{ code: 'PRO_FEATURE', message: 'x', features: [{ path: 'artboard.style.fontFamily' }] }, 403, 1, 'free ones'],
    [{ code: 'CARD_GENERATION_IN_PROGRESS', message: 'x', retryable: true }, 503, 6, 'Wait ~30s'],
    [{ message: 'Invalid API key' }, 401, 3, 'revoked'],
    [{ code: 'CARD_NOT_FOUND', message: 'x' }, 404, 4, ''],
  ])('maps %j to exit %i', async (body, status, code, hint) => {
    const api = fakeApi({ 'POST /cards': () => json(body, { status }) });
    const r = await cli(['card', 'octocat'], { fetch: api.fetch, env });
    expect(r.code).toBe(code);
    if (hint) expect(r.json.error.hint).toContain(hint);
    if ('features' in body) expect(r.json.error.details.features).toHaveLength(1);
  });

  it('reports the quota retry time in the hint and details', async () => {
    const api = fakeApi({
      'POST /cards': () => json({ code: 'QUOTA_EXCEEDED', message: 'q' }, { status: 429, headers: { 'Retry-After': '90' } }),
    });
    const r = await cli(['card', 'octocat'], { fetch: api.fetch, env });
    expect(r.code).toBe(5);
    expect(r.json.error.retryable).toBe(true);
    expect(r.json.error.details.retryAfterSeconds).toBe(90);
    expect(r.json.error.hint).toBe('Daily card quota reached. Retry in 2m0s, or upgrade to Pro.');
  });

  it('prints human output on a terminal', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['card', 'octocat'], { fetch: api.fetch, env, tty: true });
    expect(r.stdout).toContain(`Created card ${CARD.id} for octocat (template social)`);
    expect(r.stdout).toContain('Quota: 99 of 100 cards left today');
    expect(r.stderr).toContain('Generating card for octocat');
  });

  it('honours --json on a terminal, also for flag errors', async () => {
    const api = fakeApi({});
    const r = await cli(['--json', 'card', 'octocat', '--bogus'], { fetch: api.fetch, env, tty: true });
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('USAGE');
  });
});

describe('ghcard design', () => {
  const DESIGN = { version: 1, artboard: { width: 1200, height: 630 }, layers: [] };

  it('prints the bare document when piped', async () => {
    const api = fakeApi({ 'GET /templates/social/design': () => ok(DESIGN) });
    const r = await cli(['design', 'init', 'social'], { fetch: api.fetch, env });
    expect(r.stdout.startsWith('{\n')).toBe(true);
    expect(r.json).toEqual(DESIGN);
    expect(api.requests[0]!.headers.get('Authorization')).toBeNull();
  });

  it('writes a file, then publishes it with --design', async () => {
    const api = fakeApi({
      'GET /templates/repo-og-compact/design': () => ok(DESIGN),
      'POST /cards': () => ok(CREATED),
    });
    const file = join(dir, 'design.json');
    const init = await cli(['design', 'init', 'repo-og-compact', '--subject', 'octocat/hello-world', '-o', file], {
      fetch: api.fetch,
      env,
    });
    expect(init.json.data.output).toBe(file);
    expect(api.requests[0]!.search.get('repo')).toBe('hello-world');

    await cli(['card', 'octocat', '--design', file], { fetch: api.fetch, env });
    expect(api.requests[1]!.body).toMatchObject({ design: DESIGN });
    expect(api.requests[1]!.body).not.toHaveProperty('template');
  });

  it('rejects --design with --template, and a design that is not an object', async () => {
    const file = join(dir, 'd.json');
    await writeFile(file, '[1]');
    const api = fakeApi({});
    expect((await cli(['card', 'octocat', '--design', file, '-t', 'social'], { fetch: api.fetch, env })).code).toBe(2);
    expect((await cli(['card', 'octocat', '--design', file], { fetch: api.fetch, env })).code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('reads a design from stdin', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    await cli(['card', 'octocat', '--design', '-'], { fetch: api.fetch, env, stdin: JSON.stringify(DESIGN) });
    expect(api.requests[0]!.body).toMatchObject({ design: DESIGN });
  });
});

describe('other commands', () => {
  it('templates filters by widget, case-insensitively', async () => {
    const api = fakeApi({
      'GET /templates': () =>
        ok([
          { id: 'a', name: 'A', scope: 'profile', size: { width: 1, height: 1 }, pro: false, widgets: ['streak'] },
          { id: 'b', name: 'B', scope: 'profile', size: { width: 1, height: 1 }, pro: true, widgets: ['stats'] },
        ]),
    });
    const r = await cli(['templates', '--widget', 'Streak'], { fetch: api.fetch, env });
    expect(r.json.data.map((t: { id: string }) => t.id)).toEqual(['a']);
    const free = await cli(['templates', '--free'], { fetch: api.fetch, env });
    expect(free.json.data).toHaveLength(1);
  });

  it('cards delete needs --yes without a terminal', async () => {
    const api = fakeApi({ 'DELETE /cards/AAAAAAAAAAAAAAAA': () => ok({ id: CARD.id }) });
    const refused = await cli(['cards', 'delete', CARD.id], { fetch: api.fetch, env });
    expect(refused.code).toBe(2);
    expect(refused.json.error.message).toContain('--yes');
    const done = await cli(['cards', 'delete', CARD.id, '--yes'], { fetch: api.fetch, env });
    expect(done.json.data.deleted).toEqual([CARD.id]);
  });

  it('cards list follows cursors with --all', async () => {
    const api = fakeApi({
      'GET /cards': req =>
        req.search.get('cursor') ? ok({ cards: [CARD], nextCursor: null }) : ok({ cards: [CARD], nextCursor: '1:x' }),
    });
    const r = await cli(['cards', 'list', '--all'], { fetch: api.fetch, env });
    expect(r.json.data.cards).toHaveLength(2);
    expect(r.json.data.nextCursor).toBeNull();
  });

  it('auth login verifies the key and saves it with mode 0600', async () => {
    const api = fakeApi({
      'GET /usage': () => ok({ username: 'octocat', tier: 'free', tierExpiresAt: '', cards: {}, ai: {} }),
    });
    const r = await cli(['auth', 'login', '--with-token'], {
      fetch: api.fetch,
      env: { GHCARD_CONFIG: env.GHCARD_CONFIG },
      stdin: `${KEY}\n`,
    });
    expect(r.code).toBe(0);
    expect(r.json.data.username).toBe('octocat');
    expect(JSON.parse(await readFile(env.GHCARD_CONFIG!, 'utf8'))).toEqual({ apiKey: KEY });
    expect((await stat(env.GHCARD_CONFIG!)).mode & 0o777).toBe(0o600);
  });

  it('auth login rejects something that is not a key', async () => {
    const api = fakeApi({});
    const r = await cli(['auth', 'login', '--with-token'], { fetch: api.fetch, env, stdin: 'hello\n' });
    expect(r.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('open --print prints the edit link; an unknown card exits 4', async () => {
    const api = fakeApi({ 'GET /cards/AAAAAAAAAAAAAAAA': () => ok(CARD) });
    let opened = '';
    const r = await cli(['open', CARD.id, '--print'], {
      fetch: api.fetch,
      env,
      tty: true,
      openUrl: async url => void (opened = url),
    });
    expect(r.stdout.trim()).toBe(CARD.editUrl);
    expect(opened).toBe('');
    expect((await cli(['open', 'BBBBBBBBBBBBBBBB'], { fetch: api.fetch, env })).code).toBe(4);
  });

  it('--version prints the version', async () => {
    const r = await cli(['--version'], { fetch: fakeApi({}).fetch, env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ghcard version /);
  });
});

describe('goDuration', () => {
  it.each([
    [0, '0s'],
    [30, '30s'],
    [120, '2m0s'],
    [90, '1m30s'],
    [3600, '1h0m0s'],
  ])('%i → %s', (seconds, text) => expect(goDuration(seconds)).toBe(text));
});
