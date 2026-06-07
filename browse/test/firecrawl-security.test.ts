// Security contract for the Firecrawl commands. Firecrawl returns untrusted
// external web content, so search/fetch MUST ride the same envelope +
// content-filter path as every other read command. This test pins that wiring
// so a future refactor can't silently drop search/fetch out of it.

import { describe, test, expect } from 'bun:test';
import {
  READ_COMMANDS,
  PAGE_CONTENT_COMMANDS,
  DOM_CONTENT_COMMANDS,
  COMMAND_DESCRIPTIONS,
  wrapUntrustedContent,
} from '../src/commands';

describe('firecrawl commands — registration', () => {
  test('search + fetch are read commands', () => {
    expect(READ_COMMANDS.has('search')).toBe(true);
    expect(READ_COMMANDS.has('fetch')).toBe(true);
  });

  test('search + fetch have command descriptions (load-time validation passes)', () => {
    expect(COMMAND_DESCRIPTIONS.search).toBeDefined();
    expect(COMMAND_DESCRIPTIONS.fetch).toBeDefined();
  });
});

describe('firecrawl commands — untrusted-content wiring', () => {
  test('search + fetch are in PAGE_CONTENT_COMMANDS (envelope-wrapped like every read)', () => {
    expect(PAGE_CONTENT_COMMANDS.has('search')).toBe(true);
    expect(PAGE_CONTENT_COMMANDS.has('fetch')).toBe(true);
  });

  test('search + fetch are NOT in DOM_CONTENT_COMMANDS (cloud content has no live DOM to hidden-scan)', () => {
    expect(DOM_CONTENT_COMMANDS.has('search')).toBe(false);
    expect(DOM_CONTENT_COMMANDS.has('fetch')).toBe(false);
  });

  test('the envelope wraps Firecrawl JSON output', () => {
    const wrapped = wrapUntrustedContent('{"engine":"firecrawl","results":[]}', 'about:blank');
    expect(wrapped).toContain('BEGIN UNTRUSTED EXTERNAL CONTENT');
    expect(wrapped).toContain('END UNTRUSTED EXTERNAL CONTENT');
  });
});
