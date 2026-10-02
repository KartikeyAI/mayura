import { describe, expect, it } from 'vitest';
import type { AnyTool } from 'mayura';
import { testTool, toolGrants } from 'mayura/testing';
import { cloudflareQuickActions, originPatterns, quickActionTools } from '../src/index.js';
import { fakeBrowserRun } from './fake.js';

const base = { accountId: '0123456789abcdef0123456789abcdef', apiToken: 'cf_test_token_0123456789abcdef' };
const actionsWith = (fake: ReturnType<typeof fakeBrowserRun>) => cloudflareQuickActions({ ...base, fetch: fake.fetch });
const find = (tools: AnyTool[], id: string) => tools.find(tool => tool.id === id)!;
const run = async (tools: AnyTool[], id: string, input: unknown, signal?: AbortSignal) =>
  (await testTool(find(tools, id), input, signal ? { signal } : {})).outcome as { status: string; output?: Record<string, unknown>; error?: { code: string; message: string } };

describe('cloudflareQuickActions', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => cloudflareQuickActions({ ...base, accountId: 'acme' })).toThrow(/accountId/u);
    expect(() => cloudflareQuickActions({ ...base, apiToken: 'short' })).toThrow(/apiToken/u);
    expect(() => cloudflareQuickActions({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
  });

  it('calls each action on the account\'s Browser Run, with the token, and reads its result', async () => {
    const fake = fakeBrowserRun(); const actions = actionsWith(fake);
    expect(await actions.markdown({ url: 'https://example.com/' })).toMatch(/^# Example/u);
    expect(fake.seen[0]).toMatchObject({ method: 'POST', path: '/markdown', body: { url: 'https://example.com/' } });
    expect(fake.seen[0]!.headers.get('authorization')).toBe('Bearer cf_test_token_0123456789abcdef');
    expect(await actions.content({ url: 'https://example.com/', allowRequestPattern: ['^https://example\\.com/'] })).toBe('<html><h1>Example</h1></html>');
    expect(fake.seen[1]!.body).toEqual({ url: 'https://example.com/', allowRequestPattern: ['^https://example\\.com/'] });
    expect(await actionsWith(fakeBrowserRun({ htmlAsText: true })).content({ url: 'https://example.com/' })).toBe('<html><h1>Example</h1></html>');
    expect(await actions.links({ url: 'https://example.com/', visibleLinksOnly: true })).toEqual(['https://example.com/a', 'https://other.example/b']);
    expect(fake.seen.at(-1)!.body).toEqual({ url: 'https://example.com/', visibleLinksOnly: true });
    expect(await actions.scrape({ url: 'https://example.com/', selectors: ['h1'] })).toEqual([{ selector: 'h1', results: [{ text: 'Example', html: 'Example', attributes: [{ name: 'class', value: 'title' }] }] }]);
    expect(fake.seen.at(-1)!.body).toEqual({ url: 'https://example.com/', elements: [{ selector: 'h1' }] });
    expect([...await actions.screenshot({ url: 'https://example.com/', fullPage: true })]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(fake.seen.at(-1)!.body).toEqual({ url: 'https://example.com/', screenshotOptions: { type: 'png', fullPage: true } });
    expect([...await actions.pdf({ url: 'https://example.com/' })]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(await actions.json({ url: 'https://example.com/', prompt: 'the price', schema: { type: 'object' } })).toEqual({ price: 42 });
    expect(fake.seen.at(-1)!.body).toEqual({ url: 'https://example.com/', prompt: 'the price', response_format: { type: 'json_schema', json_schema: { type: 'object' } } });
  });

  it('refuses requests it cannot send, and failures without what Cloudflare wrote', async () => {
    const actions = actionsWith(fakeBrowserRun());
    await expect(actions.markdown({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(actions.scrape({ url: 'https://example.com/', selectors: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(actions.json({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const status of [401, 429, 500]) {
      const failing = actionsWith(fakeBrowserRun({ reply: () => Response.json({ success: false, errors: [{ message: 'secret detail' }] }, { status }) }));
      const error = await failing.markdown({ url: 'https://example.com/' }).catch(caught => caught);
      expect(error).toMatchObject({ code: 'TOOL_FAILED' }); expect(error.message).not.toContain('secret');
    }
    const unsure = actionsWith(fakeBrowserRun({ reply: () => Response.json({ success: false, result: 'x' }) }));
    await expect(unsure.markdown({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    const jsonImage = actionsWith(fakeBrowserRun({ reply: seen => seen.path === '/screenshot' ? Response.json({ success: false }) : undefined }));
    await expect(jsonImage.screenshot({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });

  it('starts, checks and cancels crawls, on the same site unless asked', async () => {
    const fake = fakeBrowserRun(); const actions = actionsWith(fake);
    const id = await actions.crawl.start({ url: 'https://example.com/', limit: 5, includePatterns: ['https://example.com/docs/**'] });
    expect(fake.seen[0]!.body).toEqual({ url: 'https://example.com/', limit: 5, formats: ['markdown'], options: { includeSubdomains: false, includeExternalLinks: false, includePatterns: ['https://example.com/docs/**'] } });
    const status = await actions.crawl.status(id, { limit: 5 });
    expect(fake.seen[1]!.query.get('limit')).toBe('5');
    expect(status).toMatchObject({ id, status: 'completed', total: 4, finished: 4 });
    expect(status.records[0]).toEqual({ url: 'https://example.com/one', status: 'completed', markdown: '# One', title: 'One', httpStatus: 200 });
    await actions.crawl.cancel(id);
    expect(fake.crawls.get(id)!.cancelled).toBe(true);
    await expect(actions.crawl.status('../x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const badId = actionsWith(fakeBrowserRun({ reply: seen => seen.path === '/crawl' ? Response.json({ success: true, result: '../jobs' }) : undefined }));
    await expect(badId.crawl.start({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    const odd = actionsWith(fakeBrowserRun({ crawlStatus: 'pondering' }));
    await expect(odd.crawl.status(await odd.crawl.start({ url: 'https://example.com/' }))).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });
});

describe('originPatterns', () => {
  it('lets a page load only from its origins', () => {
    const patterns = originPatterns(['https://example.com', 'http://127.0.0.1:8080', 'https://*.cdn.example.org']).map(pattern => new RegExp(pattern, 'u'));
    const allowed = (url: string) => patterns.some(pattern => pattern.test(url));
    for (const url of ['https://example.com/', 'https://example.com:443/a', 'https://example.com', 'https://example.com?x', 'http://127.0.0.1:8080/x', 'https://a.cdn.example.org/lib.js']) expect(allowed(url), url).toBe(true);
    for (const url of ['https://example.com.evil.net/', 'http://example.com/', 'https://example.com:8443/', 'https://cdn.example.org/', 'https://evil.example/https://example.com/', 'http://127.0.0.1:8081/']) expect(allowed(url), url).toBe(false);
  });
});

describe('quickActionTools', () => {
  const tools = (fake: ReturnType<typeof fakeBrowserRun>, extra: Partial<Parameters<typeof quickActionTools>[1]> = {}) => quickActionTools(actionsWith(fake), { origins: ['https://example.com'], ...extra });

  it('reads by default; screenshots, JSON and crawls each need enabling and their own permission; nothing is allowed without origins', () => {
    const fake = fakeBrowserRun();
    expect(tools(fake).map(tool => [tool.id, tool.capabilities])).toEqual([['cloudflare.markdown', ['web:cloudflare:read']], ['cloudflare.links', ['web:cloudflare:read']], ['cloudflare.scrape', ['web:cloudflare:read']]]);
    expect(tools(fake, { name: 'cf', screenshot: true, json: true, crawl: true, costMicros: { crawl: 7 } }).map(tool => [tool.id, tool.capabilities, tool.costMicros])).toEqual([
      ['cf.markdown', ['web:cf:read'], 0], ['cf.links', ['web:cf:read'], 0], ['cf.scrape', ['web:cf:read'], 0], ['cf.screenshot', ['web:cf:read'], 0], ['cf.json', ['web:cf:extract'], 0], ['cf.crawl', ['web:cf:crawl'], 7]]);
    expect(() => quickActionTools(actionsWith(fake), {} as never)).toThrow(/origins/u);
    expect(() => tools(fake, { name: 'Bad Name' })).toThrow(/name/u);
    expect(() => tools(fake, { maxCrawlPages: 1_000 })).toThrow(/maxCrawlPages/u);
    expect(() => quickActionTools({} as never, { origins: 'all' })).toThrow(/quick actions/u);
  });

  it('reads allowed pages, loading nothing from other sites, bounded, and refuses other sites in words the model can act on', async () => {
    const fake = fakeBrowserRun();
    const set = tools(fake, { maxPageBytes: 1_024 });
    expect(await run(set, 'cloudflare.markdown', { url: 'https://example.com/page' })).toMatchObject({ status: 'succeeded', output: { url: 'https://example.com/page' } });
    expect(fake.seen[0]!.body).toEqual({ url: 'https://example.com/page', allowRequestPattern: originPatterns(['https://example.com']) });
    expect((await run(tools(fake, { origins: 'all' }), 'cloudflare.markdown', { url: 'https://anything.example/' })).status).toBe('succeeded');
    expect(fake.seen.at(-1)!.body).toEqual({ url: 'https://anything.example/' });
    const long = tools(fakeBrowserRun({ reply: seen => seen.path === '/markdown' ? Response.json({ success: true, result: 'x'.repeat(5_000) }) : undefined }), { maxPageBytes: 1_024 });
    expect((await run(long, 'cloudflare.markdown', { url: 'https://example.com/' })).output).toMatchObject({ truncated: true });
    expect((await run(set, 'cloudflare.links', { url: 'https://example.com/' })).output).toEqual({ url: 'https://example.com/', links: ['https://example.com/a', 'https://other.example/b'] });
    expect((await run(set, 'cloudflare.scrape', { url: 'https://example.com/', selectors: ['h1'] })).output).toEqual({ url: 'https://example.com/', elements: [{ selector: 'h1', results: [{ text: 'Example', attributes: [{ name: 'class', value: 'title' }] }] }] });
    expect((await run(set, 'cloudflare.markdown', { url: 'https://elsewhere.example/' })).output).toMatchObject({ error: 'PERMISSION_DENIED' });
    expect((await run(set, 'cloudflare.markdown', { url: 'javascript:alert(1)' })).output).toMatchObject({ error: 'INVALID_INPUT' });
  });

  it('bounds the text a scrape returns in all', async () => {
    const many = fakeBrowserRun({ reply: seen => seen.path === '/scrape' ? Response.json({ success: true, result: [{ selector: 'p', results: Array.from({ length: 50 }, () => ({ text: 'y'.repeat(100), html: '', attributes: [] })) }] }) : undefined });
    const output = (await run(tools(many, { maxPageBytes: 1_024 }), 'cloudflare.scrape', { url: 'https://example.com/', selectors: ['p'] })).output!;
    expect(new TextEncoder().encode(JSON.stringify((output['elements'] as { results: { text: string }[] }[])[0]!.results.map(item => item.text).join(''))).byteLength).toBeLessThanOrEqual(1_100);
    expect(output['truncated']).toBe(true);
  });

  it('screenshots as an image and extracts JSON, bounded', async () => {
    const fake = fakeBrowserRun();
    const set = tools(fake, { screenshot: true, json: true, maxPageBytes: 1_024 });
    const shot = await testTool(find(set, 'cloudflare.screenshot'), { url: 'https://example.com/' });
    expect(shot.outcome).toMatchObject({ status: 'succeeded' });
    expect(JSON.stringify(shot.outcome)).toContain('image/png');
    expect((await run(set, 'cloudflare.json', { url: 'https://example.com/', prompt: 'the price' })).output).toEqual({ url: 'https://example.com/', data: { price: 42 } });
    const big = tools(fakeBrowserRun({ reply: seen => seen.path === '/json' ? Response.json({ success: true, result: { text: 'x'.repeat(5_000) } }) : undefined }), { json: true, maxPageBytes: 1_024 });
    expect((await run(big, 'cloudflare.json', { url: 'https://example.com/', prompt: 'all' })).output).toMatchObject({ error: 'LIMIT_EXCEEDED' });
  });

  it('crawls a site within its pages and origins, polling until done, and cancels one not finished', async () => {
    const fake = fakeBrowserRun({ crawlPolls: 2 });
    const set = tools(fake, { crawl: true, maxCrawlPages: 5 });
    expect((await run(set, 'cloudflare.crawl', { url: 'https://example.com/', limit: 4 })).output).toEqual({ url: 'https://example.com/', pages: [
      { url: 'https://example.com/one', title: 'One', markdown: '# One' }, { url: 'https://example.com/two', title: 'Two', markdown: '# Two' }] });
    expect(fake.seen[0]!.body).toMatchObject({ url: 'https://example.com/', limit: 4, allowRequestPattern: originPatterns(['https://example.com']) });
    expect([...fake.crawls.values()][0]!.cancelled).toBe(false);
    expect((await run(set, 'cloudflare.crawl', { url: 'https://example.com/', limit: 6 })).status).not.toBe('succeeded');
    const slow = fakeBrowserRun({ crawlPolls: 1_000 });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 300);
    expect((await run(tools(slow, { crawl: true }), 'cloudflare.crawl', { url: 'https://example.com/' }, controller.signal)).status).not.toBe('succeeded');
    expect([...slow.crawls.values()][0]!.cancelled).toBe(true);
    const errored = fakeBrowserRun({ crawlStatus: 'errored' });
    expect((await run(tools(errored, { crawl: true }), 'cloudflare.crawl', { url: 'https://example.com/' })).status).toBe('failed');
  }, 20_000);

  it('fails Cloudflare\'s refusals without what it wrote, and runs only with its permission', async () => {
    const failing = tools(fakeBrowserRun({ reply: () => Response.json({ success: false, errors: [{ message: 'secret detail' }] }, { status: 500 }) }));
    const outcome = await run(failing, 'cloudflare.markdown', { url: 'https://example.com/' });
    expect(outcome.status).toBe('failed'); expect(JSON.stringify(outcome)).not.toContain('secret');
    const markdown = find(tools(fakeBrowserRun()), 'cloudflare.markdown');
    const { outcome: blocked } = await testTool(markdown, { url: 'https://example.com/' }, { permissions: toolGrants(markdown).filter(grant => !grant.startsWith('web:')) });
    expect(blocked).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
  });
});
