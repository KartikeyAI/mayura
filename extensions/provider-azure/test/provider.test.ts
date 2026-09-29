import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { openai } from '@mayurajs/provider-openai';
import { azure, catalog } from '../src/index.js';

// Azure's v1 API speaks OpenAI's Responses API on the wire.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const message = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

type Seen = { url: string; body: JsonObject; headers: Headers }[];
function transport(scenario: ModelScenario | { kind: 'calls'; name: string }, seen: Seen = []): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    seen.push({ url: String(input instanceof Request ? input.url : input), body, headers: new Headers(init?.headers) });
    switch (scenario.kind) {
      case 'calls': return json({ status: 'completed', usage: usage(3, 1), output: [{ type: 'function_call', id: 'fc_0', status: 'completed', call_id: 'call_0', name: scenario.name, arguments: '{"orderId":"ord-1"}' }] });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ error: { message: scenario.detail } }, scenario.status);
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
        ...scenario.chunks.map(delta => ({ type: 'response.output_text.delta', delta })),
        { type: 'response.completed', response: { status: 'completed', output: [message(scenario.chunks.join(''))], usage: usage(scenario.inputTokens, scenario.outputTokens) } },
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => azure({ resource: 'contoso', apiKey: 'fixture-azure-key', fetch: transport(scenario) }).model('prod-chat', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-azure keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-azure', () => {
  const settings = { id: 'azure/prod-chat', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 }, maxCostMicros: 10_000 };
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });
  const final = { kind: 'final' as const, output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 };

  it('calls the resource\'s v1 API by deployment name, with the key, and nothing from the environment', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'key-from-env'); vi.stubEnv('AZURE_OPENAI_ENDPOINT', 'https://attacker.example'); vi.stubEnv('OPENAI_BASE_URL', 'https://attacker.example/v1');
    const seen: Seen = [];
    await azure({ resource: 'contoso', apiKey: 'fixture-azure-key', fetch: transport(final, seen) }).model('prod-chat', settings).generate(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://contoso.openai.azure.com/openai/v1/responses');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-azure-key');
    expect(seen[0]!.body).toMatchObject({ model: 'prod-chat', store: false });
  });

  it('asks a Microsoft Entra ID token source for a fresh token on every request, and refuses an unusable one', async () => {
    let issued = 0;
    const token = async () => `entra-token-${++issued}`;
    const seen: Seen = [];
    const adapter = azure({ baseURL: 'https://contoso.cognitiveservices.azure.com/openai/v1', token, fetch: transport(final, seen) }).model('prod-chat', settings);
    await adapter.generate(request()); await adapter.generate(request());
    expect(seen.map(entry => entry.headers.get('authorization'))).toEqual(['Bearer entra-token-1', 'Bearer entra-token-2']);
    const broken = azure({ resource: 'contoso', token: async () => 'bad\ntoken', fetch: transport(final) }).model('prod-chat', settings);
    await expect(broken.generate(request())).rejects.toMatchObject({ reason: 'configuration' });
    const failing = azure({ resource: 'contoso', token: async () => { throw new Error('PRIVATE sign-in failure'); }, fetch: transport(final) }).model('prod-chat', settings);
    const error = await failing.generate(request()).then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'authentication' });
    expect(String((error as Error).message)).not.toContain('PRIVATE');
  });

  it('prices only the Global deployments it is told about, from the catalog', () => {
    const models = createModels({ providers: [azure({ resource: 'contoso', apiKey: 'k', deployments: { 'prod-chat': { model: 'gpt-5.5', type: 'global' } } })],
      prices: 'catalog', maxCallCostMicros: 10_000 });
    expect(models.list()).toEqual([expect.objectContaining({ id: 'azure/prod-chat', pricing: catalog.models['gpt-5.5']!.pricing, catalogAsOf: catalog.asOf })]);
    expect(() => models.model('azure/other-deployment')).toThrow(/No price/);
    for (const deployments of [{ 'prod-chat': { model: 'gpt-5.5', type: 'data-zone' } }, { 'prod-chat': { model: 'gpt-6-sol', type: 'global' } }, { 'bad name': { model: 'gpt-5.5', type: 'global' } }]) {
      expect(() => azure({ resource: 'contoso', apiKey: 'k', deployments: deployments as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(azure({ resource: 'contoso', apiKey: 'k' }).catalog).toBeUndefined();
  });

  it('never continues a run that another provider started', async () => {
    const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];
    const started = await openai({ apiKey: 'k', fetch: transport({ kind: 'calls', name: 'orders_lookup' }) }).model('prod-chat', { ...settings, id: 'openai/prod-chat' }).generate(request({ tools }));
    expect(started.type).toBe('tool_calls');
    await expect(azure({ resource: 'contoso', apiKey: 'k', fetch: transport(final) }).model('prod-chat', settings).generate(request({ tools, continuation: started.continuation! })))
      .rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('refuses configuration it cannot use', () => {
    for (const options of [{}, { apiKey: 'k' }, { resource: 'contoso' }, { resource: 'contoso', baseURL: 'https://x.example/openai/v1', apiKey: 'k' },
      { resource: 'contoso', apiKey: 'k', token: async () => 't' }, { resource: 'bad resource', apiKey: 'k' }, { baseURL: 'http://insecure.example/openai/v1', apiKey: 'k' },
      { resource: 'contoso', apiKey: 'k', headers: { 'api-key': 'x' } }, { resource: 'contoso', token: 'not-a-function' }]) {
      expect(() => azure(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });
});
