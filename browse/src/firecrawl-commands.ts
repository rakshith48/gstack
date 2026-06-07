/**
 * Firecrawl-backed `$B` command handlers (search + fetch).
 *
 * These are read commands dispatched from read-commands.ts. Their output is
 * untrusted external web content and is wrapped + content-filtered by the
 * server's centralized envelope (search/fetch are in PAGE_CONTENT_COMMANDS),
 * exactly like `text`/`html`/`links`.
 *
 * Output is normalized JSON so downstream skills don't care which engine ran:
 *   search: { query, engine, results: [{ url, title?, description?, markdown? }] }
 *   fetch:  { url, title?, markdown, links?, engine }   (fetch lands in a later commit)
 */

import type { Document, SearchResultWeb } from '@mendable/firecrawl-js';
import type { TabSession } from './tab-session';
import { getFirecrawl, firecrawlEnabled, getWebEngine, type WebEngine } from './firecrawl-client';
import { validateNavigationUrl } from './url-validation';
import { getCleanText } from './read-commands';
import { stripLoneSurrogates } from './sanitize';

// NOTE: Firecrawl's `integration` field is a server-validated enum (dify, zapier,
// langchain, crewai, cli, …). 'gstack' is not registered yet, so sending it makes
// the API reject every call ("Invalid request body"). Once Firecrawl adds 'gstack'
// to the enum, pass `integration: FIRECRAWL_INTEGRATION` on search/scrape for
// usage attribution. Until then we omit it.

const DEFAULT_SEARCH_LIMIT = 5;

interface NormalizedSearchResult {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
}

interface ParsedSearchArgs {
  query: string;
  limit: number;
  scrape: boolean;
}

/** Parse `search <query…> [--limit N] [--scrape]`. Positional tokens form the query. */
export function parseSearchArgs(args: string[]): ParsedSearchArgs {
  let limit = DEFAULT_SEARCH_LIMIT;
  let scrape = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scrape') {
      scrape = true;
    } else if (a === '--limit') {
      const v = parseInt(args[++i] ?? '', 10);
      if (!Number.isNaN(v) && v > 0) limit = v;
    } else if (a.startsWith('--limit=')) {
      const v = parseInt(a.slice('--limit='.length), 10);
      if (!Number.isNaN(v) && v > 0) limit = v;
    } else {
      positional.push(a);
    }
  }

  return { query: positional.join(' ').trim(), limit, scrape };
}

/** Pull the normalized fields off a web result, which is a bare hit or a scraped Document. */
export function normalizeWebResult(r: SearchResultWeb | Document): NormalizedSearchResult {
  const doc = r as Document & SearchResultWeb;
  const markdown = typeof doc.markdown === 'string' ? stripLoneSurrogates(doc.markdown) : undefined;
  return {
    url: doc.url ?? doc.metadata?.sourceURL ?? '',
    title: doc.title ?? doc.metadata?.title ?? undefined,
    description: doc.description ?? doc.metadata?.description ?? undefined,
    markdown,
  };
}

/**
 * `$B search "<query>" [--limit N] [--scrape]` — web search via Firecrawl.
 * With --scrape, each result is fetched to markdown inline. No browser
 * fallback: gstack has no native search engine, so an unconfigured key throws
 * an actionable error (the /web-search skill hands off to native search).
 */
export async function firecrawlSearch(args: string[]): Promise<string> {
  const { query, limit, scrape } = parseSearchArgs(args);
  if (!query) {
    throw new Error('Usage: browse search <query> [--limit N] [--scrape]');
  }

  const fc = getFirecrawl(); // throws an actionable, secret-free error if no key
  const data = await fc.search(query, {
    limit,
    ...(scrape
      ? { scrapeOptions: { formats: ['markdown'], onlyMainContent: true } }
      : {}),
  });

  const results = (data.web ?? [])
    .map(normalizeWebResult)
    .filter((r) => r.url);

  return JSON.stringify({ query, engine: 'firecrawl', results }, null, 2);
}

// ─── fetch (URL → clean markdown, Firecrawl-first with browser fallback) ──────

interface NormalizedFetchResult {
  url: string;
  title?: string;
  markdown: string;
  links?: string[];
  html?: string;
  engine: 'firecrawl' | 'browser';
  /** Subtle discovery hint, set at most once per session — see FIRECRAWL_FETCH_HINT. */
  note?: string;
}

/**
 * Shown at most once per daemon session: when `$B fetch` falls back to the local
 * browser purely because no Firecrawl key is configured, note that Firecrawl
 * yields cleaner markdown. Subtle and contextual — never on the happy path (key
 * present) nor when the user explicitly chose `--engine browser`. A descriptive
 * statement, not an imperative, so it reads as metadata rather than an
 * instruction even inside the untrusted-content envelope.
 */
const FIRECRAWL_FETCH_HINT =
  'Fetched with the local browser. Firecrawl returns cleaner markdown for pages like this — `npx firecrawl-cli login --method browser` (or set FIRECRAWL_API_KEY) to enable.';
let browserFallbackHintShown = false;

/** Test seam: reset the once-per-session hint flag. */
export function _resetFetchHint(): void {
  browserFallbackHintShown = false;
}

interface FetchFormats {
  html: boolean;
  links: boolean;
}

interface ParsedFetchArgs extends FetchFormats {
  url: string;
  engine: WebEngine; // from --engine; 'auto' when unspecified
}

/** Parse `fetch <url> [--html] [--links] [--engine firecrawl|browser|auto]`. */
export function parseFetchArgs(args: string[]): ParsedFetchArgs {
  let engine: WebEngine = 'auto';
  let html = false;
  let links = false;
  const positional: string[] = [];

  const setEngine = (v: string | undefined): void => {
    if (v === 'firecrawl' || v === 'browser' || v === 'auto') engine = v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--html') html = true;
    else if (a === '--links') links = true;
    else if (a === '--engine') setEngine(args[++i]);
    else if (a.startsWith('--engine=')) setEngine(a.slice('--engine='.length));
    else positional.push(a);
  }

  return { url: positional[0] ?? '', engine, html, links };
}

/** Firecrawl returned nothing usable (login wall, JS-gated SPA) → fall back. */
function isEmptyMarkdown(md: string | undefined): boolean {
  return !md || md.trim().length < 8;
}

async function fetchViaFirecrawl(url: string, opts: FetchFormats): Promise<NormalizedFetchResult> {
  const formats: Array<'markdown' | 'links' | 'html'> = ['markdown'];
  if (opts.links) formats.push('links');
  if (opts.html) formats.push('html');

  const doc = await getFirecrawl().scrape(url, { formats, onlyMainContent: true });
  return {
    url: doc.metadata?.sourceURL ?? url,
    title: doc.metadata?.title ?? undefined,
    markdown: stripLoneSurrogates(doc.markdown ?? ''),
    links: opts.links ? doc.links : undefined,
    html: opts.html && typeof doc.html === 'string' ? stripLoneSurrogates(doc.html) : undefined,
    engine: 'firecrawl',
  };
}

/**
 * Browser fallback: navigate the active tab and extract cleaned text. The
 * `markdown` field carries cleaned page text (not faithful markdown) — the
 * `engine: 'browser'` flag signals that to consumers. Navigation is gated by
 * validateNavigationUrl (same SSRF guard as `$B goto`).
 */
async function fetchViaBrowser(url: string, session: TabSession, opts: FetchFormats): Promise<NormalizedFetchResult> {
  const normalized = await validateNavigationUrl(url);
  const page = session.getPage();
  await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const title = await page.title().catch(() => undefined);
  const markdown = stripLoneSurrogates(await getCleanText(page));
  let links: string[] | undefined;
  if (opts.links) {
    links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href),
    );
  }
  const html = opts.html ? stripLoneSurrogates(await page.content()) : undefined;

  return { url: page.url(), title, markdown, links, html, engine: 'browser' };
}

/**
 * `$B fetch <url>` — URL → clean markdown via Firecrawl, with automatic browser
 * fallback. Policy (the hybrid router): `--engine`/config force a single engine;
 * otherwise (auto) try Firecrawl first when a key is configured and fall back to
 * the local browser on throw or empty markdown; with no key, go straight to the
 * browser (no nagging — the browser already fetches URLs well).
 */
export async function firecrawlFetch(args: string[], session: TabSession): Promise<string> {
  const { url, engine, html, links } = parseFetchArgs(args);
  if (!url) {
    throw new Error('Usage: browse fetch <url> [--html] [--links] [--engine firecrawl|browser]');
  }
  const opts: FetchFormats = { html, links };
  const effective: WebEngine = engine !== 'auto' ? engine : getWebEngine();

  let result: NormalizedFetchResult;
  if (effective === 'browser') {
    result = await fetchViaBrowser(url, session, opts);
  } else if (effective === 'firecrawl') {
    // Explicitly forced: surface the actionable config error if no key; no fallback.
    result = await fetchViaFirecrawl(url, opts);
  } else if (!firecrawlEnabled()) {
    // Auto mode + no key: the browser handles it, but Firecrawl would do better.
    // Surface the upgrade once per session — the quality-gap discovery moment.
    result = await fetchViaBrowser(url, session, opts);
    if (!browserFallbackHintShown) {
      result.note = FIRECRAWL_FETCH_HINT;
      browserFallbackHintShown = true;
    }
  } else {
    try {
      const viaCloud = await fetchViaFirecrawl(url, opts);
      result = isEmptyMarkdown(viaCloud.markdown)
        ? await fetchViaBrowser(url, session, opts)
        : viaCloud;
    } catch {
      result = await fetchViaBrowser(url, session, opts);
    }
  }

  return JSON.stringify(result, null, 2);
}
