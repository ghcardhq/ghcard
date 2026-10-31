/**
 * Card subjects and filters shared by the CLI and the MCP server, so both
 * accept exactly the same input.
 */

export interface Subject {
  username: string;
  /** Empty for a profile. */
  repo: string;
}

export class SubjectError extends Error {
  constructor(input: string) {
    super(`${JSON.stringify(input)} is not a GitHub user or owner/repo`);
    this.name = 'SubjectError';
  }
}

/**
 * Turn "user", "owner/repo", or a GitHub URL for either into its parts.
 * Accepted URL forms: http(s)://, optional www., a trailing slash, and a
 * trailing .git on the repository.
 */
export function parseSubject(input: string): Subject {
  let s = input.trim();
  for (const prefix of ['https://', 'http://']) {
    if (s.toLowerCase().startsWith(prefix)) s = s.slice(prefix.length);
  }
  for (const host of ['www.github.com/', 'github.com/']) {
    if (s.toLowerCase().startsWith(host)) {
      s = s.slice(host.length);
      break;
    }
  }
  if (s.endsWith('/')) s = s.slice(0, -1);
  const parts = s.split('/');
  if (parts.length === 1 && parts[0]) return { username: parts[0], repo: '' };
  if (parts.length === 2 && parts[0] && parts[1]) {
    const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -'.git'.length) : parts[1];
    if (repo) return { username: parts[0], repo };
  }
  throw new SubjectError(input);
}

/** True when `have` contains every type in `want`, ignoring case. */
export function hasAllWidgets(have: readonly string[], want: readonly string[]): boolean {
  return want.every(w => have.some(h => h.toLowerCase() === w.toLowerCase()));
}
