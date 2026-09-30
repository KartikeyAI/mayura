import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, z, type JsonObject } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { catalog, openai } from '../src/index.js';

// The OpenAI Responses API on the wire, answering each conformance scenario through the SDK's fetch option.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const message = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

function transport(scenario: ModelScenario, seen: { url: string; body: JsonObject; headers: Headers }[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    seen.push({ url: String(input instanceof Request ? input.url : input), body, headers: new Headers(init?.headers) });
    switch (scenario.kind) {
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ error: { message: scenario.detail, type: 'invalid_request_error' } }, scenario.status);
      case 'invalid': return json({ status: 'completed', output: [message(`not json: ${scenario.detail}`)], usage: usage(1, 1) });
      case 'refusal': return json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No.' }] }], usage: usage(5, 1) });
      case 'final': return json({ status: 'completed', output: [message(JSON.stringify(scenario.output))], usage: usage(scenario.inputTokens, scenario.outputTokens) });
      case 'tool_calls': {
        const offered = (body['tools'] as { name: string; description: string }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.name;
        return json({ status: 'completed', usage: usage(scenario.inputTokens, scenario.outputTokens), output: scenario.calls.map((call, index) => ({
          type: 'function_call', id: `fc_${index}`, status: 'completed', call_id: `call_${index}`, name: nameOf(call.toolId), arguments: JSON.stringify(call.input) })) });
      }
      case 'stream_final': return sse([
        { type: 'response.created', response: { status: 'in_progress' } },
        ...scenario.chunks.map(delta => ({ type: 'response.output_text.delta', delta })),
        { type: 'response.completed', response: { status: 'completed', output: [message(scenario.chunks.join(''))], usage: usage(scenario.inputTokens, scenario.outputTokens) } },
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => openai({ apiKey: 'fixture-not-a-real-key', fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-openai keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-openai', () => {
  const settings = { id: 'openai/gpt-test', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 }, maxCostMicros: 10_000 };
  const request = { instructions: 'x', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], signal: new AbortController().signal, maxOutputTokens: 64,
    outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };

  it('sends a strict Responses request to OpenAI, with the key, and nothing from the environment', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://attacker.example/v1'); vi.stubEnv('OPENAI_ORG_ID', 'org-from-env'); vi.stubEnv('OPENAI_PROJECT_ID', 'proj-from-env');
    // OPENAI_LOG would make the SDK log each request, prompts included.
    vi.stubEnv('OPENAI_LOG', 'debug'); const logged = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level as 'log'));
    const seen: { url: string; body: JsonObject; headers: Headers }[] = [];
    await openai({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 }, seen) }).model('gpt-test', settings).generate(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
    expect(seen[0]!.headers.get('openai-organization')).toBeNull();
    expect(seen[0]!.headers.get('openai-project')).toBeNull();
    expect(seen[0]!.body).toMatchObject({ model: 'gpt-test', store: false, max_output_tokens: 64, text: { format: { type: 'json_schema', strict: true } } });
    for (const spy of logged) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });

  it('makes one attempt per call: the SDK never retries on its own', async () => {
    const seen: { url: string; body: JsonObject; headers: Headers }[] = [];
    const adapter = openai({ apiKey: 'fixture-key', fetch: transport({ kind: 'http', status: 429, detail: 'slow down' }, seen) }).model('gpt-test', settings);
    await expect(adapter.generate(request)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(seen).toHaveLength(1);
  });

  it('refuses a response larger than maxResponseBytes without reading it all', async () => {
    const big = async () => json({ status: 'completed', output: [message(JSON.stringify({ answer: 'x'.repeat(5_000) }))], usage: usage(1, 1) });
    await expect(openai({ apiKey: 'fixture-key', maxResponseBytes: 1_000, fetch: big }).model('gpt-test', settings).generate(request)).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('refuses configuration it cannot use', () => {
    for (const options of [{}, { apiKey: '' }, { apiKey: 'k\nX' }, { apiKey: 'k', baseURL: 'http://insecure.example/v1' }, { apiKey: 'k', headers: { Authorization: 'x' } }, { apiKey: 'k', media: { types: ['text/html'], urls: true } }]) {
      expect(() => openai(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('runs an agent through a model registry, granted by its model id', async () => {
    const models = createModels({ providers: [openai({ apiKey: 'fixture-key', fetch: transport({ kind: 'final', output: { answer: 'ok' }, inputTokens: 10, outputTokens: 2 }) })],
      prices: { 'openai/gpt-test': settings.pricing }, maxCallCostMicros: 10_000 });
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model('openai/gpt-test') });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai/gpt-test'] }, limits: { maxCostMicros: 100_000 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
  });

  it('ships a dated catalog whose prices a registry accepts, with the long-context tier on every model', () => {
    expect(catalog.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const models = createModels({ providers: [openai({ apiKey: 'fixture-key' })], prices: 'catalog', maxCallCostMicros: 10_000 });
    const listed = models.list();
    expect(listed.map(model => model.id)).toContain('openai/gpt-6-sol');
    for (const model of listed) {
      expect(model.catalogAsOf).toBe(catalog.asOf);
      expect(model.pricing?.longContext?.aboveInputTokens).toBe(272_000);
      expect(() => models.model(model.id)).not.toThrow();
    }
    expect(catalog.models['gpt-6-sol']!.pricing).toEqual({ inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000,
      longContext: { aboveInputTokens: 272_000, inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 15_000_000 } });
  });
});
