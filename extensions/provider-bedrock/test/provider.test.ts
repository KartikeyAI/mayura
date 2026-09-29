import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, z, type JsonObject, type ModelRequest } from 'mayura';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from 'mayura/testing';
import { bedrock, catalog } from '../src/index.js';

// The AWS event-stream framing Bedrock streams use, from the SDK's own dependencies.
const load = createRequire(createRequire(import.meta.url).resolve('@aws-sdk/client-bedrock-runtime'));
const { EventStreamCodec } = load('@smithy/core/event-streams') as { EventStreamCodec: new (toUtf8: unknown, fromUtf8: unknown) => { encode(message: unknown): Uint8Array } };
const { fromUtf8, toUtf8 } = load('@smithy/core/serde') as { fromUtf8: (text: string) => Uint8Array; toUtf8: (bytes: Uint8Array) => string };
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const frame = (type: string, body: unknown) => codec.encode({ headers: { ':event-type': { type: 'string', value: type }, ':message-type': { type: 'string', value: 'event' },
  ':content-type': { type: 'string', value: 'application/json' } }, body: fromUtf8(JSON.stringify(body)) });

// Bedrock's Converse API on the wire, answering each conformance scenario through the provider's fetch handler.
const errorTypes: Record<number, string> = { 400: 'ValidationException', 401: 'UnrecognizedClientException', 403: 'AccessDeniedException', 429: 'ThrottlingException', 500: 'InternalServerException', 503: 'ServiceUnavailableException' };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const converse = (content: unknown[], stopReason: string, usage: JsonObject) => ({ output: { message: { role: 'assistant', content } }, stopReason, usage, metrics: { latencyMs: 12 } });
const usage = (input: number, output: number, extra: JsonObject = {}) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output, ...extra });

type Seen = { url: string; body: JsonObject; headers: Headers }[];
function transport(scenario: ModelScenario | { kind: 'raw'; body: unknown }, seen: Seen = []): typeof globalThis.fetch {
  return async (input, init) => {
    const text = init?.body === undefined ? '{}' : typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    const body = JSON.parse(text || '{}') as JsonObject;
    seen.push({ url: String(input instanceof Request ? input.url : input), body, headers: new Headers(init?.headers) });
    switch (scenario.kind) {
      case 'raw': return json(scenario.body);
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ message: scenario.detail }, scenario.status, { 'x-amzn-errortype': `${errorTypes[scenario.status] ?? 'InternalServerException'}:http://internal.amazon.com/coral/` });
      case 'invalid': return json(converse([{ text: `not json: ${scenario.detail}` }], 'end_turn', usage(1, 1)));
      case 'refusal': return json(converse([{ text: 'I cannot help with that.' }], 'content_filtered', usage(5, 1)));
      case 'final': return json(converse([{ text: JSON.stringify(scenario.output) }], 'end_turn', usage(scenario.inputTokens, scenario.outputTokens)));
      case 'tool_calls': {
        const offered = ((body['toolConfig'] as JsonObject | undefined)?.['tools'] as { toolSpec: { name: string; description: string } }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.toolSpec.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.toolSpec.name;
        return json(converse([{ text: 'Checking.' }, ...scenario.calls.map((call, index) => ({ toolUse: { toolUseId: `tooluse_${index}`, name: nameOf(call.toolId), input: call.input } }))],
          'tool_use', usage(scenario.inputTokens, scenario.outputTokens)));
      }
      case 'stream_final': {
        const frames = [frame('messageStart', { role: 'assistant' }), ...scenario.chunks.map(chunk => frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: chunk } })),
          frame('contentBlockStop', { contentBlockIndex: 0 }), frame('messageStop', { stopReason: 'end_turn' }),
          frame('metadata', { usage: usage(scenario.inputTokens, scenario.outputTokens), metrics: { latencyMs: 12 } })];
        return new Response(new ReadableStream({ start(controller) { for (const bytes of frames) controller.enqueue(bytes); controller.close(); } }),
          { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
      }
    }
  };
}

const credentials = { accessKeyId: 'AKIDFIXTURE', secretAccessKey: 'fixture-secret' };
const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => bedrock({ region: 'us-east-1', credentials, fetch: transport(scenario) }).model('model-1', settings),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('@mayurajs/provider-bedrock keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/provider-bedrock', () => {
  const settings = { id: 'bedrock/model-1', pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 5_000_000 }, maxCostMicros: 50_000 };
  const tools = [{ id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } }];
  const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal,
    maxOutputTokens: 64, outputJsonSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...overrides });
  const final = { kind: 'final' as const, output: { answer: 'ok' }, inputTokens: 1, outputTokens: 1 };

  it('signs with the credentials it was given, in its own region, once, and reads nothing from the environment or AWS config', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1'); vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDFROMENV'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-from-env');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'token-from-env'); vi.stubEnv('AWS_ENDPOINT_URL', 'https://attacker.example'); vi.stubEnv('AWS_MAX_ATTEMPTS', '5');
    vi.stubEnv('AWS_AUTH_SCHEME_PREFERENCE', 'httpBearerAuth');
    const seen: Seen = [];
    await bedrock({ region: 'us-east-1', credentials, fetch: transport(final, seen) }).model('global.anthropic.claude-sonnet-5-5', settings).generate(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/converse');
    expect(seen[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDFIXTURE\/\d{8}\/us-east-1\/bedrock\/aws4_request/u);
    expect(seen[0]!.body).toMatchObject({ system: [{ text: 'Be brief.' }], inferenceConfig: { maxTokens: 64 }, outputConfig: { textFormat: { type: 'json_schema' } } });
    const failing: Seen = [];
    await expect(bedrock({ region: 'us-east-1', credentials, fetch: transport({ kind: 'http', status: 503, detail: 'busy' }, failing) }).model('m', settings).generate(request()))
      .rejects.toMatchObject({ reason: 'unavailable' });
    expect(failing).toHaveLength(1);
  });

  it('sends a Bedrock API key as a bearer token instead of signing', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'token-from-env');
    const seen: Seen = [];
    await bedrock({ region: 'us-west-2', apiKey: 'fixture-bedrock-key', fetch: transport(final, seen) }).model('m', settings).generate(request());
    expect(seen[0]!.url.startsWith('https://bedrock-runtime.us-west-2.amazonaws.com/')).toBe(true);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-bedrock-key');
  });

  it('charges cache writes at twice the input rate and cache reads at the full rate', async () => {
    const body = converse([{ text: '{"answer":"ok"}' }], 'end_turn', usage(1_000, 100, { cacheWriteInputTokens: 2_000, cacheReadInputTokens: 3_000 }));
    expect((await bedrock({ region: 'us-east-1', credentials, fetch: transport({ kind: 'raw', body }) }).model('m', settings).generate(request())).usage.costMicros).toBe(8_000 + 500);
  });

  it('keeps reasoning and its signature for the next call of the run, never releases it, and pairs results with calls', async () => {
    const reasoning = { reasoningContent: { reasoningText: { text: 'The customer wants ord-1.', signature: 'sig-1' } } };
    const toolUse = { toolUse: { toolUseId: 'tooluse_1', name: 'orders_lookup', input: { orderId: 'ord-1' } } };
    const first = await bedrock({ region: 'us-east-1', credentials, fetch: transport({ kind: 'raw', body: converse([reasoning, toolUse], 'tool_use', usage(10, 5)) }) })
      .model('m', settings).generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'tooluse_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] });
    expect(JSON.stringify(first.type === 'tool_calls' ? first.calls : [])).not.toContain('customer wants');
    const seen: Seen = [];
    await bedrock({ region: 'us-east-1', credentials, fetch: transport(final, seen) }).model('m', settings).generate(request({
      tools, continuation: first.continuation!,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'tooluse_1', toolId: 'orders.lookup', input: { orderId: 'ord-1' } }] },
        { role: 'tool', callId: 'tooluse_1', toolId: 'orders.lookup', result: { status: 'shipped' } }],
    }));
    const messages = seen[0]!.body['messages'] as JsonObject[];
    expect(messages[1]).toEqual({ role: 'assistant', content: [reasoning, toolUse] });
    expect(messages[2]).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 'tooluse_1', content: [{ text: '{"status":"shipped"}' }] } }] });
    await expect(bedrock({ region: 'us-east-1', credentials, fetch: transport(final) }).model('other', settings).generate(request({ continuation: first.continuation! })))
      .rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('refuses configuration it cannot use', () => {
    for (const options of [{}, { region: 'mars-1', credentials }, { region: 'us-east-1' }, { region: 'us-east-1', credentials, apiKey: 'k' }, { region: 'us-east-1', apiKey: 'k\nX' },
      { region: 'us-east-1', credentials: { accessKeyId: '', secretAccessKey: 's' } }, { region: 'us-east-1', credentials, baseURL: 'http://insecure.example' },
      { region: 'us-east-1', credentials, media: { types: ['image/png'], urls: true } }]) {
      expect(() => bedrock(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('offers its us-east-1 catalog only in us-east-1, and runs an agent through a registry', async () => {
    expect(bedrock({ region: 'us-east-1', credentials }).catalog).toBe(catalog);
    expect(bedrock({ region: 'eu-west-1', credentials }).catalog).toBeUndefined();
    expect(() => createModels({ providers: [bedrock({ region: 'eu-west-1', credentials })], prices: 'catalog', maxCallCostMicros: 50_000 }).model('bedrock/global.anthropic.claude-sonnet-5-5'))
      .toThrow(/No price/);
    const models = createModels({ providers: [bedrock({ region: 'us-east-1', credentials, fetch: transport(final) })], prices: 'catalog', maxCallCostMicros: 50_000 });
    const id = 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0';
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: models.model(id) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: [`model:${id}`] }, limits: { maxCostMicros: 100_000 } });
    expect(await runtime.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 'ok' } });
    await runtime.close();
  });
});
