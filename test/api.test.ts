import { describe, expect, it } from 'vitest';
import { ApiError, Client, NoApiKeyError } from '../src/api.js';
import { BASE, CREATED, KEY, fakeApi, json, ok } from './helpers.js';

/** What Node's fetch throws when it never connected. */
function connectFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

describe('Client', () => {
  it('posts a card with the key and omits an unset watermark', async () => {
    const api = fakeApi({
      'POST /cards': () => ok(CREATED, { headers: { 'X-RateLimit-Limit': '100' } }),
    });
    const client = new Client({ baseUrl: `${BASE}/`, apiKey: KEY, userAgent: 'ghcard-cli/test', fetch: api.fetch });
    const card = await client.createCard({ username: 'octocat', template: 'social' });

    expect(card.id).toBe(CREATED.id);
    const [req] = api.requests;
    expect(req!.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(req!.headers.get('User-Agent')).toBe('ghcard-cli/test');
    expect(req!.body).toEqual({ username: 'octocat', template: 'social' });
  });

  it('parses a 429 with Retry-After and keeps limit and features in details', async () => {
    const api = fakeApi({
      'POST /cards': () =>
        json(
          { code: 'QUOTA_EXCEEDED', message: 'Daily quota reached', retryable: true, limit: 100, features: ['a'] },
          { status: 429, headers: { 'Retry-After': '120' } }
        ),
    });
    const error = await new Client({ baseUrl: BASE, apiKey: KEY, fetch: api.fetch })
      .createCard({ username: 'octocat' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.retryAfterSeconds).toBe(120);
    expect(apiError.retryable).toBe(true);
    expect(apiError.details).toEqual({ limit: 100, features: ['a'] });
  });

  it('derives a code from the status when the body has none', async () => {
    const api = fakeApi({ 'GET /usage': () => json({ message: 'Invalid API key' }, { status: 401 }) });
    const error = (await new Client({ baseUrl: BASE, apiKey: KEY, fetch: api.fetch })
      .usage()
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.message).toBe('Invalid API key');
  });

  it('sends nothing when a key is required but missing', async () => {
    const api = fakeApi({});
    await expect(new Client({ baseUrl: BASE, fetch: api.fetch }).usage()).rejects.toBeInstanceOf(NoApiKeyError);
    expect(api.requests).toHaveLength(0);
  });

  it('never sends the key to catalogue endpoints', async () => {
    const api = fakeApi({ 'GET /templates': () => ok([]) });
    await new Client({ baseUrl: BASE, apiKey: KEY, fetch: api.fetch }).templates('repo');
    expect(api.requests[0]!.headers.get('Authorization')).toBeNull();
    expect(api.requests[0]!.search.get('scope')).toBe('repo');
  });

  it('reports a transport failure as a retryable NETWORK_ERROR', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new AggregateError([], ''), { code: 'ETIMEDOUT' }) });
    }) as typeof fetch;
    const error = (await new Client({ baseUrl: BASE, fetch: failing, retryDelaysMs: [] })
      .templates('')
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('ETIMEDOUT');
  });

  it('retries a failed connection, then succeeds', async () => {
    let calls = 0;
    const api = fakeApi({ 'GET /palettes': () => ok({ palettes: [], proBackgrounds: [] }) });
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls < 3) throw connectFailure('ETIMEDOUT');
      return api.fetch(input, init);
    }) as typeof fetch;
    const result = await new Client({ baseUrl: BASE, fetch: flaky, retryDelaysMs: [0, 0] }).palettes();
    expect(result.palettes).toEqual([]);
    expect(calls).toBe(3);
  });

  it('gives up after its retries and reports NETWORK_ERROR', async () => {
    let calls = 0;
    const down = (async () => {
      calls += 1;
      throw connectFailure('ECONNREFUSED');
    }) as typeof fetch;
    const error = (await new Client({ baseUrl: BASE, fetch: down, retryDelaysMs: [0, 0] })
      .palettes()
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NETWORK_ERROR');
    expect(calls).toBe(3);
  });

  it('does not repeat a request that may have reached the server', async () => {
    let calls = 0;
    const reset = (async () => {
      calls += 1;
      throw connectFailure('ECONNRESET');
    }) as typeof fetch;
    await new Client({ baseUrl: BASE, apiKey: KEY, fetch: reset, retryDelaysMs: [0, 0] })
      .createCard({ username: 'octocat' })
      .catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('returns an empty list rather than null', async () => {
    const api = fakeApi({ 'GET /cards': () => ok({ cards: null, nextCursor: null }) });
    const page = await new Client({ baseUrl: BASE, apiKey: KEY, fetch: api.fetch }).listCards(20, '');
    expect(page.cards).toEqual([]);
  });

  it('treats a 2xx without data as BAD_RESPONSE', async () => {
    const api = fakeApi({ 'GET /palettes': () => json({ success: true }) });
    const error = (await new Client({ baseUrl: BASE, fetch: api.fetch }).palettes().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('BAD_RESPONSE');
  });
});
