import { afterEach, describe, expect, it } from 'vitest';
import { media, mediaFromBase64, mediaUrl, sniffMediaType, withMedia, type JsonValue, type Media, type ModelAdapter, type ModelRequest, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { scriptedModel, testImage, testPdf } from '../../testing/src/index.js';
import { createModelRouter, createRuntime, defineAgent, defineHook, type AgentOptions, type Runtime } from '../src/index.js';

// Agents that see: images and PDFs with the input and from tools, checked, copied, counted, and never shown to hooks.

const json: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'media-test', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'media-principal', projectId: 'media-project' };
const final = (output: JsonValue = 'seen'): ModelResponse => ({ type: 'final', output, usage: { costMicros: 0 } });
const png = (testImage() as Media & { data: Uint8Array }).data;
const runtimes: Runtime[] = [];
const runtime = (limits = {}, extra: readonly string[] = []): Runtime => {
  const engine = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:scripted', 'model:blind', 'tool:screen.capture', ...extra] }, limits: { maxDurationMs: 2_000, ...limits } });
  runtimes.push(engine); return engine;
};
const agent = (model: ModelAdapter, extra: Partial<AgentOptions<typeof json, typeof json>> = {}) =>
  defineAgent({ id: 'eyes', version: '1', instructions: 'Look.', input: json, output: json, tools: [], model, media: { accept: ['image/png', 'application/pdf'] }, ...extra });
const events = async (source: AsyncIterable<RunEvent>): Promise<RunEvent[]> => { const seen: RunEvent[] = []; for await (const event of source) seen.push(event); return seen; };
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); });

describe('media values', () => {
  it('are checked against their own bytes, copied, and limited to HTTPS URLs', () => {
    expect(sniffMediaType(png)).toBe('image/png');
    expect(() => media(png, 'image/jpeg')).toThrow('These bytes are image/png, not image/jpeg.');
    expect(() => media(new TextEncoder().encode('hello'), 'image/png')).toThrow('These bytes are not a image/png file.');
    const source = png.slice(); const item = media(source, 'image/png', { name: 'shot.png' }) as Media & { data: Uint8Array };
    source[20] = 0xff; expect(item.data[20]).not.toBe(0xff); // a private copy
    expect(() => mediaUrl('http://cdn.example.com/a.png', 'image/png')).toThrow('https://');
    expect(() => mediaUrl('https://user:pw@cdn.example.com/a.png', 'image/png')).toThrow('without credentials');
    expect(() => mediaFromBase64('not base64!', 'image/png')).toThrow('base64');
    expect(() => media(png, 'image/png', { name: '../etc/passwd' })).toThrow('without slashes');
    expect(testPdf().mediaType).toBe('application/pdf');
  });
});

describe('agents that accept media', () => {
  it('send the input media to the model, and show hooks and events only its type and size', async () => {
    const seen: ModelRequest[] = []; const hookViews: unknown[] = [];
    const model = scriptedModel([request => { seen.push(request); return final(); }]);
    const inspect = defineHook({ id: 'inspect', version: '1', stage: 'beforeExecution', tools: [], handler: event => { hookViews.push(event); return { decision: 'continue' }; } });
    const modelHook = defineHook({ id: 'model-view', version: '1', stage: 'beforeModelCall', tools: [], handler: event => { hookViews.push(event.request); return { decision: 'continue' }; } });
    const engine = runtime({ maxHookCalls: 4 });
    const bytes = png.slice();
    const run = engine.submit(agent(model, { hooks: [inspect, modelHook] }), { input: { question: 'What is this?' }, media: [media(bytes, 'image/png', { name: 'shot.png' }), testPdf()] });
    bytes.fill(0); // changing the caller's array after submitting changes nothing
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 'seen' });
    const first = seen[0]!.messages[0]!;
    expect(first).toMatchObject({ role: 'user', content: { question: 'What is this?' } });
    const sent = (first as { media: readonly (Media & { data: Uint8Array })[] }).media;
    expect(sent.map(item => item.mediaType)).toEqual(['image/png', 'application/pdf']);
    expect([...sent[0]!.data]).toEqual([...png]); expect(sent[0]!.name).toBe('shot.png');
    expect(hookViews[0]).toEqual({ stage: 'beforeExecution', input: { question: 'What is this?' },
      media: [{ mediaType: 'image/png', source: 'bytes', bytes: png.byteLength, name: 'shot.png' }, { mediaType: 'application/pdf', source: 'bytes', bytes: (testPdf() as Media & { data: Uint8Array }).data.byteLength }] });
    const projection = hookViews[1] as { messages: readonly Record<string, unknown>[]; media: unknown };
    expect(projection.messages[0]).toEqual({ role: 'user', content: { question: 'What is this?' } });
    expect(projection.media).toEqual([{ message: 0, media: [expect.objectContaining({ mediaType: 'image/png', source: 'bytes' }), expect.objectContaining({ mediaType: 'application/pdf' })] }]);
    expect(JSON.stringify(hookViews)).not.toMatch(/"data"/u);
    expect((await events(run.observe())).find(event => event.type === 'run.started')!.metadata).toMatchObject({ media: 2 });
  });

  it('refuse media the agent did not declare, of the wrong kind, too many or too large, with a message that says why', () => {
    const engine = runtime({ maxMediaBytes: png.byteLength * 2 });
    const plain = defineAgent({ id: 'plain', version: '1', instructions: 'x', input: json, output: json, tools: [], model: scriptedModel([]) });
    expect(() => engine.submit(plain, { input: 1, media: [testImage()] })).toThrow("Agent plain: media is not accepted here; declare which types are accepted with `media: { accept: [...] }`.");
    const eyes = agent(scriptedModel([]), { media: { accept: ['image/png'], maxItems: 2 } });
    expect(() => engine.submit(eyes, { input: 1, media: [testPdf()] })).toThrow('media 1 is application/pdf, which is not accepted (accepted: image/png).');
    expect(() => engine.submit(eyes, { input: 1, media: [testImage(), testImage(), testImage()] })).toThrow('at most 2 media items are accepted, not 3.');
    expect(() => engine.submit(agent(scriptedModel([]), { media: { accept: ['image/png'], maxBytes: 10 } }), { input: 1, media: [testImage()] }))
      .toThrow(`media 1 is ${png.byteLength} bytes; the limit is 10.`);
    const tight = runtime({ maxMediaBytes: png.byteLength });
    expect(() => tight.submit(eyes, { input: 1, media: [testImage(), testImage()] })).toThrow('limits.maxMediaBytes');
    // A forged item labelled PNG whose bytes are not a PNG is refused even though it skipped media().
    const forged = { type: 'media', mediaType: 'image/png', data: new TextEncoder().encode('<svg/>') } as unknown as Media;
    expect(() => engine.submit(eyes, { input: 1, media: [forged] })).toThrow('media 1 is labelled image/png but its bytes are not that type.');
    expect(() => engine.submit(eyes, { input: 1, media: [mediaUrl('https://cdn.example.com/a.png', 'image/png')] })).toThrow('no URL prefixes are allowed');
  });

  it('accept URLs only under a declared prefix that ends at a path boundary', async () => {
    const seen: ModelRequest[] = [];
    const eyes = agent(scriptedModel([request => { seen.push(request); return final(); }]), { media: { accept: ['image/png'], urls: ['https://cdn.example.com/images/'] } });
    const engine = runtime();
    expect(() => engine.submit(eyes, { input: 1, media: [mediaUrl('https://cdn.example.com/imagesX/a.png', 'image/png')] })).toThrow('not under an allowed URL prefix');
    expect(() => engine.submit(eyes, { input: 1, media: [mediaUrl('https://cdn.example.com.evil/images/a.png', 'image/png')] })).toThrow('not under an allowed URL prefix');
    expect(await engine.submit(eyes, { input: 1, media: [mediaUrl('https://cdn.example.com/images/a.png', 'image/png')] }).result()).toMatchObject({ status: 'succeeded' });
    expect((seen[0]!.messages[0] as { media: readonly Media[] }).media[0]).toEqual({ type: 'media', mediaType: 'image/png', url: 'https://cdn.example.com/images/a.png' });
    expect(() => agent(scriptedModel([]), { media: { accept: ['image/png'], urls: ['https://cdn.example.com'] } })).toThrow('must be a plain https:// URL ending in /.');
  });
});

describe('models that cannot see', () => {
  it('are refused when the agent is defined, naming what they cannot see', () => {
    const blind = scriptedModel([], { id: 'blind', media: false });
    expect(() => agent(blind)).toThrow('Agent eyes: its model (blind) cannot see image/png, application/pdf, which the agent accepts or its tools return. Its adapter declares no media capability');
    const imagesOnly = scriptedModel([], { id: 'images', media: { types: ['image/png'], urls: false } });
    expect(() => agent(imagesOnly)).toThrow('cannot see application/pdf');
    expect(() => agent(imagesOnly, { media: { accept: ['image/png'], urls: ['https://cdn.example.com/'] } })).toThrow('cannot take media URLs');
    // A router sees only what every route sees.
    const router = createModelRouter({ id: 'router', routes: [scriptedModel([], { id: 'a' }), imagesOnly] });
    expect(router.capabilities.media).toEqual({ types: ['image/png'], urls: false });
    expect(() => agent(router)).toThrow('cannot see application/pdf');
    expect(() => defineAgent({ id: 'text', version: '1', instructions: 'x', input: json, output: json, tools: [], model: blind })).not.toThrow();
  });
});

describe('tools that return media', () => {
  const capture = (returned: () => readonly Media[], policy = true) => defineTool({ id: 'screen.capture', version: '1', description: 'Takes a screenshot.',
    input: json, output: json, effects: 'none', capabilities: [], ...(policy ? { media: { accept: ['image/png' as const] } } : {}),
    execute: () => withMedia({ captured: true }, returned()) });
  const screenshotRun = (tool: ReturnType<typeof capture>, seen: ModelRequest[], limits = {}) => {
    const model = scriptedModel([{ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'screen.capture', input: null }], usage: { costMicros: 0 } },
      request => { seen.push(request); return final(); }]);
    return runtime(limits).submit(defineAgent({ id: 'tester', version: '1', instructions: 'x', input: json, output: json, tools: [tool], model }), { input: 1 });
  };

  it('put a screenshot beside the tool result for the model to see', async () => {
    const seen: ModelRequest[] = [];
    const run = screenshotRun(capture(() => [testImage({ name: 'screen.png' })]), seen);
    expect(await run.result()).toEqual({ status: 'succeeded', output: 'seen' });
    const toolMessage = seen[0]!.messages.find(message => message.role === 'tool') as { result: JsonValue; media: readonly Media[] };
    expect(toolMessage.result).toEqual({ captured: true });
    expect(toolMessage.media.map(item => [item.mediaType, item.name])).toEqual([['image/png', 'screen.png']]);
    expect((await events(run.observe())).find(event => event.type === 'tool.completed')!.metadata).toMatchObject({ status: 'succeeded', media: 1 });
  });

  it('fail when the tool declared no media, returned the wrong kind, or went over the run\'s media limit', async () => {
    expect(await screenshotRun(capture(() => [testImage()], false), []).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(await screenshotRun(capture(() => [testPdf()]), []).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(await screenshotRun(capture(() => [testImage()]), [], { maxMediaBytes: 10 }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
  });
});
