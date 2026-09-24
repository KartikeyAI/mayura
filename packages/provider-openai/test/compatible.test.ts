import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelInvocationError, type JsonObject, type ModelRequest } from '@mayura/core';
import { openAICompatibleChat, type OpenAICompatibleChatOptions } from '../src/index.js';

const schema: JsonObject = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false };
const options = (overrides: Partial<OpenAICompatibleChatOptions> = {}): OpenAICompatibleChatOptions => ({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  model: 'local-fixture', outputJsonSchema: schema, maxCostMicros: 10,
  pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 }, ...overrides });
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Return JSON.', messages: [{ role: 'user', content: { value: 1 } }],
  tools: [{ id: 'value/read', description: 'Read value.', inputJsonSchema: toolSchema }], signal: new AbortController().signal, maxOutputTokens: 64, ...overrides });
const response = (message: JsonObject, finishReason = 'stop', usage: JsonObject = { prompt_tokens: 2, completion_tokens: 1 }): Response =>
  new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message }], usage }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('loopback OpenAI-compatible chat adapter', () => {
  it.each(['https://127.0.0.1/v1/chat/completions', 'http://example.com/v1/chat/completions',
    'http://127.0.0.1:11434/other', 'http://user:pass@127.0.0.1/v1/chat/completions'])('rejects nonlocal or ambiguous endpoints %s', endpoint => {
    expect(() => openAICompatibleChat(options({ endpoint }))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('sends explicit schema/tools to one loopback destination without ambient credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ role: 'assistant', content: '{"answer":42}' }));
    const result = await openAICompatibleChat(options({ fetch })).generate(request());
    expect(result).toEqual({ type: 'final', output: { answer: 42 }, usage: { costMicros: 1 } });
    const [url, init] = fetch.mock.calls[0]!; expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' }); expect(init?.redirect).toBe('error');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: 'local-fixture', stream: false, response_format: { type: 'json_schema', json_schema: { strict: true, schema } } });
    expect(body.tools[0].function).toMatchObject({ name: 'tool_0', parameters: toolSchema });
  });

  it('maps tool aliases and never treats proposals as authority', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tool_0', arguments: '{"value":2}' } }] }, 'tool_calls'));
    await expect(openAICompatibleChat(options({ fetch })).generate(request())).resolves.toEqual({ type: 'tool_calls',
      calls: [{ id: 'call_1', toolId: 'value/read', input: { value: 2 } }], usage: { costMicros: 1 } });
  });

  it('rejects provider continuation, malformed output, redirects and transport failures safely', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ role: 'assistant', content: 'PRIVATE invalid' }));
    await expect(openAICompatibleChat(options({ fetch })).generate(request({ continuation: { private: true } }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
    const error: unknown = await openAICompatibleChat(options({ fetch })).generate(request()).catch(value => value);
    expect(error).toMatchObject({ code: 'MODEL_FAILED' }); expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it('preserves confirmed usage when a completed response is unusable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ role: 'assistant', content: 'PRIVATE invalid' }, 'stop',
      { prompt_tokens: 2, completion_tokens: 1 }));
    const error: unknown = await openAICompatibleChat(options({ fetch, pricing: { inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 1_000_000 } })).generate(request()).catch(value => value);
    expect(error).toBeInstanceOf(ModelInvocationError); expect(error).toMatchObject({ costMicros: 3 }); expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it('uses only an explicitly supplied bounded credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ role: 'assistant', content: '{"answer":1}' }));
    await openAICompatibleChat(options({ apiKey: 'explicit-local-key', fetch })).generate(request());
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer explicit-local-key' });
    expect(() => openAICompatibleChat(options({ apiKey: 'bad\nheader' }))).toThrow();
  });
});
