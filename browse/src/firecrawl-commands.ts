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
import { getFirecrawl } from './firecrawl-client';
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
