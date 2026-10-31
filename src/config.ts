/**
 * Resolve the CLI's API key and server URL.
 *
 * Precedence, highest first: command-line flag, environment variable
 * (GHCARD_API_KEY, GHCARD_BASE_URL), then the config file written by
 * `ghcard auth login`. Environment variables let CI jobs and AI agents run
 * without touching the user's config file.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ENV_API_KEY = 'GHCARD_API_KEY';
export const ENV_BASE_URL = 'GHCARD_BASE_URL';
export const ENV_CONFIG = 'GHCARD_CONFIG';

/** The on-disk config. It holds a secret, so it is written 0600. */
export interface ConfigFile {
  apiKey?: string;
  baseUrl?: string;
}

export type Source = 'flag' | 'env' | 'config' | 'default' | 'none';

export interface Resolved {
  apiKey: string;
  apiKeySource: Source;
  baseUrl: string;
  baseUrlSource: Source;
}

/** The same directory Go's os.UserConfigDir returns, so existing configs keep working. */
function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    if (!env.APPDATA) throw new Error('find config directory: %AppData% is not set');
    return env.APPDATA;
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

/** $GHCARD_CONFIG, or <user config dir>/ghcard/config.json. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_CONFIG] || join(userConfigDir(env), 'ghcard', 'config.json');
}

/** Read the config file. A missing file is an empty config. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ConfigFile> {
  const path = configPath(env);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`read ${path}: ${(error as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    const file = parsed as Record<string, unknown>;
    return {
      ...(typeof file.apiKey === 'string' && file.apiKey ? { apiKey: file.apiKey } : {}),
      ...(typeof file.baseUrl === 'string' && file.baseUrl ? { baseUrl: file.baseUrl } : {}),
    };
  } catch (error) {
    throw new Error(`parse ${path}: ${(error as Error).message}`);
  }
}

/** Write the config file with owner-only permissions; returns its path. */
export async function saveConfig(file: ConfigFile, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body: ConfigFile = {};
  if (file.apiKey) body.apiKey = file.apiKey;
  if (file.baseUrl) body.baseUrl = file.baseUrl;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/** Apply flag > env > file > default. */
export async function resolveConfig(
  flags: { apiKey?: string; baseUrl?: string },
  defaultBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Resolved> {
  const file = await loadConfig(env);
  const r: Resolved = { apiKey: '', apiKeySource: 'none', baseUrl: defaultBaseUrl, baseUrlSource: 'default' };
  if (flags.apiKey) [r.apiKey, r.apiKeySource] = [flags.apiKey, 'flag'];
  else if (env[ENV_API_KEY]) [r.apiKey, r.apiKeySource] = [env[ENV_API_KEY], 'env'];
  else if (file.apiKey) [r.apiKey, r.apiKeySource] = [file.apiKey, 'config'];

  if (flags.baseUrl) [r.baseUrl, r.baseUrlSource] = [flags.baseUrl, 'flag'];
  else if (env[ENV_BASE_URL]) [r.baseUrl, r.baseUrlSource] = [env[ENV_BASE_URL], 'env'];
  else if (file.baseUrl) [r.baseUrl, r.baseUrlSource] = [file.baseUrl, 'config'];
  return r;
}

/** Enough of a key to recognise it and none of the secret. */
export function maskKey(key: string): string {
  return key.length <= 20 ? '****' : `${key.slice(0, 20)}…`;
}
