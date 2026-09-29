import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, z, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { anthropic, catalog } from '../src/index.js';

// The Anthropic Messages API on the wire, answering each conformance scenario through the SDK's fetch option.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const message = (content: unknown[], stop_reason: string, usage: JsonObject) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content, stop_reason, usage });
const usage = (input: number, output: number, extra: JsonObject = {}) => ({ input_tokens: input, output_tokens: output, ...extra });
const sse = (events: JsonObject[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`));
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
      case 'http': return json({ type: 'error', error: { type: 'api_error', message: scenario.detail } }, scenario.status);
      case 'invalid': return json(message([{ type: 'text', text: `not json: ${scenario.detail}` }], 'end_turn', usage(1, 1)));
      case 'refusal': return json(message([{ type: 'text', text: 'No.' }], 'refusal', usage(5, 1)));
      case 'final': return json(message([{ type: 'text', text: JSON.stringify(scenario.output) }], 'end_turn', usage(scenario.inputTokens, scenario.outputTokens)));
      case 'tool_calls': {
        const offered = (body['tools'] as { name: string; description: string }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.name;
        return json(message([{ type: 'text', text: 'Let me look that up.' }, ...scenario.calls.map((call, index) => ({ type: 'tool_use', id: `toolu_${index}`, name: nameOf(call.toolId), input: call.input }))],
          'tool_use', usage(scenario.inputTokens, scenario.outputTokens)));
      }
      case 'stream_final': return sse([
        { type: 'message_start', message: message([], 'end_turn', usage(scenario.inputTokens, 1)) as JsonObject },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...scenario.chunks.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: scenario.outputTokens } },
        { type: 'message_stop' },
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => anthropic({ apiKey: 'fixture-not-a-real-key', fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-anthropic keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-anthropic', () => {
  const settings = { id: 'anthropic/claude-test', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 5_000_000 }, maxCostMicros: 50_000 };
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });

  it('sends a strict Messages request to Anthropic with the key, and nothing from the environment', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://attacker.example'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-from-env');
    const seen: Seen = [];
    await anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 }, seen) }).model('claude-test', settings).generate(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]!.headers.get('x-api-key')).toBe('fixture-key');
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(seen[0]!.body).toMatchObject({ model: 'claude-test', max_tokens: 64, system: 'Be brief.', output_config: { format: { type: 'json_schema' } } });
  });

  it('makes one attempt per call, and reports an overloaded Anthropic (529) as unavailable', async () => {
    const seen: Seen = [];
    await expect(anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'http', status: 529, detail: 'Overloaded' }, seen) }).model('claude-test', settings).generate(request()))
      .rejects.toMatchObject({ reason: 'unavailable' });
    expect(seen).toHaveLength(1);
  });

  it('charges prompt-cache writes at twice the input rate and cache reads at the full rate', async () => {
    const body = message([{ type: 'text', text: '{"answer":"ok"}' }], 'end_turn', usage(1_000, 100, { cache_creation_input_tokens: 2_000, cache_read_input_tokens: 3_000 }));
    const response = await anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body }) }).model('claude-test', settings).generate(request());
    // (1,000 + 2 × 2,000 + 3,000) input tokens at $1/M, plus 100 output tokens at $5/M.
    expect(response.usage.costMicros).toBe(8_000 + 500);
  });

  it('keeps the model\'s thinking for the next call of the run, and never releases it', async () => {
    const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];
    const thinking = { type: 'thinking', thinking: 'The customer wants order ord-1.', signature: 'sig-1' };
    const first = await anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'raw', body: message([thinking, { type: 'tool_use', id: 'toolu_1', name: 'orders_lookup', input: { orderId: 'ord-1' } }], 'tool_use', usage(10, 5)) }) })
      .model('claude-test', settings).generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'toolu_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] });
    expect(JSON.stringify(first.type === 'tool_calls' ? first.calls : [])).not.toContain('The customer wants');
    const seen: Seen = [];
    await anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'Shipped.' }, inputTokens: 20, outputTokens: 5 }, seen) }).model('claude-test', settings).generate(request({
      tools, continuation: first.continuation!,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'toolu_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] },
        { role: 'tool', callId: 'toolu_1', toolId: 'orders.lookup', result: { status: 'shipped' } }],
    }));
    expect((seen[0]!.body['messages'] as JsonObject[])[1]).toEqual({ role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'orders_lookup', input: { orderId: 'ord-1' } }] });
    // A continuation from another model is refused, never sent.
    await expect(anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'x' }, inputTokens: 1, outputTokens: 1 }) }).model('claude-other', settings)
      .generate(request({ continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('refuses a response larger than maxResponseBytes, and configuration it cannot use', async () => {
    const big = { kind: 'raw' as const, body: message([{ type: 'text', text: JSON.stringify({ answer: 'x'.repeat(5_000) }) }], 'end_turn', usage(1, 1)) };
    await expect(anthropic({ apiKey: 'fixture-key', maxResponseBytes: 1_000, fetch: transport(big) }).model('claude-test', settings).generate(request())).rejects.toMatchObject({ reason: 'invalid_response' });
    for (const options of [{}, { apiKey: '' }, { apiKey: 'k\nX' }, { apiKey: 'k', baseURL: 'http://insecure.example' }, { apiKey: 'k', headers: { 'x-api-key': 'x' } }, { apiKey: 'k', media: { types: ['text/html'], urls: true } }]) {
      expect(() => anthropic(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('runs an agent through a model registry with catalog prices, granted by its model id', async () => {
    const models = createModels({ providers: [anthropic({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 10, outputTokens: 2 }) })],
      prices: 'catalog', maxCallCostMicros: 50_000 });
    expect(models.list().map(model => model.id)).toEqual(Object.keys(catalog.models).map(name => `anthropic/${name}`));
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model('anthropic/claude-sonnet-5-5') });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:anthropic/claude-sonnet-5-5'] }, limits: { maxCostMicros: 100_000 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
    expect(catalog.models['claude-sonnet-5-5']!.pricing).toEqual({ inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000 });
  });
});
