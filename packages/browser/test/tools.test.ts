import { describe, expect, it } from 'vitest';
import type { AnyTool } from '@mayura/tools';
import { testTool, toolGrants } from '../../testing/src/index.js';
import { browserPerRun, browserTools, createBrowsers, type Browser } from '../src/index.js';
import { localBrowsers } from '../src/local/index.js';
import { fakeBrowser } from './fake-browser.js';

type Runnable = AnyTool & { id: string; capabilities: readonly string[]; costMicros?: number;
  input: { '~standard': { validate(value: unknown): { issues?: unknown; value?: unknown } } } };
const context = { runId: 'run-1', scope: { tenantId: 't', projectId: 'p' }, signal: new AbortController().signal };

async function open(maxBrowsers = 2) {
  const fake = fakeBrowser({ answer: sent => (sent.method === 'DOM.getContentQuads' ? { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] } : undefined) });
  const browsers = createBrowsers(fake.provider(), { maxBrowsers, maxLifetimeMs: 600_000, origins: ['https://example.com'], webSocket: fake.factory });
  return { fake, browsers, browser: await browsers.open() };
}
const byId = (tools: AnyTool[]) => new Map((tools as Runnable[]).map(tool => [tool.id, tool]));
const run = async (tool: AnyTool, input: unknown) => (await testTool(tool, input)).outcome as { status: string; output?: Record<string, unknown>; error?: { code: string } };

describe('browserTools', () => {
  it('navigates and reads by default; acting, screenshots and JavaScript each need enabling and their own permission', async () => {
    const { browser } = await open();
    expect([...byId(browserTools(browser, { name: 'web' })).keys()]).toEqual(['web.goto', 'web.back', 'web.snapshot', 'web.text']);
    const all = byId(browserTools(browser, { name: 'web', act: true, screenshot: true, evaluate: true, callCostMicros: 5 }));
    expect([...all.keys()]).toEqual(['web.goto', 'web.back', 'web.snapshot', 'web.text', 'web.click', 'web.fill', 'web.press', 'web.select', 'web.hover', 'web.scroll', 'web.tab', 'web.screenshot', 'web.evaluate']);
    expect(all.get('web.snapshot')!.capabilities).toEqual(['browser:web:read']);
    expect(all.get('web.click')!.capabilities).toEqual(['browser:web:act']);
    expect(all.get('web.screenshot')!.capabilities).toEqual(['browser:web:read']);
    expect(all.get('web.evaluate')!.capabilities).toEqual(['browser:web:evaluate']);
    expect([all.get('web.goto')!.costMicros, all.get('web.click')!.costMicros, all.get('web.snapshot')!.costMicros]).toEqual([5, 5, 0]);
    await browser.release();
  });

  it('refuses configuration it cannot use', async () => {
    const { browser } = await open();
    expect(() => browserTools(browser, { name: 'Web Tools' })).toThrow(/name/u);
    expect(() => browserTools(browser, { name: 'web', act: 'yes' as never })).toThrow(/act/u);
    expect(() => browserTools(browser, { name: 'web', callCostMicros: -1 })).toThrow(/callCostMicros/u);
    expect(() => browserTools({} as Browser, { name: 'web' })).toThrow(/browser/u);
    await browser.release();
  });

  it('returns the page after a navigation or action, so the model sees what changed', async () => {
    const { browser } = await open();
    const tools = byId(browserTools(browser, { name: 'web', act: true }));
    expect(await run(tools.get('web.goto')!, { url: 'https://example.com/a' })).toMatchObject({ status: 'succeeded', output: { url: 'https://example.com/a', status: 200, snapshot: '- button "Go" [ref=e1]' } });
    expect(await run(tools.get('web.click')!, { ref: 'e1' })).toMatchObject({ status: 'succeeded', output: { snapshot: '- button "Go" [ref=e1]' } });
    const quiet = byId(browserTools(browser, { name: 'web', snapshotAfter: false }));
    expect((await run(quiet.get('web.goto')!, { url: 'https://example.com/b' })).output).not.toHaveProperty('snapshot');
    expect(await run(tools.get('web.goto')!, { url: 'https://elsewhere.example.org/' })).toMatchObject({ status: 'succeeded', output: { error: 'PERMISSION_DENIED', message: expect.stringContaining('outside the origins') } });
    expect(await run(tools.get('web.click')!, { ref: 'e99' })).toMatchObject({ status: 'succeeded', output: { error: 'INVALID_INPUT', message: expect.stringContaining('snapshot') } });
    await browser.release();
  });

  it('acts only with its permission', async () => {
    const { browser } = await open();
    const click = byId(browserTools(browser, { name: 'web', act: true })).get('web.click')!;
    const { outcome } = await testTool(click, { ref: 'e1' }, { permissions: toolGrants(click).filter(grant => !grant.startsWith('browser:')) });
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    await browser.release();
  });

  it('checks what the model sends', async () => {
    const { browser } = await open();
    const tools = byId(browserTools(browser, { name: 'web', act: true }));
    const valid = (id: string, value: unknown) => (tools.get(id)!.input['~standard'].validate(value) as { issues?: unknown }).issues === undefined;
    expect(valid('web.goto', { url: 'https://example.com/' })).toBe(true);
    expect(valid('web.goto', { url: 'https://example.com/', extra: 1 })).toBe(false);
    expect(valid('web.tab', { action: 'select' })).toBe(false);
    expect(valid('web.tab', { action: 'explode' })).toBe(false);
    expect(valid('web.scroll', { dy: 1e9 })).toBe(false);
    await browser.release();
  });
});

describe('browserPerRun', () => {
  it('opens one browser per run when a tool first needs it, and releases it', async () => {
    const { fake, browsers } = await open(3);
    const perRun = browserPerRun(browsers);
    const source = perRun.source as unknown as (value: typeof context) => Promise<Browser>;
    const [first, again] = await Promise.all([source(context), source(context)]);
    expect(first).toBe(again);
    expect(perRun.runs).toEqual(['run-1']);
    const other = await source({ ...context, runId: 'run-2' });
    expect(other).not.toBe(first);
    await perRun.release('run-1');
    expect(first.ended).toBe(true); expect(perRun.runs).toEqual(['run-2']);
    expect(fake.released).toBe(1); // run-1's
    await perRun.release('run-unknown');
    await perRun.release('run-2');
  });
});

describe('localBrowsers', () => {
  it('refuses switches that would open the browser to others, and configuration it cannot use', () => {
    for (const args of [['--remote-debugging-port=9222'], ['--user-data-dir=/home/me/.config/chrome'], ['--load-extension=x'], ['--proxy-server=evil:80'],
      ['--disable-web-security'], ['--no-sandbox'], ['--host-resolver-rules=MAP * 1.2.3.4'], ['not-a-switch']]) {
      expect(() => localBrowsers({ args }), args[0]).toThrow(/args/u);
    }
    expect(() => localBrowsers({ channel: 'firefox' as never })).toThrow(/channel/u);
    expect(() => localBrowsers({ maxLifetimeMs: 10 })).toThrow(/maxLifetimeMs/u);
    expect(localBrowsers({ args: ['--lang=en-US'] })).toMatchObject({ id: 'local', features: { liveView: false } });
  });

  it('reports a browser that is not there as a configuration mistake', async () => {
    await expect(localBrowsers({ executablePath: 'C:/no/such/chrome.exe' }).create({ lifetimeMs: 60_000, viewport: { width: 800, height: 600 }, labels: {} }, { signal: AbortSignal.timeout(10_000) }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
