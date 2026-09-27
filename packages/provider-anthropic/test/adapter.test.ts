import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelInvocationError, type JsonObject, type ModelRequest } from '@mayura/core';
import { anthropicMessages, type AnthropicMessagesOptions } from '../src/index.js';

const schema: JsonObject = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false };
const options = (overrides: Partial<AnthropicMessagesOptions> = {}): AnthropicMessagesOptions => ({
  apiKey: 'explicit-anthropic-key', model: 'claude-fixture', outputJsonSchema: schema, maxCostMicros: 100,
  pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 }, ...overrides,
});
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  instructions: 'Return JSON.', messages: [{ role: 'user', content: { value: 1 } }],
  tools: [{ id: 'value/read', description: 'Read value.', inputJsonSchema: toolSchema }],
  signal: new AbortController().signal, maxOutputTokens: 64, ...overrides,
});
const response = (content: JsonObject[], stopReason = 'end_turn', usage: JsonObject = { input_tokens: 2, output_tokens: 1 }): Response =>
  new Response(JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: stopReason, usage }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Anthropic Messages adapter', () => {
  it('uses the fixed destination, explicit headers and strict schemas', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([{ type: 'text', text: '{"answer":42}' }]));
    const result = await anthropicMessages(options({ fetch })).generate(request());
    expect(result).toEqual({ type: 'final', output: { answer: 42 }, usage: { costMicros: 1 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.headers).toEqual({ 'x-api-key': 'explicit-anthropic-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: 'claude-fixture', max_tokens: 64, stream: false,
      output_config: { format: { type: 'json_schema', schema } }, tools: [{ name: 'tool_0', input_schema: toolSchema, strict: true }] });
    expect(init?.body).not.toContain('explicit-anthropic-key');
  });

  it('maps reversible aliases and multi-step tool history', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([
      { type: 'tool_use', id: 'call_2', name: 'tool_0', input: { value: 2 } },
    ], 'tool_use'));
    const result = await anthropicMessages(options({ fetch })).generate(request({ messages: [
      { role: 'user', content: { value: 1 } },
      { role: 'assistant', calls: [{ id: 'call_1', toolId: 'value/read', input: { value: 1 } }] },
      { role: 'tool', callId: 'call_1', toolId: 'value/read', result: { value: 2 } },
    ] }));
    expect(result).toEqual({ type: 'tool_calls', calls: [{ id: 'call_2', toolId: 'value/read', input: { value: 2 } }], usage: { costMicros: 1 } });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'tool_0', input: { value: 1 } }] });
    expect(body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"value":2}' }] });
  });

  it('charges ordinary, cache-creation and cache-read input tokens', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([{ type: 'text', text: '{"answer":1}' }], 'end_turn',
      { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }));
    await expect(anthropicMessages(options({ fetch, pricing: { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } })).generate(request()))
      .resolves.toMatchObject({ usage: { costMicros: 24 } });
  });

  it.each(['max_tokens', 'refusal', 'pause_turn', 'model_context'])('rejects nonterminal stop reason %s', async stopReason => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([{ type: 'text', text: '{"answer":1}' }], stopReason));
    await expect(anthropicMessages(options({ fetch })).generate(request())).rejects.toBeInstanceOf(ModelInvocationError);
  });

  it('accepts text before a tool call and drops it, but rejects unknown blocks after preserving confirmed usage', async () => {
    const pricing = { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 };
    const narrated = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([
      { type: 'text', text: 'PRIVATE narration' }, { type: 'tool_use', id: 'call_1', name: 'tool_0', input: { value: 2 } },
    ], 'tool_use', { input_tokens: 2, output_tokens: 1 }));
    const called = await anthropicMessages(options({ fetch: narrated, pricing })).generate(request());
    expect(called).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', input: { value: 2 } }], usage: { costMicros: 3 } });
    expect(JSON.stringify(called)).not.toContain('PRIVATE');
    for (const content of [
      [{ type: 'image', source: 'PRIVATE' }, { type: 'tool_use', id: 'call_1', name: 'tool_0', input: { value: 2 } }],
      [{ type: 'text', text: 'PRIVATE only text' }],
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(content, 'tool_use', { input_tokens: 2, output_tokens: 1 }));
      const error: unknown = await anthropicMessages(options({ fetch, pricing })).generate(request()).catch(value => value);
      expect(error).toBeInstanceOf(ModelInvocationError);
      expect(error).toMatchObject({ costMicros: 3 });
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    }
  });

  it('rejects continuation without sending and validates credentials and schemas eagerly', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(anthropicMessages(options({ fetch })).generate(request({ continuation: { private: true } }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => anthropicMessages(options({ apiKey: 'bad\nkey' }))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => anthropicMessages(options({ outputJsonSchema: { type: 'string' } }))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('captures configuration before caller mutation', async () => {
    const mutable = options() as { -readonly [Key in keyof AnthropicMessagesOptions]: AnthropicMessagesOptions[Key] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([{ type: 'text', text: '{"answer":1}' }]));
    mutable.fetch = fetch;
    const adapter = anthropicMessages(mutable);
    mutable.apiKey = 'changed'; mutable.model = 'changed';
    await adapter.generate(request());
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-api-key': 'explicit-anthropic-key' });
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).model).toBe('claude-fixture');
  });

  it('does not expose provider response bodies or arbitrary transport failures', async () => {
    const rejected = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('PRIVATE rejection', { status: 500 }));
    const first: unknown = await anthropicMessages(options({ fetch: rejected })).generate(request()).catch(value => value);
    expect(first).toMatchObject({ code: 'MODEL_FAILED' }); expect(JSON.stringify(first)).not.toContain('PRIVATE');
    const broken = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('PRIVATE transport'));
    const second: unknown = await anthropicMessages(options({ fetch: broken })).generate(request()).catch(value => value);
    expect(second).toMatchObject({ code: 'MODEL_FAILED' }); expect(JSON.stringify(second)).not.toContain('PRIVATE');
  });
});
