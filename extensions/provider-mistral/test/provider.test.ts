import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTracerProvider } from '@mistralai/mistralai/extra/observability';
import { createModels, createRuntime, defineAgent, media, z, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { catalog, mistral } from '../src/index.js';

// The Mistral Chat Completions API on the wire, answering each conformance scenario through the provider's fetch option.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const usage = (input: number, output: number) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
const completion = (message: Record<string, unknown>, finish_reason: string, tokens: JsonObject) => ({ id: 'cmpl-1', object: 'chat.completion', model: 'mistral-test', created: 1,
  usage: tokens, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }] });
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, tokens?: JsonObject) => ({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'mistral-test', created: 1,
  choices: [{ index: 0, delta, finish_reason }], ...(tokens ? { usage: tokens } : {}) });
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of [...events.map(event => JSON.stringify(event)), '[DONE]']) controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

type Seen = { url: string; body: JsonObject; headers: Headers }[];
function transport(scenario: ModelScenario | { kind: 'raw'; body: unknown; status?: number } | { kind: 'events'; events: unknown[] }, seen: Seen = []): typeof globalThis.fetch {
  return async input => {
    const request = input as Request;
    const body = JSON.parse(await request.text() || '{}') as JsonObject;
    seen.push({ url: request.url, body, headers: request.headers });
    switch (scenario.kind) {
      case 'raw': return json(scenario.body, scenario.status ?? 200);
      case 'events': return sse(scenario.events);
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ object: 'error', message: scenario.detail, type: 'invalid_request_error' }, scenario.status);
      case 'invalid': return json(completion({ content: `not json: ${scenario.detail}` }, 'stop', usage(1, 1)));
      case 'refusal': return json(completion({ content: '{"answer":' }, 'length', usage(5, 1)));
      case 'final': return json(completion({ content: JSON.stringify(scenario.output) }, 'stop', usage(scenario.inputTokens, scenario.outputTokens)));
      case 'tool_calls': {
        const offered = (body['tools'] as { function: { name: string; description: string } }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.function.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.function.name;
        return json(completion({ content: 'Let me look that up.', tool_calls: scenario.calls.map((call, index) => ({ id: `Call0000${index}`, type: 'function', function: { name: nameOf(call.toolId), arguments: JSON.stringify(call.input) } })) },
          'tool_calls', usage(scenario.inputTokens, scenario.outputTokens)));
      }
      case 'stream_final': return sse([
        chunk({ role: 'assistant', content: '' }),
        ...scenario.chunks.map(content => chunk({ content })),
        chunk({ content: '' }, 'stop', usage(scenario.inputTokens, scenario.outputTokens)),
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => mistral({ apiKey: 'fixture-not-a-real-key', fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-mistral keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-mistral', () => {
  const settings = { id: 'mistral/mistral-test', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 5_000_000 }, maxCostMicros: 50_000 };
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });
  const final = { kind: 'final' as const, output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 };
  const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];

  it('sends a strict chat request to Mistral with the key, and nothing from the environment', async () => {
    vi.stubEnv('MISTRAL_API_KEY', 'key-from-env'); vi.stubEnv('MISTRAL_DEBUG', 'true');
    vi.stubEnv('MISTRAL_SDK_TELEMETRY', 'dedicated'); vi.stubEnv('MISTRAL_OTLP_TRACES_ENDPOINT', 'https://attacker.example/v1/traces');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined); const grouped = vi.spyOn(console, 'group').mockImplementation(() => undefined);
    try {
      const seen: Seen = [];
      await mistral({ apiKey: 'fixture-key', fetch: transport(final, seen) }).model('mistral-test', settings).generate(request());
      await mistral({ apiKey: 'fixture-key', fetch: transport({ kind: 'stream_final', chunks: ['{"answer":"ok"}'], output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 }, seen) })
        .model('mistral-test', settings).generate(request()).catch(() => undefined);
      expect(seen[0]!.url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
      expect(seen[0]!.body).toMatchObject({ model: 'mistral-test', max_tokens: 64, stream: false, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: '"hi"' }],
        response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: { type: 'object', required: ['answer'] } } } });
      expect(seen.every(entry => entry.url.startsWith('https://api.mistral.ai/v1/chat/completions'))).toBe(true);
      // MISTRAL_DEBUG would make the SDK log every request, credentials included.
      expect(logged).not.toHaveBeenCalled(); expect(grouped).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); grouped.mockRestore(); }
  });

  it('never hands a call to the SDK telemetry, even to a tracer provider registered with the SDK', async () => {
    const tracers: string[] = [];
    registerTracerProvider({ getTracer: (name: string) => { tracers.push(name); throw new Error('A span was started.'); } } as never);
    try {
      await expect(mistral({ apiKey: 'fixture-key', fetch: transport(final) }).model('mistral-test', settings).generate(request())).resolves.toMatchObject({ type: 'final' });
      expect(tracers).toEqual([]);
    } finally { registerTracerProvider(undefined as never); }
  });

  it('sends requests to the baseURL it is given, with extra headers that cannot replace the key', async () => {
    const seen: Seen = [];
    await mistral({ apiKey: 'fixture-key', baseURL: 'https://gateway.example/mistral', headers: { 'x-gateway-key': 'g' }, fetch: transport(final, seen) }).model('mistral-test', settings).generate(request());
    expect(seen[0]!.url).toBe('https://gateway.example/mistral/v1/chat/completions');
    expect(seen[0]!.headers.get('x-gateway-key')).toBe('g');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
  });

  it('makes one attempt per call, and reports a busy Mistral (429, 503) without its text', async () => {
    for (const [status, reason] of [[429, 'rate_limited'], [503, 'unavailable']] as const) {
      const seen: Seen = [];
      const error = await mistral({ apiKey: 'fixture-key', fetch: transport({ kind: 'http', status, detail: 'PRIVATE upstream detail' }, seen) }).model('mistral-test', settings).generate(request())
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ reason });
      expect(String((error as Error).message)).not.toContain('PRIVATE');
      expect(seen).toHaveLength(1);
    }
  });

  it('keeps the model\'s thinking for the next call of the run, and never releases it', async () => {
    const thinking = { type: 'thinking', thinking: [{ type: 'text', text: 'The customer wants order ord-1.' }], signature: 'sig-1' };
    const first = await mistral({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: completion({ content: [thinking],
      tool_calls: [{ id: 'AbCdEf123', type: 'function', function: { name: 'orders_lookup', arguments: '{"orderId":"ord-1"}' } }] }, 'tool_calls', usage(10, 5)) }) })
      .model('mistral-test', settings).generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'AbCdEf123', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] });
    expect(JSON.stringify(first.type === 'tool_calls' ? first.calls : [])).not.toContain('The customer wants');
    const seen: Seen = [];
    await mistral({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'Shipped.' }, inputTokens: 20, outputTokens: 5 }, seen) }).model('mistral-test', settings).generate(request({
      tools, continuation: first.continuation!,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'AbCdEf123', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] },
        { role: 'tool', callId: 'AbCdEf123', toolId: 'orders.lookup', result: { status: 'shipped' } }],
    }));
    const messages = seen[0]!.body['messages'] as JsonObject[];
    expect(messages[2]).toEqual({ role: 'assistant', prefix: false, content: [thinking], tool_calls: [{ id: 'AbCdEf123', type: 'function', index: 0, function: { name: 'orders_lookup', arguments: '{"orderId":"ord-1"}' } }] });
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'AbCdEf123', name: 'orders_lookup', content: '{"status":"shipped"}' });
    // A continuation from another model is refused, never sent.
    await expect(mistral({ apiKey: 'fixture-key', fetch: transport(final) }).model('mistral-other', settings).generate(request({ continuation: first.continuation! })))
      .rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('renames call ids Mistral would reject, consistently across the conversation', async () => {
    const seen: Seen = [];
    await mistral({ apiKey: 'fixture-key', fetch: transport(final, seen) }).model('mistral-test', settings).generate(request({ tools, messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', calls: [{ id: 'call_from-another-provider', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }, { id: 'Keep12345', toolId: 'orders.lookup', input: { orderId: 'ord-2' } }] },
      { role: 'tool', callId: 'call_from-another-provider', toolId: 'orders.lookup', result: { status: 'shipped' } },
      { role: 'tool', callId: 'Keep12345', toolId: 'orders.lookup', result: { status: 'pending' } },
    ] }));
    const messages = seen[0]!.body['messages'] as JsonObject[];
    const ids = (messages[2]!['tool_calls'] as JsonObject[]).map(call => call['id']);
    expect(ids[0]).toMatch(/^[A-Za-z0-9]{9}$/u); expect(ids[1]).toBe('Keep12345');
    expect([messages[3]!['tool_call_id'], messages[4]!['tool_call_id']]).toEqual(ids);
  });

  it('streams text and tool calls, reporting output text as it arrives', async () => {
    const adapter = mistral({ apiKey: 'fixture-key', fetch: transport({ kind: 'events', events: [
      chunk({ role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Looking it up.' }] }] }),
      chunk({ tool_calls: [{ id: 'AbCdEf123', index: 0, function: { name: 'orders_lookup', arguments: '{"orderId":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: '', arguments: '"ord-1"}' } }] }),
      chunk({ content: '' }, 'tool_calls', usage(30, 8)),
    ] }) }).model('mistral-test', settings);
    const events = [];
    for await (const event of adapter.stream!(request({ tools }))) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: 'response', response: expect.objectContaining({ type: 'tool_calls', calls: [{ id: 'AbCdEf123', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] }) })]);
    // One event, no deltas: the thinking goes only into the continuation, for the next call.
    expect(JSON.stringify(events.map(event => event.type === 'response' && event.response.type === 'tool_calls' ? event.response.calls : event))).not.toContain('Looking it up');
  });

  it('sends images as data URLs or URLs, and refuses PDFs and unusable configuration', async () => {
    const seen: Seen = [];
    await mistral({ apiKey: 'fixture-key', fetch: transport(final, seen) }).model('mistral-test', settings).generate(request({
      messages: [{ role: 'user', content: 'What is this?', media: [media(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', { name: 'receipt' })] }] }));
    expect((seen[0]!.body['messages'] as JsonObject[])[1]).toEqual({ role: 'user', content: [{ type: 'text', text: '"What is this?"' }, { type: 'text', text: 'Image: receipt' },
      { type: 'image_url', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] });
    const big = { kind: 'raw' as const, body: completion({ content: JSON.stringify({ answer: 'x'.repeat(5_000) }) }, 'stop', usage(1, 1)) };
    await expect(mistral({ apiKey: 'fixture-key', maxResponseBytes: 1_000, fetch: transport(big) }).model('mistral-test', settings).generate(request())).rejects.toMatchObject({ reason: 'invalid_response' });
    for (const options of [{}, { apiKey: '' }, { apiKey: 'k\nX' }, { apiKey: 'k', baseURL: 'http://insecure.example' }, { apiKey: 'k', headers: { authorization: 'x' } },
      { apiKey: 'k', media: { types: ['application/pdf'], urls: true } }]) {
      expect(() => mistral(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('runs an agent through a model registry with catalog prices, granted by its model id', async () => {
    const models = createModels({ providers: [mistral({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 10, outputTokens: 2 }) })],
      prices: 'catalog', maxCallCostMicros: 50_000 });
    expect(models.list().map(model => model.id)).toEqual(Object.keys(catalog.models).map(name => `mistral/${name}`));
    expect(() => models.model('mistral/mistral-medium-latest')).toThrow(/No price/);
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model('mistral/mistral-medium-3-5') });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:mistral/mistral-medium-3-5'] }, limits: { maxCostMicros: 100_000 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
    expect(catalog.models['mistral-medium-3-5']!.pricing).toEqual({ inputMicrosPerMillionTokens: 1_500_000, outputMicrosPerMillionTokens: 7_500_000 });
  });
});
