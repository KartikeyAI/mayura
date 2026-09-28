import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonObject, JsonValue, ModelRequest, ModelStreamEvent } from '@mayura/core';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { openAICompatibleChat, type OpenAICompatibleChatOptions } from '../src/index.js';

// Providers that speak most, but not all, of the OpenAI dialect: DeepSeek (JSON mode, strict tools on its beta
// endpoint, thinking with reasoning that must come back) and gateways such as Cloudflare AI Gateway (an extra
// credential header).

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: { q: { type: 'number' } }, required: ['q'], additionalProperties: false };
const base = { model: 'deepseek-flash', maxCostMicros: 100, pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 } };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Help.', messages: [{ role: 'user', content: 'hi' }], tools: [],
  signal: new AbortController().signal, maxOutputTokens: 64, outputJsonSchema: outputSchema, ...overrides });
const reply = (message: JsonObject, finish = 'stop'): Response => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 3 } }), { headers: { 'Content-Type': 'application/json' } });
const make = (options: Partial<OpenAICompatibleChatOptions>, fetch: typeof globalThis.fetch) =>
  openAICompatibleChat({ endpoint: 'https://api.deepseek.com/beta/chat/completions', remote: { id: 'deepseek' }, apiKey: 'fixture-key', ...base, fetch, ...options });
const sent = (transport: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): { body: JsonObject; headers: Record<string, string> } => {
  const init = transport.mock.calls[index]![1]!; return { body: JSON.parse(String(init.body)) as JsonObject, headers: init.headers as Record<string, string> };
};

describe('OpenAI-compatible dialects', () => {
  it('JSON mode: asks for a JSON object and puts the schema in the instructions', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => reply({ content: '{"answer":"ok"}' }));
    expect(await make({ output: 'json_object' }, transport).generate(request())).toMatchObject({ type: 'final', output: { answer: 'ok' } });
    const { body } = sent(transport);
    expect(body['response_format']).toEqual({ type: 'json_object' });
    const system = (body['messages'] as JsonObject[])[0]!;
    expect(system['content']).toContain('Answer with one JSON object'); expect(system['content']).toContain(JSON.stringify(outputSchema));
    expect(body['max_tokens']).toBe(64); expect(body).not.toHaveProperty('max_completion_tokens');
    // The default stays strict JSON Schema.
    await make({}, transport).generate(request());
    expect(sent(transport, 1).body['response_format']).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: outputSchema } });
  });

  it('strict tools, extra request fields, and a gateway credential header', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => reply({ content: '{"answer":"ok"}' }));
    const gateway = openAICompatibleChat({ endpoint: 'https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions', remote: { id: 'cloudflare' },
      headers: { 'cf-aig-authorization': 'Bearer gateway-token' }, ...base, model: 'deepseek/deepseek-flash', strictTools: true, body: { thinking: { type: 'disabled' } }, fetch: transport });
    await gateway.generate(request({ tools: [{ id: 'orders.find', description: 'Find.', inputJsonSchema: toolSchema }] }));
    const { body, headers } = sent(transport);
    expect(headers).toEqual({ 'cf-aig-authorization': 'Bearer gateway-token', 'Content-Type': 'application/json' }); // stored keys: no provider key sent
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect((body['tools'] as JsonObject[])[0]).toEqual({ type: 'function', function: { name: 'orders_find', description: 'Find.', parameters: toolSchema, strict: true } });
    for (const [options, message] of [
      [{ headers: { Authorization: 'Bearer x' } }, /cannot replace Authorization/u],
      [{ headers: { 'x-bad': 'a\r\nb' } }, /at most 8 extra header values/u],
      [{ body: { model: 'other' } }, /body cannot set "model"/u],
      [{ body: { messages: [] } }, /body cannot set "messages"/u],
      [{ output: 'yaml' as 'json_object' }, /output must be/u],
      [{ tokenLimitField: 'max' as 'max_tokens' }, /tokenLimitField must be/u],
      [{ body: { max_completion_tokens: 5 } }, /body cannot set "max_completion_tokens"/u],
      [{ apiKey: undefined }, /require an apiKey, a token source, or a credential header/u],
    ] as const) expect(() => make(options as Partial<OpenAICompatibleChatOptions>, transport)).toThrow(message);
  });

  it('send the output limit as max_completion_tokens for models that refuse max_tokens (found by the live check)', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => reply({ content: '{"answer":"ok"}' }));
    await make({ tokenLimitField: 'max_completion_tokens' }, transport).generate(request());
    const { body } = sent(transport);
    expect(body['max_completion_tokens']).toBe(64); expect(body).not.toHaveProperty('max_tokens');
  });

  it('send a thinking model\'s reasoning back with its turn, and refuse a continuation from another model or endpoint', async () => {
    const transport = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ content: null, reasoning_content: 'I should look it up.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":4}' } }] }, 'tool_calls'))
      .mockResolvedValueOnce(reply({ content: '{"answer":"four"}', reasoning_content: 'Done.' }));
    const adapter = make({}, transport); const tools = [{ id: 'lookup', description: 'Look up.', inputJsonSchema: toolSchema }];
    const first = await adapter.generate(request({ tools }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'lookup', input: { q: 4 } }] });
    const history: ModelRequest['messages'] = [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'call_1', toolId: 'lookup', input: { q: 4 } }] },
      { role: 'tool', callId: 'call_1', toolId: 'lookup', result: { found: 4 } }];
    await adapter.generate(request({ tools, messages: history, continuation: first.continuation! }));
    const assistant = (sent(transport, 1).body['messages'] as JsonObject[])[2]!;
    expect(assistant).toEqual({ role: 'assistant', content: null, reasoning_content: 'I should look it up.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":4}' } }] });
    await expect(make({ model: 'deepseek-v4-pro' }, transport).generate(request({ tools, messages: history, continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(make({ endpoint: 'https://api.deepseek.com/chat/completions' }, transport).generate(request({ tools, messages: history, continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('keep streamed reasoning out of the output, and report an overloaded provider as unavailable', async () => {
    const chunk = (delta: JsonObject, finish: string | null = null): JsonValue => ({ choices: [{ delta, finish_reason: finish }] });
    const stream = new Response([chunk({ reasoning_content: 'thinking…' }), chunk({ content: '{"answer":' }), chunk({ content: '"ok"}' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }].map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
    const events: ModelStreamEvent[] = [];
    for await (const event of make({}, async () => stream).stream!(request())) events.push(event);
    expect(events.filter(event => event.type === 'output.delta').map(event => (event as { text: string }).text).join('')).toBe('{"answer":"ok"}');
    await expect(make({}, async () => reply({ content: '' }, 'insufficient_system_resource')).generate(request())).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('report a refused stream for the provider\'s reason, as a refused call is (found by the live check)', async () => {
    const refused = async (): Promise<Response> => new Response('{"error":"PRIVATE bad token"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    const failure = async (source: AsyncIterable<ModelStreamEvent>): Promise<unknown> => { try { for await (const _ of source) { /* drain */ } } catch (error) { return error; } return undefined; };
    expect(await failure(make({}, refused).stream!(request()))).toMatchObject({ code: 'MODEL_FAILED', reason: 'authentication', httpStatus: 401 });
    expect(await failure(make({}, async () => new Response('busy', { status: 429 })).stream!(request()))).toMatchObject({ reason: 'rate_limited', httpStatus: 429 });
    expect(JSON.stringify(await failure(make({}, refused).stream!(request())))).not.toContain('PRIVATE');
  });

  it('run a tool-using agent end to end against a provider that requires its reasoning back', async () => {
    // A fake DeepSeek: thinking on, and a 400 when a later request lacks the reasoning of an earlier tool-call turn.
    let calls = 0;
    const deepseek = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1; const body = JSON.parse(String(init?.body)) as { messages: JsonObject[] };
      const assistants = body.messages.filter(message => message['role'] === 'assistant');
      if (assistants.some(message => typeof message['reasoning_content'] !== 'string')) return new Response('{"error":"missing reasoning_content"}', { status: 400 });
      if (assistants.length === 0) return reply({ content: null, reasoning_content: 'Need the weather.', tool_calls: [{ id: 'call_w', type: 'function', function: { name: 'weather_get', arguments: '{"city":"Paris"}' } }] }, 'tool_calls');
      return reply({ content: '{"reply":"Sunny in Paris."}', reasoning_content: 'Answer.' });
    };
    const weather = defineTool({ id: 'weather.get', version: '1', description: 'Weather.', input: z.object({ city: z.string() }), output: z.object({ sky: z.string() }),
      effects: 'read', capabilities: [], execute: () => ({ sky: 'sunny' }) });
    const model = openAICompatibleChat({ endpoint: 'https://api.deepseek.com/beta/chat/completions', remote: { id: 'deepseek' }, apiKey: 'fixture-key', ...base,
      output: 'json_object', strictTools: true, fetch: deepseek as typeof globalThis.fetch });
    const agent = defineAgent({ id: 'weather', version: '1', instructions: 'Help.', input: z.string(), output: z.object({ reply: z.string() }), tools: [weather], model });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai-compatible.deepseek', 'tool:weather.get', 'effect:read'] }, limits: { maxCostMicros: 1_000 } });
    try {
      const outcome = await runtime.submit(agent, { input: 'Weather in Paris?' }).result() as { status: string; output?: unknown };
      expect(outcome).toEqual({ status: 'succeeded', output: { reply: 'Sunny in Paris.' } });
      expect(calls).toBe(2);
    } finally { await runtime.close(); }
  });
});

