// Unit tests for browse/src/firecrawl-client.ts — the API-key resolution chain
// (env → ~/.gstack/config.yaml → firecrawl-cli credentials) and the lazy client.
//
// We drive resolution deterministically by controlling FIRECRAWL_API_KEY and
// GSTACK_HOME (which getFirecrawl()'s config read derives from). The CLI
// credentials path is platform-specific and not asserted as the *only* source,
// so these tests never depend on whether `firecrawl login` has run locally.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveFirecrawlKey,
  firecrawlEnabled,
  firecrawlStatusLine,
  getFirecrawl,
  _resetFirecrawlClient,
} from '../src/firecrawl-client';

let tmpHome: string;
let savedKey: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedKey = process.env.FIRECRAWL_API_KEY;
  savedHome = process.env.GSTACK_HOME;
  // Point gstack-config reads at an empty temp home so a real ~/.gstack/config.yaml
  // can't leak into the test.
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-client-test-'));
  process.env.GSTACK_HOME = tmpHome;
  delete process.env.FIRECRAWL_API_KEY;
  _resetFirecrawlClient();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = savedKey;
  if (savedHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  _resetFirecrawlClient();
});

function writeConfig(line: string): void {
  fs.writeFileSync(path.join(tmpHome, 'config.yaml'), `${line}\n`, 'utf-8');
}

describe('resolveFirecrawlKey', () => {
  test('returns the env key when FIRECRAWL_API_KEY is set', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-env-123';
    expect(resolveFirecrawlKey(true)).toBe('fc-env-123');
  });

  test('falls back to gstack-config firecrawl_key when env is unset', () => {
    writeConfig('firecrawl_key: fc-config-456');
    expect(resolveFirecrawlKey(true)).toBe('fc-config-456');
  });

  test('env key takes precedence over gstack-config', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-env-win';
    writeConfig('firecrawl_key: fc-config-lose');
    expect(resolveFirecrawlKey(true)).toBe('fc-env-win');
  });

  test('ignores blank/whitespace env values', () => {
    process.env.FIRECRAWL_API_KEY = '   ';
    writeConfig('firecrawl_key: fc-config-used');
    expect(resolveFirecrawlKey(true)).toBe('fc-config-used');
  });

  test('memoizes until reset/force', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-first';
    expect(resolveFirecrawlKey(true)).toBe('fc-first');
    process.env.FIRECRAWL_API_KEY = 'fc-second';
    expect(resolveFirecrawlKey()).toBe('fc-first'); // cached
    expect(resolveFirecrawlKey(true)).toBe('fc-second'); // forced re-resolve
  });
});

describe('firecrawlEnabled', () => {
  test('true when a key is configured', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-on';
    _resetFirecrawlClient();
    expect(firecrawlEnabled()).toBe(true);
  });
});

describe('firecrawlStatusLine', () => {
  test('reports configured (never the key itself) when a key is present', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-secret-do-not-print';
    _resetFirecrawlClient();
    const line = firecrawlStatusLine();
    expect(line).toContain('Firecrawl: configured');
    expect(line).not.toContain('fc-secret-do-not-print');
  });

  test('points unconfigured users at firecrawl-cli login', () => {
    // Deterministic only when the machine has no firecrawl-cli credentials.
    const cliCreds =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'firecrawl-cli', 'credentials.json')
        : process.platform === 'win32'
          ? path.join(process.env.APPDATA || '', 'firecrawl-cli', 'credentials.json')
          : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'firecrawl-cli', 'credentials.json');
    if (fs.existsSync(cliCreds)) return;
    _resetFirecrawlClient();
    const line = firecrawlStatusLine();
    expect(line).toContain('not configured');
    expect(line).toContain('firecrawl-cli login');
  });
});

describe('getFirecrawl', () => {
  test('throws an actionable, secret-free error when unconfigured', () => {
    // Empty temp home + no env. Only fails if the local machine has firecrawl-cli
    // credentials at the platform path, so guard on that file's absence.
    const cliCreds =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'firecrawl-cli', 'credentials.json')
        : process.platform === 'win32'
          ? path.join(process.env.APPDATA || '', 'firecrawl-cli', 'credentials.json')
          : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'firecrawl-cli', 'credentials.json');
    if (fs.existsSync(cliCreds)) return; // skip: real CLI login present

    _resetFirecrawlClient();
    expect(() => getFirecrawl()).toThrow(/Firecrawl is not configured/);
  });

  test('returns a client when a key is present', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-present';
    _resetFirecrawlClient();
    const client = getFirecrawl();
    expect(client).toBeDefined();
    // memoized: same instance on second call
    expect(getFirecrawl()).toBe(client);
  });
});
