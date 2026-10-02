import { describe, expect, it } from 'vitest';
import type { AnyTool } from 'mayura';
import { testTool, toolGrants } from 'mayura/testing';
import { firecrawlTools } from '../src/index.js';
import { fakeFirecrawl } from './fake.js';

const base = { apiKey: 'fc-test-key-1', origins: ['https://example.com'] };
const find = (tools: AnyTool[], id: string) => tools.find(tool => tool.id === id)!;
const run = async (tools: AnyTool[], id: string, input: unknown, signal?: AbortSignal) =>
  (await testTool(find(tools, id), input, signal ? { signal } : {})).outcome as { status: string; output?: Record<string, unknown>; error?: { code: string; message: string } };

describe('firecrawlTools', () => {
  it('reads by default; search, crawl and extract each need enabling and their own permission; nothing is allowed without origins', () => {
    expect(firecrawlTools(base).map(tool => [tool.id, tool.capabilities])).toEqual([['web.scrape', ['web:web:read']], ['web.map', ['web:web:read']]]);
    expect(firecrawlTools({ ...base, name: 'research', search: true, crawl: true, extract: true, costMicros: { crawl: 9 } }).map(tool => [tool.id, tool.capabilities, tool.costMicros])).toEqual([
      ['research.scrape', ['web:research:read'], 0], ['research.map', ['web:research:read'], 0], ['research.search', ['web:research:search'], 0],
      ['research.crawl', ['web:research:crawl'], 9], ['research.extract', ['web:research:extract'], 0]]);
    expect(() => firecrawlTools({ apiKey: 'fc-test-key-1' } as never)).toThrow(/origins/u);
    expect(() => firecrawlTools({ ...base, apiKey: '' })).toThrow(/apiKey/u);
    expect(() => firecrawlTools({ ...base, name: 'Web Tools' })).toThrow(/name/u);
    expect(() => firecrawlTools({ ...base, maxCrawlPages: 1_000 })).toThrow(/maxCrawlPages/u);
    expect(() => firecrawlTools({ ...base, costMicros: { scrape: -1 } })).toThrow(/costMicros/u);
    expect(() => firecrawlTools({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
  });

  it('scrapes an allowed page, with TLS checked, bounded, and refuses other sites in words the model can act on', async () => {
    const fake = fakeFirecrawl();
    const tools = firecrawlTools({ ...base, fetch: fake.fetch, maxPageBytes: 1_024 });
    const outcome = await run(tools, 'web.scrape', { url: 'https://example.com/page' });
    expect(outcome).toMatchObject({ status: 'succeeded', output: { url: 'https://example.com/page', title: 'Example page', status: 200 } });
    expect(String(outcome.output!['markdown'])).toMatch(/^# Example/u);
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/v2/scrape', body: { url: 'https://example.com/page', formats: ['markdown'], onlyMainContent: true, skipTlsVerification: false } });
    expect(fake.seen[0]!.headers.get('authorization')).toBe('Bearer fc-test-key-1');
    const short = await run(firecrawlTools({ ...base, fetch: fake.fetch, maxPageBytes: 1_024 }), 'web.scrape', { url: 'https://example.com/', format: 'links' });
    expect(short.output!['links']).toEqual(['https://example.com/a', 'https://other.example/b']);
    const clipped = firecrawlTools({ ...base, fetch: fakeFirecrawl({ reply: seen => seen.path === '/v2/scrape' ? Response.json({ success: true, data: { markdown: 'x'.repeat(5_000), metadata: { url: 'https://example.com/' } } }) : undefined }).fetch, maxPageBytes: 1_024 });
    expect((await run(clipped, 'web.scrape', { url: 'https://example.com/' })).output).toMatchObject({ truncated: true });
    expect((await run(tools, 'web.scrape', { url: 'https://elsewhere.example/' })).output).toMatchObject({ error: 'PERMISSION_DENIED' });
    expect((await run(tools, 'web.scrape', { url: 'file:///etc/passwd' })).output).toMatchObject({ error: 'INVALID_INPUT' });
    expect((await run(tools, 'web.scrape', { url: 'https://example.com/', format: 'pdf' })).status).not.toBe('succeeded');
    expect(fake.seen).toHaveLength(2);
  });

  it('maps a site, and searches only when enabled', async () => {
    const fake = fakeFirecrawl();
    const tools = firecrawlTools({ ...base, fetch: fake.fetch, search: true });
    expect((await run(tools, 'web.map', { url: 'https://example.com/', limit: 20 })).output).toEqual({ url: 'https://example.com/', links: [{ url: 'https://example.com/', title: 'Home' }, { url: 'https://example.com/about' }] });
    expect(fake.seen[0]!.body).toEqual({ url: 'https://example.com/', limit: 20 });
    expect((await run(tools, 'web.search', { query: 'mayura agents' })).output).toEqual({ query: 'mayura agents', results: [{ url: 'https://example.com/', title: 'Example', description: 'A site.' }] });
    expect(fake.seen[1]!.body).toEqual({ query: 'mayura agents', limit: 5, sources: ['web'] });
  });

  it('crawls a site within its pages and origins, polling until done', async () => {
    const fake = fakeFirecrawl({ crawlPolls: 2 });
    const tools = firecrawlTools({ ...base, fetch: fake.fetch, crawl: true, maxCrawlPages: 5 });
    const outcome = await run(tools, 'web.crawl', { url: 'https://example.com/', limit: 3, includePaths: '^/docs/' });
    expect(outcome.output).toEqual({ url: 'https://example.com/', pages: [
      { url: 'https://example.com/one', title: 'One', status: 200, markdown: '# One' }, { url: 'https://example.com/two', title: 'Two', status: 200, markdown: '# Two' }] });
    expect(fake.seen[0]!.body).toEqual({ url: 'https://example.com/', limit: 3, allowExternalLinks: false, allowSubdomains: false, includePaths: ['^/docs/'],
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true, skipTlsVerification: false } });
    expect(fake.seen.filter(item => item.method === 'GET')).toHaveLength(2);
    expect([...fake.crawls.values()][0]!.cancelled).toBe(false);
    expect((await run(tools, 'web.crawl', { url: 'https://example.com/', limit: 6 })).status).not.toBe('succeeded');
  });

  it('cancels a crawl that is cancelled, times out or fails', async () => {
    const fake = fakeFirecrawl({ crawlPolls: 1_000 });
    const tools = firecrawlTools({ ...base, fetch: fake.fetch, crawl: true, crawlTimeoutMs: 10_000 });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 300);
    expect((await run(tools, 'web.crawl', { url: 'https://example.com/' }, controller.signal)).status).not.toBe('succeeded');
    expect([...fake.crawls.values()][0]!.cancelled).toBe(true);
    const failed = fakeFirecrawl({ crawlStatus: 'failed' });
    expect((await run(firecrawlTools({ ...base, fetch: failed.fetch, crawl: true }), 'web.crawl', { url: 'https://example.com/' })).status).toBe('failed');
  }, 20_000);

  it('extracts structured data from an allowed page, bounded', async () => {
    const fake = fakeFirecrawl();
    const tools = firecrawlTools({ ...base, fetch: fake.fetch, extract: true });
    const outcome = await run(tools, 'web.extract', { url: 'https://example.com/item', prompt: 'the price', schema: { type: 'object', properties: { price: { type: 'number' } } } });
    expect(outcome.output).toEqual({ url: 'https://example.com/item', data: { price: 42, prompt: 'the price' } });
    expect(fake.seen[0]!.body).toMatchObject({ url: 'https://example.com/item', skipTlsVerification: false, formats: [{ type: 'json', prompt: 'the price', schema: { type: 'object' } }] });
    const big = fakeFirecrawl({ reply: seen => seen.path === '/v2/scrape' ? Response.json({ success: true, data: { json: { text: 'x'.repeat(5_000) } } }) : undefined });
    expect((await run(firecrawlTools({ ...base, fetch: big.fetch, extract: true, maxPageBytes: 1_024 }), 'web.extract', { url: 'https://example.com/', prompt: 'all' })).output).toMatchObject({ error: 'LIMIT_EXCEEDED' });
  });

  it('fails Firecrawl\'s refusals without what it wrote, and runs only with its permission', async () => {
    const fake = fakeFirecrawl({ reply: () => Response.json({ success: false, error: 'secret detail' }, { status: 500 }) });
    const tools = firecrawlTools({ ...base, fetch: fake.fetch });
    const outcome = await run(tools, 'web.scrape', { url: 'https://example.com/' });
    expect(outcome.status).toBe('failed'); expect(JSON.stringify(outcome)).not.toContain('secret');
    const quiet = fakeFirecrawl({ reply: () => Response.json({ success: false, error: 'nope' }) });
    expect((await run(firecrawlTools({ ...base, fetch: quiet.fetch }), 'web.scrape', { url: 'https://example.com/' })).status).toBe('failed');
    const scrape = find(firecrawlTools({ ...base, fetch: fakeFirecrawl().fetch }), 'web.scrape');
    const { outcome: blocked } = await testTool(scrape, { url: 'https://example.com/' }, { permissions: toolGrants(scrape).filter(grant => !grant.startsWith('web:')) });
    expect(blocked).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
  });
});
