import { describe, expect, it, vi } from 'vitest';
import type { AnyTool } from 'mayura';
import type { Browser } from 'mayura/browser';
import { testTool, toolGrants } from 'mayura/testing';
import { stagehandTools, type StagehandLike } from '../src/index.js';

/** A Mayura browser as the tools see it. */
function stubBrowser(extra: Partial<{ headers: Record<string, string>; isolated: boolean; ended: boolean; url: string }> = {}) {
  return { id: 'b1', provider: 'local', ended: extra.ended ?? false, goto: async () => undefined,
    cdp: { url: 'ws://127.0.0.1:9222/devtools/browser/1', headers: extra.headers ?? {}, isolated: extra.isolated ?? false },
    tabs: async () => [{ tab: 'T1', url: extra.url ?? 'https://example.com/', title: 'Example', active: true }] } as unknown as Browser;
}
/** Stagehand as a recording stand-in. */
function fakeStagehand(results: Partial<{ act: unknown; extract: unknown; observe: unknown; init: () => Promise<void> }> = {}) {
  const made: Record<string, unknown>[] = []; const calls: { method: string; instruction: string; options: Record<string, unknown> | undefined }[] = [];
  const page = { url: () => 'https://example.com/' };
  class Fake implements StagehandLike {
    readonly context = { pages: () => [{ url: () => 'about:blank' }, page] };
    constructor(options: Record<string, unknown>) { made.push(options); }
    async init() { await results.init?.(); }
    async close() { return undefined; }
    async act(instruction: string, options?: Record<string, unknown>) { calls.push({ method: 'act', instruction, options }); return (results.act ?? { success: true, message: 'Clicked', actionDescription: 'click on Sign in' }) as never; }
    async extract(instruction: string, _schema?: undefined, options?: Record<string, unknown>) { calls.push({ method: 'extract', instruction, options }); return (results.extract ?? { extraction: 'The price is 42.' }) as never; }
    async observe(instruction: string, options?: Record<string, unknown>) { calls.push({ method: 'observe', instruction, options }); return (results.observe ?? [{ description: 'Search box', selector: 'xpath=/html/body/input', method: 'fill' }, 7]) as never; }
  }
  return { Fake, made, calls, page };
}
const find = (tools: AnyTool[], id: string) => tools.find(tool => tool.id === id)!;
const run = async (tools: AnyTool[], id: string, input: unknown) => (await testTool(find(tools, id), input)).outcome as { status: string; output?: Record<string, unknown> };

describe('stagehandTools', () => {
  it('reads by default; acting needs enabling and its own permission', () => {
    const { Fake } = fakeStagehand();
    expect(stagehandTools(stubBrowser(), { model: 'openai/gpt-5-mini', stagehand: Fake }).map(tool => [tool.id, tool.capabilities, tool.effects])).toEqual([
      ['stagehand.extract', ['stagehand:stagehand:read'], 'read'], ['stagehand.observe', ['stagehand:stagehand:read'], 'read']]);
    expect(stagehandTools(stubBrowser(), { name: 'web', model: 'openai/gpt-5-mini', act: true, costMicros: { act: 3 }, stagehand: Fake }).map(tool => [tool.id, tool.capabilities, tool.costMicros, tool.effects])).toEqual([
      ['web.extract', ['stagehand:web:read'], 0, 'read'], ['web.observe', ['stagehand:web:read'], 0, 'read'], ['web.act', ['stagehand:web:act'], 3, 'write']]);
  });

  it('refuses configuration it cannot use', () => {
    const { Fake } = fakeStagehand();
    expect(() => stagehandTools({} as Browser, { model: 'openai/x', stagehand: Fake })).toThrow(/browser/u);
    expect(() => stagehandTools(stubBrowser(), { model: 'gpt' as never, stagehand: Fake })).toThrow(/model/u);
    expect(() => stagehandTools(stubBrowser(), { model: { modelName: '' }, stagehand: Fake })).toThrow(/model/u);
    expect(() => stagehandTools(stubBrowser(), { model: 'openai/x', name: 'Bad Name', stagehand: Fake })).toThrow(/name/u);
    expect(() => stagehandTools(stubBrowser(), { model: 'openai/x', timeoutMs: 10, stagehand: Fake })).toThrow(/timeoutMs/u);
    expect(() => stagehandTools(stubBrowser(), { model: 'openai/x', costMicros: { act: -1 }, stagehand: Fake })).toThrow(/costMicros/u);
    expect(() => stagehandTools(stubBrowser(), { model: 'openai/x', stagehand: 'Stagehand' as never })).toThrow(/stagehand/u);
  });

  it('attaches one Stagehand per browser to its CDP endpoint, keeping it alive, with the model given, on the active tab', async () => {
    const { Fake, made, calls, page } = fakeStagehand();
    const browser = stubBrowser();
    const tools = stagehandTools(browser, { model: { modelName: 'openai/deepseek-chat', apiKey: 'sk-test', baseURL: 'https://llm.example/v1' }, act: true, timeoutMs: 30_000, stagehand: Fake });
    expect(await run(tools, 'stagehand.extract', { instruction: 'the price' })).toMatchObject({ status: 'succeeded', output: { extraction: 'The price is 42.' } });
    expect(await run(tools, 'stagehand.observe', { instruction: 'the search box' })).toMatchObject({ output: { actions: [{ description: 'Search box', method: 'fill' }, { description: '' }] } });
    expect(await run(tools, 'stagehand.act', { instruction: 'click sign in' })).toMatchObject({ output: { success: true, message: 'Clicked', action: 'click on Sign in' } });
    expect(made).toEqual([{ env: 'LOCAL', localBrowserLaunchOptions: { cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/1' },
      model: { modelName: 'openai/deepseek-chat', apiKey: 'sk-test', baseURL: 'https://llm.example/v1' }, keepAlive: true, verbose: 0, disablePino: true, logger: expect.any(Function) }]);
    expect(calls.map(call => [call.method, call.instruction, call.options?.['page'], call.options?.['timeout']])).toEqual([
      ['extract', 'the price', page, 30_000], ['observe', 'the search box', page, 30_000], ['act', 'click sign in', page, 30_000]]);
  });

  it('bounds what comes back, and says when an action failed', async () => {
    const { Fake } = fakeStagehand({ extract: { extraction: 'z'.repeat(5_000) }, act: { success: false, message: 'No such element' }, observe: Array.from({ length: 80 }, () => ({ description: 'x' })) });
    const tools = stagehandTools(stubBrowser(), { model: 'openai/x', act: true, maxResultBytes: 1_024, stagehand: Fake });
    expect((await run(tools, 'stagehand.extract', { instruction: 'all' })).output).toMatchObject({ truncated: true });
    expect(String((await run(tools, 'stagehand.extract', { instruction: 'all' })).output!['extraction']).length).toBe(1_024);
    expect(((await run(tools, 'stagehand.observe', { instruction: 'all' })).output!['actions'] as unknown[]).length).toBe(50);
    expect((await run(tools, 'stagehand.act', { instruction: 'click' })).output).toEqual({ success: false, message: 'No such element' });
    // An answer that does not say it succeeded did not.
    const { Fake: Unsure } = fakeStagehand({ act: { message: 'Done?' } });
    expect((await run(stagehandTools(stubBrowser(), { model: 'openai/x', act: true, stagehand: Unsure }), 'stagehand.act', { instruction: 'click' })).output).toEqual({ success: false, message: 'Done?' });
  });

  it('refuses browsers Stagehand cannot be kept to, and ended ones', async () => {
    for (const browser of [stubBrowser({ isolated: true }), stubBrowser({ headers: { 'x-session-token': 't' } }), stubBrowser({ ended: true })]) {
      const { Fake, made } = fakeStagehand();
      expect((await run(stagehandTools(browser, { model: 'openai/x', stagehand: Fake }), 'stagehand.extract', { instruction: 'x' })).status).not.toBe('succeeded');
      expect(made).toEqual([]);
    }
  });

  it('makes Stagehand again after it failed to start, and checks what the model sends', async () => {
    let fail = true;
    const { Fake, made } = fakeStagehand({ init: async () => { if (fail) { fail = false; throw new Error('no browser'); } } });
    const tools = stagehandTools(stubBrowser(), { model: 'openai/x', stagehand: Fake });
    expect((await run(tools, 'stagehand.extract', { instruction: 'x' })).status).toBe('failed');
    expect((await run(tools, 'stagehand.extract', { instruction: 'x' })).status).toBe('succeeded');
    expect(made).toHaveLength(2);
    for (const input of [{}, { instruction: '' }, { instruction: 'x'.repeat(2_001) }, { instruction: 'x', extra: 1 }]) expect((await run(tools, 'stagehand.extract', input)).status).not.toBe('succeeded');
  });

  it('uses a browser per run, and runs only with its permission', async () => {
    const { Fake, made } = fakeStagehand();
    const browsers = new Map<string, Browser>();
    const source = vi.fn(async (context: { runId: string }) => { if (!browsers.has(context.runId)) browsers.set(context.runId, stubBrowser()); return browsers.get(context.runId)!; });
    const extract = find(stagehandTools(source, { model: 'openai/x', stagehand: Fake }), 'stagehand.extract');
    await testTool(extract, { instruction: 'a' }, { runId: 'r1' }); await testTool(extract, { instruction: 'b' }, { runId: 'r1' }); await testTool(extract, { instruction: 'c' }, { runId: 'r2' });
    expect(made).toHaveLength(2);
    const { outcome } = await testTool(extract, { instruction: 'a' }, { permissions: toolGrants(extract).filter(grant => !grant.startsWith('stagehand:')) });
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
  });
});
