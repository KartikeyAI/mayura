import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, ModelInvocationError, ModelProviderError, type JsonObject, type JsonValue, type ModelMessage, type ModelRequest } from '@mayura/core';
import { openAIResponses, type OpenAIResponsesOptions } from '../src/index.js';

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
const inputSchema: JsonObject = { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } }, required: ['left', 'right'], additionalProperties: false };
const message = (text = '{"answer":5}', status = 'completed'): JsonObject => ({ type: 'message', role: 'assistant', status, content: [{ type: 'output_text', text }] });
const functionCall = (overrides: JsonObject = {}): JsonObject => ({ type: 'function_call', id: 'fc_fixture', status: 'completed', call_id: 'call_1', name: 'math_add_v1', arguments: '{"left":2,"right":3}', ...overrides });
const payload = (output: JsonValue[] = [message()], usage: JsonObject = { input_tokens: 10, output_tokens: 2 }): JsonObject => ({ status: 'completed', output, usage });
const response = (value: JsonValue = payload(), init?: ResponseInit): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init });
function options(overrides: Partial<OpenAIResponsesOptions> = {}): OpenAIResponsesOptions {
  return {
    apiKey: 'fixture-not-a-real-api-key', model: 'fixture-model', outputJsonSchema: outputSchema,
    maxCostMicros: 100, pricing: { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 5_000 },
    ...overrides,
  };
}
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    instructions: 'Fixture instructions.', messages: [{ role: 'user', content: { question: '2 + 3' } }],
    tools: [{ id: 'math/add.v1', description: 'Add numbers.', inputJsonSchema: inputSchema }],
    signal: new AbortController().signal, maxOutputTokens: 128, ...overrides,
  };
}
function transmittedBody(transport: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): JsonObject {
  const init = transport.mock.calls[index]?.[1];
  expect(typeof init?.body).toBe('string');
  return JSON.parse(init?.body as string) as JsonObject;
}

beforeEach(() => {
  // The fallback transport is deliberately incapable of making an actual network request.
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { throw new Error('Live HTTP is disabled in this fixture.'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('schemas from the agent, and failure reasons', () => {
  it('uses the output schema the runtime sends when the adapter has none, and checks an agent before its first call', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const { outputJsonSchema: _given, ...withoutOutput } = options({ fetch: transport });
    const adapter = openAIResponses(withoutOutput);
    await adapter.generate(request({ outputJsonSchema: outputSchema }));
    expect(transmittedBody(transport)['text']).toMatchObject({ format: { schema: outputSchema, strict: true } });
    await expect(adapter.generate(request())).rejects.toMatchObject({ code: 'INVALID_CONFIG', reason: 'configuration' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(() => adapter.checkDefinition!({ tools: [{ id: 'math/add.v1', description: 'Add.', inputJsonSchema: inputSchema }], outputJsonSchema: outputSchema })).not.toThrow();
    expect(() => adapter.checkDefinition!({ tools: [], outputJsonSchema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }))
      .toThrow('The output schema: property "a" is optional');
    expect(() => adapter.checkDefinition!({ tools: [] })).toThrow(/no output JSON Schema/u);
  });

  it('reports why a call failed: unreachable, unavailable, refused', async () => {
    const reason = async (transport: typeof globalThis.fetch): Promise<unknown> => (await openAIResponses(options({ fetch: transport })).generate(request()).catch((error: unknown) => error) as { reason?: unknown }).reason;
    expect(await reason(async () => { throw new TypeError('fetch failed'); })).toBe('unavailable');
    expect(await reason(async () => response({ error: 'PRIVATE' }, { status: 503 }))).toBe('unavailable');
    expect(await reason(async () => response({ error: 'PRIVATE' }, { status: 404 }))).toBe('rejected');
    expect(await reason(async () => response({ ...payload(), status: 'incomplete' }))).toBe('refused');
    expect(await reason(async () => response(payload([message('not json')])))).toBe('invalid_response');
  });
});

describe('Responses request contract', () => {
  it('sends a function without inputs, as schema generators write it, with its empty required list stated', async () => {
    // Zod writes `z.strictObject({})` without `required`; such an object is strict as it stands.
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await openAIResponses(options({ fetch: transport })).generate(request({ tools: [{ id: 'orders/list', description: 'List orders.',
      inputJsonSchema: { type: 'object', properties: {}, additionalProperties: false } }, { id: 'clock/now', description: 'Now.',
      inputJsonSchema: { type: 'object', additionalProperties: false } }] }));
    expect((transmittedBody(transport)['tools'] as JsonObject[]).map(tool => tool['parameters'])).toEqual([
      { type: 'object', properties: {}, additionalProperties: false, required: [] }, { type: 'object', additionalProperties: false, properties: {}, required: [] }]);
    // A property that is not required is still refused before anything is sent.
    const refused = vi.fn<typeof globalThis.fetch>();
    await expect(openAIResponses(options({ fetch: refused })).generate(request({ tools: [{ id: 'orders/find', description: 'Find.',
      inputJsonSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } }] }))).rejects.toBeDefined();
    expect(refused).not.toHaveBeenCalled();
  });

  it('sends only explicit model/function/schema configuration to the fixed HTTPS endpoint', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const adapter = openAIResponses(options({ fetch: transport }));
    expect(adapter.id).toBe('openai.responses');
    expect(await adapter.generate(request())).toEqual({ type: 'final', output: { answer: 5 }, usage: { costMicros: 1 } });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fixture-not-a-real-api-key', 'Content-Type': 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = transmittedBody(transport);
    expect(body).toMatchObject({ model: 'fixture-model', store: false, stream: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: true, max_output_tokens: 128 });
    expect(body['tools']).toEqual([{ type: 'function', name: 'math_add_v1', description: 'Add numbers.', parameters: inputSchema, strict: true }]);
    expect(body['text']).toEqual({ format: { type: 'json_schema', name: 'mayura_output', schema: outputSchema, strict: true } });
    expect(JSON.stringify(body)).not.toContain('fixture-not-a-real-api-key');
  });

  it('captures credential/model/pricing/schema options before later mutation', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const schema: JsonObject = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
    const pricing = { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 5_000 };
    const configured = { ...options({ fetch: transport }), pricing, outputJsonSchema: schema };
    const adapter = openAIResponses(configured);
    configured.apiKey = 'mutated-key'; configured.model = 'mutated-model'; pricing.inputMicrosPerMillionTokens = 100_000_000;
    schema['additionalProperties'] = true;
    expect(await adapter.generate(request())).toMatchObject({ usage: { costMicros: 1 } });
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-not-a-real-api-key' });
    expect(transmittedBody(transport)).toMatchObject({ model: 'fixture-model', text: { format: { schema: { additionalProperties: false } } } });
  });

  it.each(['', '   ', 'line\r\nbreak', 'x'.repeat(4097)])('rejects invalid credentials before dispatch %#', (apiKey) => {
    expect(() => openAIResponses(options({ apiKey }))).toThrow(MayuraError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid timeout configuration %#', (timeoutMs) => {
    expect(() => openAIResponses(options({ timeoutMs }))).toThrow(MayuraError);
  });

  it('rejects invalid output schemas and nested non-strict objects', () => {
    const invalid: JsonObject[] = [
      { type: 'string' },
      { type: 'object', properties: { answer: { type: 'number' } }, required: [], additionalProperties: false },
      { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: true },
      { type: 'object', properties: { child: { type: 'object', properties: {}, required: [], additionalProperties: true } }, required: ['child'], additionalProperties: false },
      { type: 'object', properties: {}, required: [], additionalProperties: false, $defs: { child: { type: 'object', properties: {}, required: [], additionalProperties: true } } },
    ];
    for (const schema of invalid) expect(() => openAIResponses(options({ outputJsonSchema: schema }))).toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('requires every exposed tool to carry a strict portable schema before HTTP', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const adapter = openAIResponses(options({ fetch: transport }));
    await expect(adapter.generate(request({ tools: [{ id: 'missing', description: 'No schema.' }] }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', reason: 'configuration' });
    await expect(adapter.generate(request({ tools: [{ id: 'invalid', description: 'Loose schema.', inputJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: true } }] }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', reason: 'configuration' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects duplicate tool IDs, too many tools, invalid output bounds, and oversized requests before HTTP', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const adapter = openAIResponses(options({ fetch: transport, maxRequestBytes: 2048 }));
    const supplied = request().tools[0]!;
    await expect(adapter.generate(request({ tools: [supplied, supplied] }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    await expect(adapter.generate(request({ tools: Array.from({ length: 129 }, (_, index) => ({ ...supplied, id: `tool-${index}` })) }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    await expect(adapter.generate(request({ maxOutputTokens: 0 }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(adapter.generate(request({ instructions: 'x'.repeat(3000) }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('HTTP boundaries and cancellation', () => {
  it.each([301, 302, 307, 308, 400, 401, 429, 500])('does not retry or expose a rejected HTTP response %#', async (status) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: 'PRIVATE HTTP BODY fixture-not-a-real-api-key' }, { status, headers: { Location: 'https://untrusted.invalid/' } }));
    const error: unknown = await openAIResponses(options({ fetch: transport })).generate(request()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'MODEL_FAILED' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(JSON.stringify(error)).not.toContain('fixture-not-a-real-api-key');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it.each([
    [401, 'The model provider refused the credentials or access to this model (HTTP 401). Check the API key and that it may use this model.'],
    [403, 'The model provider refused the credentials or access to this model (HTTP 403). Check the API key and that it may use this model.'],
    [429, "The model provider's rate limit or quota was reached (HTTP 429). Try again later, or raise the limit with the provider."],
  ] as const)('returns an actionable safe diagnostic for HTTP %s', async (status, message) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: 'PRIVATE' }, { status }));
    await expect(openAIResponses(options({ fetch: transport })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED', message });
  });

  it('rejects a transport that reports a redirected response', async () => {
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true });
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(redirected);
    await expect(openAIResponses(options({ fetch: transport })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 500, headers: {} },
    { status: 200, headers: { 'Content-Length': '1000000' } },
    { status: 200, headers: { 'Content-Length': 'invalid' } },
  ])('cancels a response body rejected before reader acquisition %#', async (init) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, init));
    await expect(openAIResponses(options({ fetch: transport, maxResponseBytes: 512 })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('enforces streamed response bytes without trusting Content-Length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(513)); }, cancel });
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    await expect(openAIResponses(options({ fetch: transport, maxResponseBytes: 512 })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON, invalid UTF-8, and missing response bodies safely', async () => {
    for (const malformed of [new Response('{PRIVATE-INCOMPLETE'), new Response(new Uint8Array([0xc3, 0x28])), new Response(null)]) {
      const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(malformed);
      const error: unknown = await openAIResponses(options({ fetch: transport })).generate(request()).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'MODEL_FAILED' });
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    }
  });

  it('does not invoke HTTP for an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort('PRIVATE ABORT REASON');
    const transport = vi.fn<typeof globalThis.fetch>();
    const error: unknown = await openAIResponses(options({ fetch: transport })).generate(request({ signal: controller.signal })).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it('bounds a hanging transport and clears its timeout', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const pending = openAIResponses(options({ fetch: transport, timeoutMs: 20 })).generate(request());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hanging response body and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel })));
    const pending = openAIResponses(options({ fetch: transport, timeoutMs: 20 })).generate(request());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('responds to caller cancellation and redacts custom transport errors', async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const pending = openAIResponses(options({ fetch: transport })).generate(request({ signal: controller.signal }));
    controller.abort('PRIVATE CANCEL');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    const failing = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new MayuraError('MODEL_FAILED', 'PRIVATE TRANSPORT TOKEN'));
    const error: unknown = await openAIResponses(options({ fetch: failing })).generate(request()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'MODEL_FAILED' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });
});

describe('complete output parsing and accounting', () => {
  it('round trips aliases and call IDs without exposing provider protocol names as tool IDs', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload([functionCall()])));
    expect(await openAIResponses(options({ fetch: transport })).generate(request())).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'math/add.v1', input: { left: 2, right: 3 } }] });
  });

  it.each([
    [functionCall({ name: 'unregistered' })],
    [functionCall({ arguments: '{partial' })],
    [functionCall({ call_id: '' })],
    [functionCall({ call_id: 'call\ninvalid' })],
    [functionCall(), functionCall()],
    [{ type: 'web_search_call', id: 'unsupported' }],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'PRIVATE REFUSAL' }] }],
    [message('not JSON')],
    [],
  ].map((items) => ({ items })))('rejects malformed or unsupported output without partial tool proposals %#', async ({ items }) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload(items)));
    const error: unknown = await openAIResponses(options({ fetch: transport })).generate(request()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'MODEL_FAILED' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it.each(['in_progress', 'incomplete', 'failed', 'cancelled', 'queued'])('rejects a noncompleted response envelope %#', async (status) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...payload(), status }));
    await expect(openAIResponses(options({ fetch: transport })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  });

  it.each([[message('{"answer":5}', 'incomplete')], [functionCall({ status: 'incomplete' })]].map((items) => ({ items })))('rejects explicitly incomplete items even inside a completed envelope %#', async ({ items }) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload(items)));
    await expect(openAIResponses(options({ fetch: transport })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  });

  it.each([
    {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: '10', output_tokens: 1 }, { input_tokens: 10 },
  ])('rejects missing or invalid usage instead of assuming zero %#', async (usage) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload([message()], usage)));
    await expect(openAIResponses(options({ fetch: transport })).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  });

  it('uses explicit prices, conservatively ignores cache discounts, and rounds upward once', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload([message()], { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 1 } })));
    const adapter = openAIResponses(options({ fetch: transport, pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } }));
    expect(await adapter.generate(request())).toMatchObject({ usage: { costMicros: 1 } });
  });

  it('reports actual configured accounting beyond the admitted bound rather than clamping usage', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload([message()], { input_tokens: 10, output_tokens: 2 })));
    const adapter = openAIResponses(options({ fetch: transport, maxCostMicros: 1, pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 } }));
    expect(adapter.maxCostMicros).toBe(1);
    expect(await adapter.generate(request())).toMatchObject({ usage: { costMicros: 12 } });
  });

  it('rejects cost arithmetic beyond safe public integer accounting', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload([message()], { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER })));
    const adapter = openAIResponses(options({ fetch: transport, pricing: { inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER, outputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER } }));
    await expect(adapter.generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  });
});

describe('private continuation and call correlation', () => {
  it('preserves reasoning/function history once and correlates the next function result', async () => {
    const reasoning: JsonObject = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'PRIVATE-ENCRYPTED-CONTINUATION' };
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(payload([reasoning, functionCall()]))).mockResolvedValueOnce(response());
    const adapter = openAIResponses(options({ fetch: transport }));
    const initial = request();
    const first = await adapter.generate(initial);
    expect(first.type).toBe('tool_calls');
    if (first.type !== 'tool_calls' || first.continuation === undefined) throw new Error('Fixture expected tool continuation.');
    expect(JSON.stringify(first.calls)).not.toContain('PRIVATE');
    const messages: ModelMessage[] = [...initial.messages, { role: 'assistant', calls: first.calls }, { role: 'tool', callId: 'call_1', toolId: 'math/add.v1', result: { sum: 5 } }];
    const final = await adapter.generate(request({ messages, continuation: first.continuation }));
    expect(final).toEqual({ type: 'final', output: { answer: 5 }, usage: { costMicros: 1 } });
    const second = transmittedBody(transport, 1);
    expect(second['input']).toEqual([
      { role: 'user', content: '{"question":"2 + 3"}' }, reasoning, functionCall(),
      { type: 'function_call_output', call_id: 'call_1', output: '{"sum":5}' },
    ]);
    expect(JSON.stringify(final)).not.toContain('PRIVATE');
  });

  it.each([
    { provider: 'other', model: 'fixture-model', history: [], consumed: 0 },
    { provider: 'openai.responses.v1', model: 'different-model', history: [], consumed: 0 },
    { provider: 'openai.responses.v1', model: 'fixture-model', history: [], consumed: 100 },
    { provider: 'openai.responses.v1', model: 'fixture-model', history: [], consumed: -1 },
    { provider: 'openai.responses.v1', model: 'fixture-model', history: 'invalid', consumed: 0 },
  ])('rejects foreign or malformed continuation before HTTP %#', async (continuation) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(openAIResponses(options({ fetch: transport })).generate(request({ continuation }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds continuation together with the next request', async () => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(openAIResponses(options({ fetch: transport, maxRequestBytes: 1024 })).generate(request({ continuation: { provider: 'openai.responses.v1', model: 'fixture-model', history: [{ type: 'reasoning', encrypted_content: 'x'.repeat(2000) }], consumed: 1 } }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('confirmed usage on rejected provider output', () => {
  it.each([
    { label: 'refusal', value: payload([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'PRIVATE REFUSAL' }] }]) },
    { label: 'incomplete response', value: { ...payload(), status: 'incomplete', incomplete_details: { reason: 'PRIVATE REASON' } } },
    { label: 'incomplete output item', value: payload([message('{"answer":5}', 'incomplete')]) },
    { label: 'malformed final JSON', value: payload([message('PRIVATE malformed JSON')]) },
    { label: 'malformed function arguments', value: payload([functionCall({ arguments: 'PRIVATE malformed arguments' })]) },
    { label: 'unknown function alias', value: payload([functionCall({ name: 'PRIVATE-UNKNOWN-ALIAS' })]) },
    { label: 'missing output', value: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 }, private: 'PRIVATE MISSING OUTPUT' } },
  ])('preserves actual known cost for $label without disclosing rejected data', async ({ value }) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value));
    const adapter = openAIResponses(options({ fetch: transport, maxCostMicros: 1,
      pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 } }));
    const error: unknown = await adapter.generate(request()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ code: 'MODEL_FAILED', costMicros: 12 });
    expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(JSON.stringify(error)).not.toContain('fixture-not-a-real-api-key');
    expect(JSON.stringify(error)).not.toContain('output');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('preserves known cost when private continuation exceeds the next-request bound', async () => {
    const reasoning: JsonObject = { type: 'reasoning', summary: [], encrypted_content: `PRIVATE${'x'.repeat(4096)}` };
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload([reasoning, functionCall()])));
    const adapter = openAIResponses(options({ fetch: transport, maxRequestBytes: 2048 }));
    const error: unknown = await adapter.generate(request()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ code: 'MODEL_FAILED', costMicros: 1 });
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'missing usage', value: { status: 'incomplete', output: [] }, status: 200 },
    { label: 'invalid usage', value: payload([], { input_tokens: 'PRIVATE invalid count', output_tokens: 2 }), status: 200 },
    { label: 'rejected HTTP status', value: payload(), status: 500 },
  ])('does not invent confirmed cost for $label', async ({ value, status }) => {
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(value, { status }));
    const error: unknown = await openAIResponses(options({ fetch: transport })).generate(request()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'MODEL_FAILED' });
    expect(error).not.toBeInstanceOf(ModelInvocationError);
    expect(error).not.toHaveProperty('costMicros');
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
