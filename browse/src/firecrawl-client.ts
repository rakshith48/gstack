/**
 * Firecrawl cloud client — backs `$B search` and `$B fetch`.
 *
 * Lazy singleton. The API key is resolved once, on first use, from (in order):
 *   1. FIRECRAWL_API_KEY env
 *   2. ~/.gstack/config.yaml  `firecrawl_key:`  (set via `gstack-config set firecrawl_key …`)
 *   3. firecrawl-cli credentials.json (platform-specific path) — reused if the
 *      user ran `firecrawl login` / `npx firecrawl-cli login`
 *
 * Only search/fetch use this; the rest of browse stays on the local Chromium
 * daemon (see firecrawl-router.ts for the fallback policy). The key is a secret:
 * resolved from env/file only, never logged or echoed.
 */

import Firecrawl from '@mendable/firecrawl-js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveGstackHome } from './config';

/**
 * Attribution tag for usage analytics. Reserved for when Firecrawl registers
 * 'gstack' in its server-side `integration` enum — until then, sending it makes
 * the API reject the request, so callers omit it (see firecrawl-commands.ts).
 */
export const FIRECRAWL_INTEGRATION = 'gstack';

let _client: Firecrawl | null = null;
let _resolvedKey: string | null | undefined; // undefined = not yet resolved

/**
 * Platform-specific firecrawl-cli credentials path. Mirrors
 * firecrawl-cli/src/utils/credentials.ts so a key written by `firecrawl login`
 * (or `npx firecrawl-cli login`) is picked up without a global install.
 */
function firecrawlCliCredentialsPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'firecrawl-cli', 'credentials.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'firecrawl-cli', 'credentials.json');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'firecrawl-cli', 'credentials.json');
  }
}

/** Read a top-level `key: value` from ~/.gstack/config.yaml. Returns null if absent/unreadable. */
function readGstackConfigKey(key: string): string | null {
  try {
    const configPath = path.join(resolveGstackHome(), 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf-8');
    const m = content.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'));
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** Read the apiKey from firecrawl-cli credentials.json, if present. */
function readCliCredentialKey(): string | null {
  try {
    const data = fs.readFileSync(firecrawlCliCredentialsPath(), 'utf-8');
    const creds = JSON.parse(data) as { apiKey?: string };
    return creds.apiKey?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Firecrawl API key from env → gstack-config → firecrawl-cli creds.
 * Memoized after first resolution; pass force=true to re-resolve (tests).
 */
export function resolveFirecrawlKey(force = false): string | null {
  if (!force && _resolvedKey !== undefined) return _resolvedKey;
  const envKey = process.env.FIRECRAWL_API_KEY?.trim();
  _resolvedKey =
    (envKey || null) ??
    readGstackConfigKey('firecrawl_key') ??
    readCliCredentialKey();
  return _resolvedKey;
}

/** True when a Firecrawl API key is configured (env, gstack-config, or CLI login). */
export function firecrawlEnabled(): boolean {
  return resolveFirecrawlKey() !== null;
}

/**
 * One-line Firecrawl state for `$B status`. Reports configured vs not (never the
 * key itself), and points unconfigured users at the lightest activation path.
 */
export function firecrawlStatusLine(): string {
  return firecrawlEnabled()
    ? 'Firecrawl: configured (web search + clean fetch enabled)'
    : 'Firecrawl: not configured — `npx firecrawl-cli login --method browser` for web search + cleaner fetch';
}

export type WebEngine = 'auto' | 'firecrawl' | 'browser';

/**
 * The configured web engine for `$B fetch`: `gstack-config get web_engine`
 * (auto | firecrawl | browser), defaulting to 'auto'. Unknown values fall back
 * to 'auto'. A `--engine` flag on the command overrides this per call.
 */
export function getWebEngine(): WebEngine {
  const v = readGstackConfigKey('web_engine');
  return v === 'firecrawl' || v === 'browser' ? v : 'auto';
}

/**
 * The lazily-instantiated Firecrawl client.
 * Throws an actionable, secret-free error when no key is configured.
 */
export function getFirecrawl(): Firecrawl {
  const key = resolveFirecrawlKey();
  if (!key) {
    throw new Error(
      'Firecrawl is not configured. Set FIRECRAWL_API_KEY, run ' +
      '`gstack-config set firecrawl_key fc-…`, or `npx firecrawl-cli login --method browser` for browser sign-in.',
    );
  }
  if (!_client) {
    _client = new Firecrawl({ apiKey: key });
  }
  return _client;
}

/** Test seam: reset the memoized client + key so the next call re-resolves. */
export function _resetFirecrawlClient(): void {
  _client = null;
  _resolvedKey = undefined;
}
