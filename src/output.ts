/**
 * Print results for people and for programs.
 *
 * Human mode writes readable text. JSON mode (--json, or automatically when
 * stdout is not a terminal) writes exactly one JSON document to stdout:
 *
 *   {"ok": true,  "data": ...}
 *   {"ok": false, "error": {"code": "...", "message": "...", "retryable": bool}}
 *
 * Exit codes are stable so scripts and agents can branch without parsing:
 * 0 ok, 1 error, 2 usage, 3 auth, 4 not found, 5 quota/rate limited,
 * 6 temporarily unavailable (retry later).
 */
import { ApiError, NoApiKeyError } from './api.js';

export const Exit = {
  OK: 0,
  Error: 1,
  Usage: 2,
  Auth: 3,
  NotFound: 4,
  RateLimited: 5,
  Unavailable: 6,
} as const;

/** A mistake in how the command was invoked. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface Writer {
  write(chunk: string): unknown;
}

export class Printer {
  constructor(
    public json: boolean,
    readonly out: Writer,
    readonly err: Writer
  ) {}

  /** Print data. In human mode, `render` prints it; without one, indented JSON is used. */
  success(data: unknown, render?: (w: Writer) => void): void {
    if (this.json || !render) {
      this.writeJson({ ok: true, data });
      return;
    }
    render(this.out);
  }

  /** A human-only note on stderr; JSON mode stays silent so stdout remains one document. */
  info(message: string): void {
    if (!this.json) this.err.write(`${message}\n`);
  }

  /** Print `error` and return the exit code for it. */
  failure(error: unknown): number {
    const c = classify(error);
    if (this.json) {
      const body: Record<string, unknown> = { code: c.code, message: c.message, retryable: c.retryable };
      if (c.hint) body.hint = c.hint;
      if (c.details && Object.keys(c.details).length > 0) body.details = c.details;
      this.writeJson({ ok: false, error: body });
      return c.exit;
    }
    this.err.write(`Error: ${c.message}\n`);
    if (c.hint) this.err.write(`Hint: ${c.hint}\n`);
    return c.exit;
  }

  writeJson(value: unknown): void {
    this.out.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

export interface Classified {
  code: string;
  message: string;
  retryable: boolean;
  hint: string;
  details: Record<string, unknown> | undefined;
  exit: number;
}

export function classify(error: unknown): Classified {
  if (error instanceof UsageError) {
    return {
      code: 'USAGE',
      message: error.message,
      retryable: false,
      hint: 'Run the command with --help for usage.',
      details: undefined,
      exit: Exit.Usage,
    };
  }
  if (error instanceof NoApiKeyError) {
    return {
      code: 'NO_API_KEY',
      message: 'no API key configured',
      retryable: false,
      hint: 'Create a key at https://githubcard.com/dashboard, then run `ghcard auth login` or set GHCARD_API_KEY.',
      details: undefined,
      exit: Exit.Auth,
    };
  }
  if (!(error instanceof ApiError)) {
    return {
      code: 'ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      hint: '',
      details: undefined,
      exit: Exit.Error,
    };
  }

  let details = error.details ? { ...error.details } : undefined;
  if (error.retryAfterSeconds > 0) {
    details = { ...(details ?? {}), retryAfterSeconds: error.retryAfterSeconds };
  }
  const { code, message } = error;
  let retryable = error.retryable;
  let hint = '';
  let exit: number = Exit.Error;

  if (error.status === 401 || code === 'UNAUTHORIZED') {
    hint = 'The API key is missing, wrong, or revoked. Create a new one at https://githubcard.com/dashboard.';
    exit = Exit.Auth;
  } else if (error.status === 404) {
    exit = Exit.NotFound;
  } else if (error.status === 429) {
    hint =
      error.retryAfterSeconds > 0
        ? `Daily card quota reached. Retry in ${goDuration(roundTo(error.retryAfterSeconds, 60))}, or upgrade to Pro.`
        : 'Daily card quota reached. It resets at 00:00 UTC; Pro raises the limit.';
    exit = Exit.RateLimited;
    retryable = true;
  } else if (code === 'PRO_TEMPLATE') {
    hint = 'Pick a free template with `ghcard templates`, or upgrade to Pro.';
  } else if (code === 'UNKNOWN_TEMPLATE' || code === 'TEMPLATE_SCOPE_MISMATCH') {
    hint = 'List valid templates with `ghcard templates --scope profile|repo`.';
    exit = Exit.Usage;
  } else if (code === 'UNKNOWN_PALETTE') {
    hint = 'List valid palettes with `ghcard palettes`.';
    exit = Exit.Usage;
  } else if (code === 'INVALID_REQUEST') {
    exit = Exit.Usage;
  } else if (code === 'PRO_FEATURE') {
    hint =
      'The design uses a Pro font or background (details.features gives each path). Swap them for free ones, or upgrade to Pro.';
  } else if (code === 'INVALID_DESIGN') {
    hint = 'Fix the design as the message says; `ghcard design init <template>` gives a valid starting point.';
    exit = Exit.Usage;
  } else if (code === 'CARD_GENERATION_IN_PROGRESS' || code === 'NETWORK_ERROR') {
    // A first render can outlast the client; repeating resumes it.
    hint =
      'The card may still be rendering. Wait ~30s and repeat the identical command; it resumes the same card. Give up after 5 attempts.';
    exit = Exit.Unavailable;
    retryable = true;
  } else if (code === 'CARD_GENERATION_FAILED') {
    hint =
      'Rendering failed on the server. Repeat the identical command at most twice; if it still fails, report a server-side rendering problem.';
    exit = Exit.Unavailable;
    retryable = true;
  } else if (retryable || error.status >= 500) {
    retryable = true;
    hint =
      error.retryAfterSeconds > 0
        ? `Temporary problem; retry in ${goDuration(error.retryAfterSeconds)}.`
        : 'Temporary problem. Wait ~30s and repeat the identical command; give up after 5 attempts.';
    exit = Exit.Unavailable;
  }
  return { code, message, retryable, hint, details, exit };
}

function roundTo(seconds: number, unit: number): number {
  return Math.round(seconds / unit) * unit;
}

/** Seconds formatted like Go's time.Duration ("90s" → "1m30s", "3600s" → "1h0m0s"). */
export function goDuration(seconds: number): string {
  if (seconds === 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/** Aligned columns: each one is as wide as its widest cell plus two spaces. */
export function table(w: Writer, header: string[], rows: string[][]): void {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map(row => (row[i] ?? '').length)));
  for (const row of all) {
    const line = row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + 2)))
      .join('');
    w.write(`${line}\n`);
  }
}
