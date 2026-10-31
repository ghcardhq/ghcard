/**
 * Typed client for the GitHubCard public API (/api/v1).
 *
 * It is the only place the CLI and the MCP server talk HTTP, so both see the
 * same errors and rate-limit information.
 */

export const DEFAULT_BASE_URL = 'https://githubcard.com';

/**
 * A first-time card renders and publishes an image, which can take a few
 * minutes on a cold renderer. Retrying after a timeout is safe: the server
 * resumes the same card.
 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 8 << 20;
const MAX_DOWNLOAD_BYTES = 32 << 20;

/** A failed API call. `code` is stable and safe to branch on; `message` is for people. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  /** Seconds from a `Retry-After` header, or 0. */
  readonly retryAfterSeconds: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(init: {
    status?: number;
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status ?? 0;
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds ?? 0;
    this.details = init.details;
  }
}

/** Thrown before any request when a key is required but missing. */
export class NoApiKeyError extends Error {
  constructor() {
    super('no API key configured');
    this.name = 'NoApiKeyError';
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: Date;
}

// --- Data types -------------------------------------------------------------

/** Body of POST /cards. Undefined fields are omitted so the server applies its defaults. */
export interface CardRequest {
  type?: 'repo';
  username: string;
  repo?: string;
  template?: string;
  palette?: string;
  format?: string;
  watermark?: boolean;
  /** A full design document used instead of template/palette. */
  design?: Record<string, unknown>;
}

export interface CardUrls {
  svg: string;
  png: string;
}

export interface CardEmbed {
  markdown: string;
  html: string;
}

export interface Usage {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

/** One generated, published card. */
export interface Card {
  id: string;
  designId: string;
  publicationId: string;
  type: string;
  subject: string;
  template: string;
  palette: string | null;
  watermark: boolean;
  /** Re-render with current GitHub data. */
  urls: CardUrls;
  /** Never change. */
  snapshotUrls: CardUrls;
  embed: CardEmbed;
  editUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** The POST /cards response. */
export interface CreatedCard extends Card {
  created: boolean;
  url: string;
  usage: Usage;
}

export interface CardPage {
  cards: Card[];
  nextCursor: string | null;
}

export interface Size {
  width: number;
  height: number;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  scope: string;
  size: Size;
  ogCompatible: boolean;
  pro: boolean;
  widgets: string[];
  family?: string;
}

export interface Palette {
  id: string;
  name: string;
  kind: string;
  background: string;
  pro: boolean;
}

export interface ProBackground {
  name: string;
  group: string;
  pro: boolean;
}

export interface Palettes {
  palettes: Palette[];
  proBackgrounds: ProBackground[];
}

export interface Component {
  type: string;
  name: string;
  description: string;
  scope: string;
}

export interface Account {
  username: string;
  tier: string;
  tierExpiresAt: string;
  cards: Usage;
  ai: Usage;
}

/** What a dry run of createCard would produce. */
export interface ValidatedCard {
  valid: boolean;
  /** Layout problems that still render, such as clipped layers. */
  warnings: string[];
  template: string;
  palette: string | null;
  watermark: boolean;
  artboard: Size;
  layers: number;
}

// --- Client -----------------------------------------------------------------

type Query = Record<string, string | undefined>;

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  userAgent?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Waits before each retry of a failed connection; tests pass []. */
  retryDelaysMs?: readonly number[];
}

/** Two retries, 1s then 3s apart: enough for a flaky link, short enough to wait for. */
const CONNECT_RETRY_DELAYS_MS = [1000, 3000];

/** Codes Node gives when a connection was never established. */
const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True when fetch failed before any request reached the server. */
function isConnectFailure(cause: unknown): boolean {
  if (!(cause instanceof Error) || cause.name === 'TimeoutError' || cause.name === 'AbortError') return false;
  const inner = (cause as { cause?: { code?: unknown } }).cause;
  return typeof inner?.code === 'string' && CONNECT_ERROR_CODES.has(inner.code);
}

/** Fields of an error body kept as details. */
const DETAIL_FIELDS = ['field', 'issues', 'limit', 'resetAt', 'features'] as const;

export class Client {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? '';
    this.userAgent = options.userAgent ?? '';
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryDelaysMs = options.retryDelaysMs ?? CONNECT_RETRY_DELAYS_MS;
  }

  /**
   * Fetch, retrying only when the connection itself failed. Such a request
   * never reached the server, so repeating it is safe for every endpoint,
   * creating a card included. A timeout or a failure after the request was
   * sent is not retried here: the server may still be working on it.
   */
  private async fetchWithRetry(target: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchImpl(target, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (cause) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined || !isConnectFailure(cause)) throw cause;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; auth: boolean; expectData?: boolean }
  ): Promise<{ data: T; rateLimit: RateLimit | null }> {
    if (options.auth && !this.apiKey) throw new NoApiKeyError();

    let target = `${this.baseUrl}/api/v1${path}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    const search = params.toString();
    if (search) target += `?${search}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth) headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchWithRetry(target, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (cause) {
      throw new ApiError({
        code: 'NETWORK_ERROR',
        message: `could not reach ${this.baseUrl}: ${errorText(cause)}`,
        retryable: true,
      });
    }

    let raw: string;
    try {
      raw = await readLimited(response, MAX_RESPONSE_BYTES);
    } catch (cause) {
      throw new ApiError({
        status: response.status,
        code: 'NETWORK_ERROR',
        message: errorText(cause),
        retryable: true,
      });
    }

    const rateLimit = parseRateLimit(response.headers);
    if (response.status >= 400) throw parseError(response, raw);
    if (options.expectData === false) return { data: undefined as T, rateLimit };

    let envelope: { data?: unknown } | null = null;
    try {
      envelope = JSON.parse(raw) as { data?: unknown };
    } catch {
      envelope = null;
    }
    if (!envelope || typeof envelope !== 'object' || envelope.data === undefined || envelope.data === null) {
      throw new ApiError({
        status: response.status,
        code: 'BAD_RESPONSE',
        message: 'the server returned an unexpected response',
      });
    }
    return { data: envelope.data as T, rateLimit };
  }

  // --- Endpoints ------------------------------------------------------------

  /** Generate (or reuse) a card. The same parameters return the same card. */
  async createCard(req: CardRequest): Promise<CreatedCard> {
    return (await this.request<CreatedCard>('POST', '/cards', { body: req, auth: true })).data;
  }

  /** Run every createCard check without rendering, storing, or using quota. */
  async validateCard(req: CardRequest): Promise<ValidatedCard> {
    return (await this.request<ValidatedCard>('POST', '/cards/validate', { body: req, auth: true })).data;
  }

  /** One page of the account's cards, newest requested first. */
  async listCards(limit: number, cursor: string): Promise<CardPage> {
    const page = (
      await this.request<CardPage>('GET', '/cards', {
        query: { limit: limit > 0 ? String(limit) : undefined, cursor },
        auth: true,
      })
    ).data;
    return { cards: page.cards ?? [], nextCursor: page.nextCursor ?? null };
  }

  async getCard(id: string): Promise<Card> {
    return (await this.request<Card>('GET', `/cards/${encodeURIComponent(id)}`, { auth: true })).data;
  }

  /** A card's design document, ready to edit and send back as CardRequest.design. */
  async cardDesign(id: string): Promise<Record<string, unknown>> {
    return (
      await this.request<Record<string, unknown>>('GET', `/cards/${encodeURIComponent(id)}/design`, { auth: true })
    ).data;
  }

  /** A template's layout as a design document. No key needed, no quota used. */
  async templateDesign(
    template: string,
    username: string,
    repo: string,
    palette: string
  ): Promise<Record<string, unknown>> {
    return (
      await this.request<Record<string, unknown>>('GET', `/templates/${encodeURIComponent(template)}/design`, {
        query: { username, repo, palette },
        auth: false,
      })
    ).data;
  }

  /** Delete a card. Its links stop working. */
  async deleteCard(id: string): Promise<void> {
    await this.request('DELETE', `/cards/${encodeURIComponent(id)}`, { auth: true, expectData: false });
  }

  /** The key's tier and current-window usage. */
  async usage(): Promise<Account> {
    return (await this.request<Account>('GET', '/usage', { auth: true })).data;
  }

  /** Layouts; scope is "", "profile", or "repo". No key needed. */
  async templates(scope: string): Promise<Template[]> {
    return (await this.request<Template[]>('GET', '/templates', { query: { scope }, auth: false })).data;
  }

  async palettes(): Promise<Palettes> {
    return (await this.request<Palettes>('GET', '/palettes', { auth: false })).data;
  }

  async components(): Promise<Component[]> {
    return (await this.request<Component[]>('GET', '/components', { auth: false })).data;
  }

  /** Fetch a rendered card image. Card URLs are public, so no key is sent. */
  async download(imageUrl: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchWithRetry(imageUrl, {
        headers: this.userAgent ? { 'User-Agent': this.userAgent } : {},
      });
    } catch (cause) {
      throw new ApiError({ code: 'NETWORK_ERROR', message: errorText(cause), retryable: true });
    }
    if (response.status >= 400) {
      throw new ApiError({
        status: response.status,
        code: 'DOWNLOAD_FAILED',
        message: `downloading ${imageUrl} returned ${response.status}`,
        retryable: response.status >= 500,
      });
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new ApiError({ code: 'DOWNLOAD_FAILED', message: `downloading ${imageUrl}: image too large` });
    }
    return buffer;
  }
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const text = await response.text();
  return text.length > limit ? text.slice(0, limit) : text;
}

function parseRateLimit(headers: Headers): RateLimit | null {
  const limit = Number.parseInt(headers.get('X-RateLimit-Limit') ?? '', 10);
  const remaining = Number.parseInt(headers.get('X-RateLimit-Remaining') ?? '', 10);
  const reset = Number.parseInt(headers.get('X-RateLimit-Reset') ?? '', 10);
  if ([limit, remaining, reset].some(Number.isNaN)) return null;
  return { limit, remaining, reset: new Date(reset * 1000) };
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function parseError(response: Response, raw: string): ApiError {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON error bodies fall back to the status below.
  }
  const status = response.status;
  let code = typeof body.code === 'string' ? body.code : '';
  let message =
    typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '';
  let retryable = typeof body.retryable === 'boolean' ? body.retryable : false;

  const details: Record<string, unknown> = {};
  // Some servers nest these under details; others put them at the top level.
  const nested = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : {};
  for (const key of DETAIL_FIELDS) {
    if (key in nested) details[key] = nested[key];
    if (key in body) details[key] = body[key];
  }

  const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);

  if (!code) {
    if (status === 401) code = 'UNAUTHORIZED';
    else if (status === 403) code = 'FORBIDDEN';
    else if (status === 404) code = 'NOT_FOUND';
    else if (status === 429) code = 'QUOTA_EXCEEDED';
    else if (status >= 500) {
      code = 'SERVICE_UNAVAILABLE';
      retryable = true;
    } else code = 'REQUEST_FAILED';
  }
  if (!message) message = STATUS_TEXT[status] ?? `HTTP ${status}`;

  return new ApiError({
    status,
    code,
    message,
    retryable,
    retryAfterSeconds: Number.isNaN(retryAfter) ? 0 : retryAfter,
    details: Object.keys(details).length > 0 ? details : undefined,
  });
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause as (Error & { code?: string }) | undefined;
    // Node wraps connect failures in an AggregateError whose message is empty;
    // its code (ETIMEDOUT, ECONNREFUSED, ...) is the useful part.
    const detail = inner instanceof Error ? inner.message || inner.code || inner.name : '';
    return detail ? `${cause.message} (${detail})` : cause.message;
  }
  return String(cause);
}
