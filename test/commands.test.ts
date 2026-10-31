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

describe('ghcard create', () => {
  it('prints one JSON document when piped', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['create', 'octocat'], { fetch: api.fetch, env });
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.id).toBe(CARD.id);
    expect(r.stderr).toBe('');
  });

  it('sends a repo subject as type repo', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    await cli(['create', 'https://github.com/octocat/hello-world.git'], { fetch: api.fetch, env });
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
    const r = await cli(['create', 'octocat', '-o', out, '--readme', readme], { fetch: api.fetch, env });

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
    const r = await cli(['create', 'octocat', '-f', 'png', '-o', join(dir, 'c.png'), '--readme', readme], {
      fetch: api.fetch,
      env,
    });
    expect(r.code).toBe(0);
    expect(r.json.data.warnings[0]).toContain('download failed');
    expect(await readFile(readme, 'utf8')).toContain('ghcard:octocat');
  });

  it('uses snapshot links with --snapshot', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['create', 'octocat', '--snapshot'], { fetch: api.fetch, env });
    expect(r.json.data.url).toBe(CARD.snapshotUrls.svg);
    expect(r.json.data.embed.markdown).toContain(CARD.snapshotUrls.svg);
  });

  it('sends watermark:false only with --no-watermark', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    await cli(['create', 'octocat'], { fetch: api.fetch, env });
    await cli(['create', 'octocat', '--no-watermark'], { fetch: api.fetch, env });
    expect(api.requests[0]!.body).not.toHaveProperty('watermark');
    expect(api.requests[1]!.body).toMatchObject({ watermark: false });
  });

  it('dry run validates and creates nothing', async () => {
    const api = fakeApi({
      'POST /cards/validate': () =>
        ok({ valid: true, warnings: [], template: 'social', palette: null, watermark: true, artboard: { width: 1200, height: 630 }, layers: 5 }),
    });
    const r = await cli(['create', 'octocat', '--dry-run'], { fetch: api.fetch, env });
    expect(r.json.data.valid).toBe(true);
    expect(api.requests.map(q => q.path)).toEqual(['/cards/validate']);
  });

  it.each([
    [['create', 'a/b/c'], 2],
    [['create', 'octocat', '--format', 'gif'], 2],
    [['create', 'octocat', '--embed', 'xml'], 2],
    [['nope'], 2],
    [['create'], 2],
    [['card', 'octocat'], 2],
  ])('%j exits %i without calling the API', async (argv, code) => {
    const api = fakeApi({});
    const r = await cli(argv, { fetch: api.fetch, env });
    expect(r.code).toBe(code);
    expect(r.json.error.code).toBe('USAGE');
    expect(api.requests).toHaveLength(0);
  });

  it('exits 3 without a key', async () => {
    const api = fakeApi({});
    const r = await cli(['create', 'octocat'], { fetch: api.fetch, env: { GHCARD_CONFIG: env.GHCARD_CONFIG } });
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
    const r = await cli(['create', 'octocat'], { fetch: api.fetch, env });
    expect(r.code).toBe(code);
    if (hint) expect(r.json.error.hint).toContain(hint);
    if ('features' in body) expect(r.json.error.details.features).toHaveLength(1);
  });

  it('reports the quota retry time in the hint and details', async () => {
    const api = fakeApi({
      'POST /cards': () => json({ code: 'QUOTA_EXCEEDED', message: 'q' }, { status: 429, headers: { 'Retry-After': '90' } }),
    });
    const r = await cli(['create', 'octocat'], { fetch: api.fetch, env });
    expect(r.code).toBe(5);
    expect(r.json.error.retryable).toBe(true);
    expect(r.json.error.details.retryAfterSeconds).toBe(90);
    expect(r.json.error.hint).toBe('Daily card quota reached. Retry in 2m0s, or upgrade to Pro.');
  });

  it('prints human output on a terminal', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['create', 'octocat'], { fetch: api.fetch, env, tty: true });
    expect(r.stdout).toContain('Created card for octocat (social)');
    expect(r.stdout).toContain(`  ${CARD.embed.markdown}\n`);
    expect(r.stdout).toContain(`  Edit  ${CARD.editUrl}`);
    expect(r.stdout).toContain('99 of 100 cards left today. --verbose shows the image links.');
    expect(r.stdout).not.toContain(CARD.urls.png);
    expect(r.stderr).toContain('Generating card for octocat');
  });

  it('adds image links and the id with --verbose', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const r = await cli(['create', 'octocat', '--verbose'], { fetch: api.fetch, env, tty: true });
    expect(r.stdout).toContain(`  SVG   ${CARD.urls.svg}`);
    expect(r.stdout).toContain(`  PNG   ${CARD.urls.png}`);
    expect(r.stdout).toContain(`  ID    ${CARD.id}`);
    expect(r.stdout).not.toContain('--verbose shows');
  });

  it('names the README instead of repeating the snippet', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    const readme = join(dir, 'README.md');
    await writeFile(readme, '# Me\n');
    const r = await cli(['create', 'octocat', '--readme', readme], { fetch: api.fetch, env, tty: true });
    expect(r.stdout).toContain(`  Added to ${readme}`);
    expect(r.stdout).not.toContain(CARD.embed.markdown);
    const again = await cli(['create', 'octocat', '--readme', readme], { fetch: api.fetch, env, tty: true });
    expect(again.stdout).toContain(`  Already up to date: ${readme}`);
  });

  it('offers to log in on a terminal, then creates the card', async () => {
    const api = fakeApi({
      'GET /usage': () => ok({ username: 'octocat', tier: 'free', tierExpiresAt: '', cards: {}, ai: {} }),
      'POST /cards': () => ok(CREATED),
    });
    const noKey = { GHCARD_CONFIG: env.GHCARD_CONFIG };
    const r = await cli(['create', 'octocat'], { fetch: api.fetch, env: noKey, tty: true, stdin: `${KEY}\n` });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('This command needs a GitHubCard API key');
    expect(r.stderr).toContain('Logged in as octocat (free)');
    expect(r.stdout).toContain('Created card for octocat');
    expect(api.requests.find(q => q.path === '/cards')!.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(await readFile(env.GHCARD_CONFIG!, 'utf8'))).toEqual({ apiKey: KEY });
  });

  it('keeps NO_API_KEY for --json on a terminal', async () => {
    const api = fakeApi({});
    const r = await cli(['--json', 'create', 'octocat'], {
      fetch: api.fetch,
      env: { GHCARD_CONFIG: env.GHCARD_CONFIG },
      tty: true,
    });
    expect(r.code).toBe(3);
    expect(r.json.error.code).toBe('NO_API_KEY');
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

    await cli(['create', 'octocat', '--design', file], { fetch: api.fetch, env });
    expect(api.requests[1]!.body).toMatchObject({ design: DESIGN });
    expect(api.requests[1]!.body).not.toHaveProperty('template');
  });

  it('rejects --design with --template, and a design that is not an object', async () => {
    const file = join(dir, 'd.json');
    await writeFile(file, '[1]');
    const api = fakeApi({});
    expect((await cli(['create', 'octocat', '--design', file, '-t', 'social'], { fetch: api.fetch, env })).code).toBe(2);
    expect((await cli(['create', 'octocat', '--design', file], { fetch: api.fetch, env })).code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('reads a design from stdin', async () => {
    const api = fakeApi({ 'POST /cards': () => ok(CREATED) });
    await cli(['create', 'octocat', '--design', '-'], { fetch: api.fetch, env, stdin: JSON.stringify(DESIGN) });
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

  it('delete needs --yes without a terminal', async () => {
    const api = fakeApi({ 'DELETE /cards/AAAAAAAAAAAAAAAA': () => ok({ id: CARD.id }) });
    const refused = await cli(['delete', CARD.id], { fetch: api.fetch, env });
    expect(refused.code).toBe(2);
    expect(refused.json.error.message).toContain('--yes');
    const done = await cli(['delete', CARD.id, '--yes'], { fetch: api.fetch, env });
    expect(done.json.data.deleted).toEqual([CARD.id]);
  });

  it('list follows cursors with --all', async () => {
    const api = fakeApi({
      'GET /cards': req =>
        req.search.get('cursor') ? ok({ cards: [CARD], nextCursor: null }) : ok({ cards: [CARD], nextCursor: '1:x' }),
    });
    const r = await cli(['list', '--all'], { fetch: api.fetch, env });
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

  it('names the replacement for a renamed command', async () => {
    const r = await cli(['card', 'octocat'], { fetch: fakeApi({}).fetch, env });
    expect(r.code).toBe(2);
    expect(r.json.error.message).toBe("unknown command 'card' (did you mean 'create'?)");
  });

  it('prints grouped help for `ghcard` alone, with one line per command', async () => {
    const r = await cli([], { fetch: fakeApi({}).fetch, env, tty: true });
    expect(r.code).toBe(0);
    expect(r.stdout.indexOf('ghcard turns')).toBeLessThan(r.stdout.indexOf('Usage:'));
    for (const heading of ['Cards:', 'Catalogue (no key needed):', 'Account and agents:']) {
      expect(r.stdout).toContain(heading);
    }
    expect(r.stdout).toMatch(/^ {2}create <subject> +Create a card for a user or repo/m);
    expect(r.stdout).not.toContain('The request is idempotent');
    expect(r.stdout).toContain("Run 'ghcard <command> --help'");
  });

  it('prints help for a command group without a subcommand', async () => {
    const r = await cli(['auth'], { fetch: fakeApi({}).fetch, env, tty: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ {2}login +Save an API key/m);
  });

  it('completes commands, subcommands and flags', async () => {
    const complete = async (...words: string[]) =>
      (await cli(['__complete', ...words], { fetch: fakeApi({}).fetch, env })).stdout.trim().split('\n');
    expect(await complete('cr')).toEqual(['create']);
    expect(await complete('auth', '')).toEqual(['login', 'logout', 'status']);
    expect(await complete('create', 'octocat', '--re')).toEqual(['--readme']);
    expect(await complete('')).not.toContain('__complete');
  });

  it('prints a completion script per shell and rejects others', async () => {
    const api = fakeApi({});
    for (const shell of ['bash', 'zsh', 'fish']) {
      const r = await cli(['completion', shell], { fetch: api.fetch, env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('ghcard __complete');
    }
    expect((await cli(['completion', 'tcsh'], { fetch: api.fetch, env })).code).toBe(2);
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
