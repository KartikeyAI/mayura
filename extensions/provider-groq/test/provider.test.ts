import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, media, z, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { catalog, groq } from '../src/index.js';

// Groq's Chat Completions API on the wire, answering each conformance scenario through the provider's fetch option.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const usage = (input: number, output: number) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
const completion = (message: Record<string, unknown>, finish_reason: string, tokens: JsonObject) => ({ id: 'chatcmpl-1', object: 'chat.completion', model: 'groq-test', created: 1,
  usage: tokens, choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason }] });
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, tokens?: JsonObject) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'groq-test', created: 1,
  choices: [{ index: 0, delta, finish_reason }], ...(tokens ? { x_groq: { id: 'req_1', usage: tokens } } : {}) });
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of [...events.map(event => JSON.stringify(event)), '[DONE]']) controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

type Seen = { url: string; body: JsonObject; headers: Headers }[];
function transport(scenario: ModelScenario | { kind: 'raw'; body: unknown; status?: number } | { kind: 'events'; events: unknown[] }, seen: Seen = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    seen.push({ url: String(input instanceof Request ? input.url : input), body, headers: new Headers(init?.headers) });
    switch (scenario.kind) {
      case 'raw': return json(scenario.body, scenario.status ?? 200);
      case 'events': return sse(scenario.events);
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ error: { message: scenario.detail, type: 'invalid_request_error' } }, scenario.status);
      case 'invalid': return json(completion({ content: `not json: ${scenario.detail}` }, 'stop', usage(1, 1)));
      case 'refusal': return json(completion({ refusal: 'I cannot help with that.' }, 'stop', usage(5, 1)));
      case 'final': return json(completion({ content: JSON.stringify(scenario.output) }, 'stop', usage(scenario.inputTokens, scenario.outputTokens)));
      case 'tool_calls': {
        const offered = (body['tools'] as { function: { name: string; description: string } }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.function.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.function.name;
        return json(completion({ content: 'Let me look that up.', tool_calls: scenario.calls.map((call, index) => ({ id: `call_${index}`, type: 'function', function: { name: nameOf(call.toolId), arguments: JSON.stringify(call.input) } })) },
          'tool_calls', usage(scenario.inputTokens, scenario.outputTokens)));
      }
      case 'stream_final': return sse([
        chunk({ role: 'assistant', content: '' }),
        ...scenario.chunks.map(content => chunk({ content })),
        chunk({}, 'stop', usage(scenario.inputTokens, scenario.outputTokens)),
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => groq({ apiKey: 'fixture-not-a-real-key', fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-groq keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-groq', () => {
  const settings = { id: 'groq/groq-test', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 5_000_000 }, maxCostMicros: 50_000 };
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });
  const final = { kind: 'final' as const, output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 };
  const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];

  it('sends a strict chat request to Groq with the key, and nothing from the environment', async () => {
    vi.stubEnv('GROQ_API_KEY', 'key-from-env'); vi.stubEnv('GROQ_BASE_URL', 'https://attacker.example'); vi.stubEnv('GROQ_LOG', 'debug');
    vi.stubEnv('GROQ_CUSTOM_HEADERS', 'X-Exfiltrate: yes\nAuthorization: Bearer key-from-env');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined); const debugged = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const seen: Seen = [];
      await groq({ apiKey: 'fixture-key', fetch: transport(final, seen) }).model('groq-test', settings).generate(request());
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
      expect(seen[0]!.headers.get('x-exfiltrate')).toBeNull();
      expect(seen[0]!.body).toMatchObject({ model: 'groq-test', max_completion_tokens: 64, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: '"hi"' }],
        response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: { type: 'object', required: ['answer'] } } } });
      expect(logged).not.toHaveBeenCalled(); expect(debugged).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); debugged.mockRestore(); }
  });

  it('sends requests to the baseURL it is given, with extra headers that cannot replace the key', async () => {
    const seen: Seen = [];
    await groq({ apiKey: 'fixture-key', baseURL: 'https://gateway.example/groq', headers: { 'x-gateway-key': 'g' }, fetch: transport(final, seen) }).model('groq-test', settings).generate(request());
    expect(seen[0]!.url).toBe('https://gateway.example/groq/openai/v1/chat/completions');
    expect(seen[0]!.headers.get('x-gateway-key')).toBe('g');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
  });

  it('makes one attempt per call, and reports an over-capacity Groq (429, 498, 503) without its text', async () => {
    for (const [status, reason] of [[429, 'rate_limited'], [498, 'unavailable'], [503, 'unavailable']] as const) {
      const seen: Seen = [];
      const error = await groq({ apiKey: 'fixture-key', fetch: transport({ kind: 'http', status, detail: 'PRIVATE upstream detail' }, seen) }).model('groq-test', settings).generate(request())
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ reason });
      expect(String((error as Error).message)).not.toContain('PRIVATE');
      expect(seen).toHaveLength(1);
    }
  });

  it('keeps the model\'s reasoning for the next call of the run, and never releases it', async () => {
    const first = await groq({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: completion({ reasoning: 'The customer wants order ord-1.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'orders_lookup', arguments: '{"orderId":"ord-1"}' } }] }, 'tool_calls', usage(10, 5)) }) })
      .model('groq-test', settings).generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] });
    expect(JSON.stringify(first.type === 'tool_calls' ? first.calls : [])).not.toContain('The customer wants');
    const seen: Seen = [];
    await groq({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'Shipped.' }, inputTokens: 20, outputTokens: 5 }, seen) }).model('groq-test', settings).generate(request({
      tools, continuation: first.continuation!,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'call_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] },
        { role: 'tool', callId: 'call_1', toolId: 'orders.lookup', result: { status: 'shipped' } }],
    }));
    const messages = seen[0]!.body['messages'] as JsonObject[];
    expect(messages[2]).toEqual({ role: 'assistant', reasoning: 'The customer wants order ord-1.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'orders_lookup', arguments: '{"orderId":"ord-1"}' } }] });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' });
    // A continuation from another model is refused, never sent.
    await expect(groq({ apiKey: 'fixture-key', fetch: transport(final) }).model('groq-other', settings).generate(request({ continuation: first.continuation! })))
      .rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('streams tool calls and reasoning without releasing the reasoning, and fails on an error inside the stream', async () => {
    const adapter = groq({ apiKey: 'fixture-key', fetch: transport({ kind: 'events', events: [
      chunk({ role: 'assistant', reasoning: 'Looking it up.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'orders_lookup', arguments: '{"orderId":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ord-1"}' } }] }),
      chunk({}, 'tool_calls', usage(30, 8)),
    ] }) }).model('groq-test', settings);
    const events = [];
    for await (const event of adapter.stream!(request({ tools }))) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: 'response', response: expect.objectContaining({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] }) })]);
    // One event, no deltas: the reasoning goes only into the continuation, for the next call.
    expect(JSON.stringify(events.map(event => event.type === 'response' && event.response.type === 'tool_calls' ? event.response.calls : event))).not.toContain('Looking it up');
    const broken = groq({ apiKey: 'fixture-key', fetch: transport({ kind: 'events', events: [chunk({ content: '{"answer":' }), { error: { message: 'PRIVATE upstream failure' } }] }) }).model('groq-test', settings);
    const failures: unknown[] = [];
    try { for await (const _event of broken.stream!(request())) { /* drained */ } } catch (error) { failures.push(error); }
    expect(failures).toEqual([expect.objectContaining({ reason: 'unavailable' })]);
  });

  it('sends images only when told the model sees them, following tool results in one user message', async () => {
    const png = media(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', { name: 'receipt' });
    expect(groq({ apiKey: 'fixture-key' }).model('groq-test', settings).capabilities.media).toBeUndefined();
    const seen: Seen = [];
    const vision = groq({ apiKey: 'fixture-key', media: { types: ['image/png'], urls: false }, fetch: transport(final, seen) }).model('groq-test', settings);
    expect(vision.capabilities.media).toEqual({ types: ['image/png'], urls: false });
    await vision.generate(request({ tools, messages: [
      { role: 'user', content: 'What is this?', media: [png] },
      { role: 'assistant', calls: [{ id: 'call_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] },
      { role: 'tool', callId: 'call_1', toolId: 'orders.lookup', result: { status: 'shipped' }, media: [png] },
    ] }));
    const messages = seen[0]!.body['messages'] as JsonObject[];
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
    expect(messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: '"What is this?"' }, { type: 'text', text: 'Image: receipt' }, image] });
    expect(messages.slice(3)).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
      { role: 'user', content: [{ type: 'text', text: 'Images from the tool results above:' }, { type: 'text', text: 'Image: receipt' }, image] }]);
  });

  it('refuses a response larger than maxResponseBytes, and configuration it cannot use', async () => {
    const big = { kind: 'raw' as const, body: completion({ content: JSON.stringify({ answer: 'x'.repeat(5_000) }) }, 'stop', usage(1, 1)) };
    await expect(groq({ apiKey: 'fixture-key', maxResponseBytes: 1_000, fetch: transport(big) }).model('groq-test', settings).generate(request())).rejects.toMatchObject({ reason: 'invalid_response' });
    for (const options of [{}, { apiKey: '' }, { apiKey: 'k\nX' }, { apiKey: 'k', baseURL: 'http://insecure.example' }, { apiKey: 'k', headers: { authorization: 'x' } },
      { apiKey: 'k', media: { types: ['application/pdf'], urls: false } }, { apiKey: 'k', media: { types: [], urls: false } }]) {
      expect(() => groq(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('runs an agent through a model registry with catalog prices, granted by its model id', async () => {
    const models = createModels({ providers: [groq({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 10, outputTokens: 2 }) })],
      prices: 'catalog', maxCallCostMicros: 50_000 });
    expect(models.list().map(model => model.id)).toEqual(Object.keys(catalog.models).map(name => `groq/${name}`));
    expect(() => models.model('groq/llama-3.3-70b-versatile')).toThrow(/No price/);
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model('groq/openai/gpt-oss-120b') });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:groq/openai/gpt-oss-120b'] }, limits: { maxCostMicros: 100_000 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
    expect(catalog.models['openai/gpt-oss-120b']!.pricing).toEqual({ inputMicrosPerMillionTokens: 150_000, outputMicrosPerMillionTokens: 600_000 });
  });
});
