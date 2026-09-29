import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, z, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { catalog, google } from '../src/index.js';

// The Gemini API on the wire, answering each conformance scenario through the SDK's fetch option.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const answer = (parts: unknown[], finishReason: string, usage: JsonObject) => ({ candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }], usageMetadata: usage });
const usage = (prompt: number, candidates: number, extra: JsonObject = {}) => ({ promptTokenCount: prompt, candidatesTokenCount: candidates, totalTokenCount: prompt + candidates, ...extra });
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

type Seen = { url: string; body: JsonObject; headers: Headers }[];
function transport(scenario: ModelScenario | { kind: 'raw'; body: unknown; status?: number }, seen: Seen = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    seen.push({ url: String(input instanceof Request ? input.url : input), body, headers: new Headers(init?.headers) });
    switch (scenario.kind) {
      case 'raw': return json(scenario.body, scenario.status ?? 200);
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ error: { code: scenario.status, message: scenario.detail, status: 'INTERNAL' } }, scenario.status);
      case 'invalid': return json(answer([{ text: `not json: ${scenario.detail}` }], 'STOP', usage(1, 1)));
      case 'refusal': return json(answer([], 'SAFETY', usage(5, 0)));
      case 'final': return json(answer([{ text: JSON.stringify(scenario.output) }], 'STOP', usage(scenario.inputTokens, scenario.outputTokens)));
      case 'tool_calls': {
        const declarations = ((body['tools'] as JsonObject[] | undefined)?.[0]?.['functionDeclarations'] as { name: string; description: string }[]) ?? [];
        const nameOf = (toolId: string) => declarations.find(tool => tool.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.name;
        return json(answer(scenario.calls.map(call => ({ functionCall: { name: nameOf(call.toolId), args: call.input } })), 'STOP', usage(scenario.inputTokens, scenario.outputTokens)));
      }
      case 'stream_final': return sse([
        ...scenario.chunks.slice(0, -1).map(text => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })),
        { ...answer([{ text: scenario.chunks.at(-1) }], 'STOP', usage(scenario.inputTokens, scenario.outputTokens)) },
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => google({ apiKey: 'fixture-not-a-real-key', fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-google keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-google', () => {
  const settings = { id: 'google/gemini-test', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 }, maxCostMicros: 50_000 };
  const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });

  it('sends a strict request to the Gemini API with the key, and nothing from the environment', async () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://attacker.example'); vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'project-from-env'); vi.stubEnv('GEMINI_API_KEY', 'key-from-env');
    const seen: Seen = [];
    await google({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 }, seen) }).model('gemini-test', settings).generate(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(seen[0]!.headers.get('x-goog-api-key')).toBe('fixture-key');
    expect(seen[0]!.body).toMatchObject({ systemInstruction: { parts: [{ text: 'Be brief.' }] }, generationConfig: { maxOutputTokens: 64, responseMimeType: 'application/json' } });
  });

  it('makes one attempt per call', async () => {
    const seen: Seen = [];
    await expect(google({ apiKey: 'fixture-key', fetch: transport({ kind: 'http', status: 503, detail: 'busy' }, seen) }).model('gemini-test', settings).generate(request()))
      .rejects.toMatchObject({ reason: 'unavailable' });
    expect(seen).toHaveLength(1);
  });

  it('charges thinking tokens as output, and the long-context rates above their threshold', async () => {
    const thinking = answer([{ text: '{"answer":"ok"}' }], 'STOP', usage(1_000, 100, { thoughtsTokenCount: 400 }));
    expect((await google({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: thinking }) }).model('gemini-test', settings).generate(request())).usage.costMicros)
      .toBe(1_000 + 2_000); // 1,000 input tokens at $1/M, 500 output tokens at $4/M
    const pricing = { ...settings.pricing, longContext: { aboveInputTokens: 200_000, inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 6_000_000 } };
    const long = answer([{ text: '{"answer":"ok"}' }], 'STOP', usage(250_000, 1_000));
    expect((await google({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: long }) }).model('gemini-test', { ...settings, pricing }).generate(request())).usage.costMicros)
      .toBe(500_000 + 6_000);
  });

  it('keeps thoughts and thought signatures for the next call, never releases them, and pairs results with their calls', async () => {
    const parts = [{ text: 'The customer wants ord-1.', thought: true }, { functionCall: { id: 'fc-1', name: 'orders_lookup', args: { orderId: 'ord-1' } }, thoughtSignature: 'c2lnbmF0dXJl' }];
    const first = await google({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: answer(parts, 'STOP', usage(10, 5)) }) }).model('gemini-test', settings).generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'fc-1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] });
    expect(JSON.stringify(first.type === 'tool_calls' ? first.calls : [])).not.toContain('customer wants');
    const seen: Seen = [];
    await google({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'Shipped.' }, inputTokens: 20, outputTokens: 5 }, seen) }).model('gemini-test', settings).generate(request({
      tools, continuation: first.continuation!,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'fc-1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] },
        { role: 'tool', callId: 'fc-1', toolId: 'orders.lookup', result: { status: 'shipped' } }],
    }));
    const contents = seen[0]!.body['contents'] as JsonObject[];
    expect(contents[1]).toEqual({ role: 'model', parts });
    expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'fc-1', name: 'orders_lookup', response: { output: { status: 'shipped' } } } }] });
    await expect(google({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'x' }, inputTokens: 1, outputTokens: 1 }) }).model('gemini-other', settings)
      .generate(request({ continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('reports a blocked prompt as refused, and refuses configuration it cannot use', async () => {
    const blocked = { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: usage(5, 0) };
    await expect(google({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: blocked }) }).model('gemini-test', settings).generate(request())).rejects.toMatchObject({ reason: 'refused' });
    for (const options of [{}, { apiKey: '' }, { apiKey: 'k\nX' }, { apiKey: 'k', baseURL: 'http://insecure.example' }, { apiKey: 'k', headers: { 'x-goog-api-key': 'x' } },
      { apiKey: 'k', media: { types: ['image/png'], urls: true } }, { apiKey: 'k', media: { types: ['image/gif'], urls: false } }]) {
      expect(() => google(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('runs an agent through a model registry with catalog prices, and lists Gemini 3.8 Flash at its 2027 price', async () => {
    const models = createModels({ providers: [google({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 10, outputTokens: 2 }) })],
      prices: 'catalog', maxCallCostMicros: 50_000 });
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model('google/gemini-3.5-flash') });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:google/gemini-3.5-flash'] }, limits: { maxCostMicros: 100_000 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
    expect(catalog.models['gemini-3.8-flash']!.pricing).toMatchObject({ inputMicrosPerMillionTokens: 1_500_000, outputMicrosPerMillionTokens: 7_500_000 });
    expect(models.list().every(model => model.catalogAsOf === catalog.asOf)).toBe(true);
  });
});
