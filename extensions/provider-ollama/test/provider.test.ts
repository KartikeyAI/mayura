import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, media, z, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { ollama } from '../src/index.js';

// Ollama's chat API on the wire, answering each conformance scenario through the provider's fetch option.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const reply = (message: Record<string, unknown>, done_reason: string, input: number, output: number) => ({ model: 'ollama-test', created_at: '2026-09-30T00:00:00Z',
  message: { role: 'assistant', content: '', ...message }, done: true, done_reason, prompt_eval_count: input, eval_count: output });
const ndjson = (lines: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const line of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
  controller.close();
} }), { headers: { 'content-type': 'application/x-ndjson' } });
const part = (message: Record<string, unknown>) => ({ model: 'ollama-test', created_at: '2026-09-30T00:00:00Z', message: { role: 'assistant', content: '', ...message }, done: false });

type Seen = { url: string; body: JsonObject; headers: Headers }[];
function transport(scenario: ModelScenario | { kind: 'raw'; body: unknown; status?: number } | { kind: 'lines'; lines: unknown[] }, seen: Seen = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    seen.push({ url: String(input instanceof Request ? input.url : input), body, headers: new Headers(init?.headers) });
    switch (scenario.kind) {
      case 'raw': return json(scenario.body, scenario.status ?? 200);
      case 'lines': return ndjson(scenario.lines);
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ error: scenario.detail }, scenario.status);
      case 'invalid': return json(reply({ content: `not json: ${scenario.detail}` }, 'stop', 1, 1));
      case 'refusal': return json(reply({ content: '{"answer":' }, 'length', 5, 1));
      case 'final': return json(reply({ content: JSON.stringify(scenario.output) }, 'stop', scenario.inputTokens, scenario.outputTokens));
      case 'tool_calls': {
        const offered = (body['tools'] as { function: { name: string; description: string } }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.function.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.function.name;
        return json(reply({ content: 'Let me look that up.', tool_calls: scenario.calls.map(call => ({ function: { name: nameOf(call.toolId), arguments: call.input } })) },
          'stop', scenario.inputTokens, scenario.outputTokens));
      }
      case 'stream_final': return ndjson([
        ...scenario.chunks.map(content => part({ content })),
        reply({}, 'stop', scenario.inputTokens, scenario.outputTokens),
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => ollama({ fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-ollama keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-ollama', () => {
  const settings = { id: 'ollama/ollama-test', pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 }, maxCostMicros: 1 };
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });
  const final = { kind: 'final' as const, output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 };
  const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];

  it('calls the local server with a structured chat request, and nothing from the environment', async () => {
    vi.stubEnv('OLLAMA_HOST', 'https://attacker.example'); vi.stubEnv('OLLAMA_API_KEY', 'key-from-env');
    const seen: Seen = [];
    const response = await ollama({ fetch: transport(final, seen) }).model('gpt-oss:20b', settings).generate(request());
    expect(response).toMatchObject({ type: 'final', output: { answer: 'ok' }, usage: { costMicros: 0 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(seen[0]!.body).toMatchObject({ model: 'gpt-oss:20b', stream: false, options: { num_predict: 64 }, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: '"hi"' }],
      format: { type: 'object', required: ['answer'] } });
    expect(seen[0]!.body['think']).toBeUndefined();
  });

  it('calls Ollama\'s cloud only with the key it is given, and refuses to fall back to OLLAMA_API_KEY', async () => {
    vi.stubEnv('OLLAMA_API_KEY', 'key-from-env');
    expect(() => ollama({ host: 'https://ollama.com' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    const seen: Seen = [];
    await ollama({ host: 'https://ollama.com', apiKey: 'fixture-key', think: 'high', fetch: transport(final, seen) }).model('gpt-oss:120b', settings).generate(request());
    expect(seen[0]!.url).toBe('https://ollama.com:443/api/chat');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
    expect(seen[0]!.body['think']).toBe('high');
  });

  it('reports a server that is not running as unavailable, and an error status without reading its body', async () => {
    await expect(ollama({ fetch: transport({ kind: 'network' }) }).model('gpt-oss:20b', settings).generate(request())).rejects.toMatchObject({ reason: 'unavailable' });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const error = await ollama({ fetch: async () => new Response('PRIVATE model "gpt-oss:20b" not found', { status: 404 }) }).model('gpt-oss:20b', settings).generate(request())
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ reason: 'rejected', httpStatus: 404 });
      expect(String((error as Error).message)).not.toContain('PRIVATE');
      expect(logged).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it('gives tool calls ids unique in the run, and keeps the model\'s thinking for the next call without releasing it', async () => {
    const first = await ollama({ fetch: transport({ kind: 'raw', body: reply({ thinking: 'The customer wants order ord-1.',
      tool_calls: [{ function: { name: 'orders_lookup', arguments: { orderId: 'ord-1' } } }, { function: { name: 'orders_lookup', arguments: { orderId: 'ord-2' } } }] }, 'stop', 10, 5) }) })
      .model('gpt-oss:20b', settings).generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }, { id: 'call_2', toolId: 'orders.lookup', input: { orderId: 'ord-2' } }] });
    expect(JSON.stringify(first.type === 'tool_calls' ? first.calls : [])).not.toContain('The customer wants');
    const history: ModelRequest['messages'] = [{ role: 'user', content: 'hi' },
      { role: 'assistant', calls: [{ id: 'call_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }, { id: 'call_2', toolId: 'orders.lookup', input: { orderId: 'ord-2' } }] },
      { role: 'tool', callId: 'call_1', toolId: 'orders.lookup', result: { status: 'shipped' } }, { role: 'tool', callId: 'call_2', toolId: 'orders.lookup', result: { status: 'pending' } }];
    const seen: Seen = [];
    const second = await ollama({ fetch: transport({ kind: 'raw', body: reply({ tool_calls: [{ function: { name: 'orders_lookup', arguments: { orderId: 'ord-3' } } }] }, 'stop', 20, 5) }, seen) })
      .model('gpt-oss:20b', settings).generate(request({ tools, continuation: first.continuation!, messages: history }));
    expect(second).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_3' }] });
    const messages = seen[0]!.body['messages'] as JsonObject[];
    expect(messages[2]).toEqual({ role: 'assistant', content: '', thinking: 'The customer wants order ord-1.',
      tool_calls: [{ function: { name: 'orders_lookup', arguments: { orderId: 'ord-1' } } }, { function: { name: 'orders_lookup', arguments: { orderId: 'ord-2' } } }] });
    expect(messages[3]).toEqual({ role: 'tool', tool_name: 'orders_lookup', content: '{"status":"shipped"}' });
    // A continuation from another model is refused, never sent.
    await expect(ollama({ fetch: transport(final) }).model('llama3.2', settings).generate(request({ continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('streams text without the thinking, and fails when the server reports an error mid-stream', async () => {
    const adapter = ollama({ fetch: transport({ kind: 'lines', lines: [part({ thinking: 'Composing.' }), part({ content: '{"answer":' }), part({ content: '"ok"}' }), reply({}, 'stop', 3, 4)] }) })
      .model('gpt-oss:20b', settings);
    const events = [];
    for await (const event of adapter.stream!(request())) events.push(event);
    expect(events.filter(event => event.type === 'output.delta').map(event => event.type === 'output.delta' ? event.text : '').join('')).toBe('{"answer":"ok"}');
    expect(JSON.stringify(events)).not.toContain('Composing');
    expect(events.at(-1)).toMatchObject({ type: 'response', response: { type: 'final', output: { answer: 'ok' } } });
    const broken = ollama({ fetch: transport({ kind: 'lines', lines: [part({ content: '{"answer":' }), { error: 'PRIVATE out of memory' }] }) }).model('gpt-oss:20b', settings);
    const failures: unknown[] = [];
    try { for await (const _event of broken.stream!(request())) { /* drained */ } } catch (error) { failures.push(error); }
    expect(failures).toEqual([expect.objectContaining({ reason: 'unavailable' })]);
    expect(String((failures[0] as Error).message)).not.toContain('PRIVATE');
  });

  it('sends images as base64 only when told the model sees them, with their names', async () => {
    const png = media(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', { name: 'receipt' });
    expect(ollama().model('llava', settings).capabilities.media).toBeUndefined();
    const seen: Seen = [];
    await ollama({ media: { types: ['image/png'], urls: false }, fetch: transport(final, seen) }).model('llava', settings)
      .generate(request({ messages: [{ role: 'user', content: 'What is this?', media: [png] }] }));
    expect((seen[0]!.body['messages'] as JsonObject[])[1]).toEqual({ role: 'user', content: '"What is this?"\n\nImages, in order: receipt', images: ['iVBORw0KGgo='] });
  });

  it('refuses a response larger than maxResponseBytes, and configuration it cannot use', async () => {
    const big = { kind: 'raw' as const, body: reply({ content: JSON.stringify({ answer: 'x'.repeat(5_000) }) }, 'stop', 1, 1) };
    await expect(ollama({ maxResponseBytes: 1_000, fetch: transport(big) }).model('gpt-oss:20b', settings).generate(request())).rejects.toMatchObject({ reason: 'invalid_response' });
    for (const options of [{ host: 'http://ollama.internal:11434' }, { host: 'https://user:pass@gateway.example' }, { host: 'not a url' }, { apiKey: '' }, { apiKey: 'k\nX' },
      { headers: { authorization: 'x' } }, { think: 'extreme' }, { media: { types: ['image/png'], urls: true } }, { media: { types: ['application/pdf'], urls: false } }]) {
      expect(() => ollama(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    for (const host of ['http://localhost:11434', 'http://[::1]:11434', 'https://gateway.example/ollama']) expect(() => ollama({ host })).not.toThrow();
  });

  it('runs an agent through a model registry with a local model priced at zero, granted by its model id', async () => {
    const models = createModels({ providers: [ollama({ fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 10, outputTokens: 2 }) })],
      prices: { 'ollama/gpt-oss:20b': { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } }, maxCallCostMicros: 1 });
    expect(() => models.model('ollama/llama3.2')).toThrow(/No price/);
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model('ollama/gpt-oss:20b') });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:ollama/gpt-oss:20b'] }, limits: { maxCostMicros: 1 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
  });
});
