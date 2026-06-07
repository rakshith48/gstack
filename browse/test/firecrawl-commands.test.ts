// Unit tests for browse/src/firecrawl-commands.ts — argument parsing, result
// normalization (the output contract), and the unconfigured-key error path.
// All browser-free: no daemon or Chromium required.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSearchArgs, parseFetchArgs, normalizeWebResult, firecrawlSearch } from '../src/firecrawl-commands';
import { _resetFirecrawlClient } from '../src/firecrawl-client';

describe('parseSearchArgs', () => {
  test('joins positional tokens into the query, default limit 5, no scrape', () => {
    expect(parseSearchArgs(['best', 'rust', 'http', 'client'])).toEqual({
      query: 'best rust http client',
      limit: 5,
      scrape: false,
    });
  });

  test('parses --limit N (space form)', () => {
    expect(parseSearchArgs(['firecrawl', '--limit', '10'])).toEqual({
      query: 'firecrawl',
      limit: 10,
      scrape: false,
    });
  });

  test('parses --limit=N (equals form)', () => {
    expect(parseSearchArgs(['firecrawl', '--limit=3'])).toMatchObject({ limit: 3 });
  });

  test('parses --scrape and keeps it separate from the query', () => {
    const parsed = parseSearchArgs(['llm', 'eval', '--scrape', '--limit', '2']);
    expect(parsed).toEqual({ query: 'llm eval', limit: 2, scrape: true });
  });

  test('ignores invalid/zero --limit, keeping the default', () => {
    expect(parseSearchArgs(['x', '--limit', 'abc']).limit).toBe(5);
    expect(parseSearchArgs(['x', '--limit', '0']).limit).toBe(5);
  });

  test('empty args → empty query', () => {
    expect(parseSearchArgs([]).query).toBe('');
  });
});

describe('parseFetchArgs', () => {
  test('bare url → auto engine, no flags', () => {
    expect(parseFetchArgs(['https://a.dev'])).toEqual({
      url: 'https://a.dev',
      engine: 'auto',
      html: false,
      links: false,
      full: false,
      wait: undefined,
    });
  });

  test('--html and --links flags', () => {
    expect(parseFetchArgs(['https://a.dev', '--html', '--links'])).toMatchObject({
      html: true,
      links: true,
    });
  });

  test('--full flag', () => {
    expect(parseFetchArgs(['https://a.dev', '--full']).full).toBe(true);
  });

  test('--wait <ms> (space + equals forms), rejects non-numeric', () => {
    expect(parseFetchArgs(['https://a.dev', '--wait', '3000']).wait).toBe(3000);
    expect(parseFetchArgs(['https://a.dev', '--wait=1500']).wait).toBe(1500);
    expect(parseFetchArgs(['https://a.dev', '--wait', 'soon']).wait).toBeUndefined();
  });

  test('--engine browser / firecrawl (space + equals forms)', () => {
    expect(parseFetchArgs(['https://a.dev', '--engine', 'browser']).engine).toBe('browser');
    expect(parseFetchArgs(['https://a.dev', '--engine=firecrawl']).engine).toBe('firecrawl');
  });

  test('invalid --engine value is ignored (stays auto)', () => {
    expect(parseFetchArgs(['https://a.dev', '--engine', 'bogus']).engine).toBe('auto');
  });

  test('first positional is the url; flags are not', () => {
    expect(parseFetchArgs(['--links', 'https://a.dev']).url).toBe('https://a.dev');
  });

  test('no url → empty string (handler raises usage)', () => {
    expect(parseFetchArgs(['--html']).url).toBe('');
  });
});

describe('firecrawlFetch', () => {
  test('throws a usage error when no url is given', async () => {
    const { firecrawlFetch } = await import('../src/firecrawl-commands');
    await expect(firecrawlFetch(['--html'], {} as any)).rejects.toThrow(/Usage: browse fetch/);
  });
});

describe('normalizeWebResult', () => {
  test('bare web hit → url/title/description, no markdown', () => {
    expect(
      normalizeWebResult({ url: 'https://a.dev', title: 'A', description: 'desc' }),
    ).toEqual({ url: 'https://a.dev', title: 'A', description: 'desc', markdown: undefined });
  });

  test('scraped Document → markdown + fields from metadata fallback', () => {
    const out = normalizeWebResult({
      markdown: '# Hello',
      metadata: { sourceURL: 'https://b.dev', title: 'B', description: 'from meta' },
    } as any);
    expect(out).toEqual({
      url: 'https://b.dev',
      title: 'B',
      description: 'from meta',
      markdown: '# Hello',
    });
  });

  test('top-level url/title win over metadata when both present', () => {
    const out = normalizeWebResult({
      url: 'https://top.dev',
      title: 'Top',
      metadata: { sourceURL: 'https://meta.dev', title: 'Meta' },
    } as any);
    expect(out.url).toBe('https://top.dev');
    expect(out.title).toBe('Top');
  });
});

describe('firecrawlSearch', () => {
  test('throws a usage error when the query is empty', async () => {
    await expect(firecrawlSearch(['--limit', '5'])).rejects.toThrow(/Usage: browse search/);
  });

  describe('with no key configured', () => {
    let tmpHome: string;
    let savedKey: string | undefined;
    let savedHome: string | undefined;

    beforeEach(() => {
      savedKey = process.env.FIRECRAWL_API_KEY;
      savedHome = process.env.GSTACK_HOME;
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cmd-test-'));
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

    test('throws the actionable config error (no browser fallback for search)', async () => {
      const cliCreds =
        process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support', 'firecrawl-cli', 'credentials.json')
          : process.platform === 'win32'
            ? path.join(process.env.APPDATA || '', 'firecrawl-cli', 'credentials.json')
            : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'firecrawl-cli', 'credentials.json');
      if (fs.existsSync(cliCreds)) return; // skip: real CLI login present
      await expect(firecrawlSearch(['rust'])).rejects.toThrow(/Firecrawl is not configured/);
    });
  });
});
