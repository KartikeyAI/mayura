import { describe, expect, it, vi } from 'vitest';
import type { JsonObject, ModelRequest } from '@mayura/core';
import { anthropicMessages, type AnthropicMessagesSettings } from '../../provider-anthropic/src/index.js';
import { openAIResponses, type OpenAIResponsesSettings } from '../src/index.js';

// The native adapters behind a gateway such as Cloudflare AI Gateway: an explicit https endpoint, the gateway's own
// credential header, and no provider key when the gateway holds it.

const schema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const request: ModelRequest = { instructions: 'Help.', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal, maxOutputTokens: 32, outputJsonSchema: schema };
const common = { model: 'fixture-model', maxCostMicros: 100, pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 } };
const gateway = 'https://gateway.ai.cloudflare.com/v1/account/default';
const token = { 'cf-aig-authorization': 'Bearer gateway-token' };
const openaiAnswer = () => new Response(JSON.stringify({ status: 'completed', usage: { input_tokens: 3, output_tokens: 2 },
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }] }));
const anthropicAnswer = () => new Response(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
  content: [{ type: 'text', text: '{"answer":"ok"}' }] }));
const call = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) => ({ url: String(fetch.mock.calls[0]![0]), headers: fetch.mock.calls[0]![1]!.headers as Record<string, string> });

describe('openAIResponses behind a gateway', () => {
  it('sends to the endpoint with the gateway credential, and no provider key when the gateway holds it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => openaiAnswer());
    await expect(openAIResponses({ ...common, endpoint: `${gateway}/openai/responses`, headers: token, fetch }).generate(request)).resolves.toMatchObject({ output: { answer: 'ok' } });
    expect(call(fetch)).toEqual({ url: `${gateway}/openai/responses`, headers: { 'cf-aig-authorization': 'Bearer gateway-token', 'Content-Type': 'application/json' } });
    // With its own key too, both are sent.
    const keyed = vi.fn<typeof globalThis.fetch>(async () => openaiAnswer());
    await openAIResponses({ ...common, apiKey: 'provider-key', endpoint: `${gateway}/openai/responses`, headers: token, fetch: keyed }).generate(request);
    expect(call(keyed).headers).toMatchObject({ Authorization: 'Bearer provider-key', 'cf-aig-authorization': 'Bearer gateway-token' });
  });

  it('refuses an endpoint or headers that could send data or credentials somewhere unintended', () => {
    const refused = (options: Partial<OpenAIResponsesSettings>) => () => openAIResponses({ ...common, apiKey: 'key', ...options });
    expect(refused({ endpoint: 'http://gateway.example.com/openai/responses' })).toThrow('endpoint must be an https:// URL ending in /responses');
    expect(refused({ endpoint: 'https://gateway.example.com/openai/chat/completions' })).toThrow('ending in /responses');
    expect(refused({ endpoint: 'https://user:pass@gateway.example.com/responses' })).toThrow('without credentials');
    expect(refused({ endpoint: 'https://gateway.example.com/responses?key=x' })).toThrow('query');
    expect(refused({ headers: { Authorization: 'Bearer other' } })).toThrow('cannot replace Authorization');
    expect(refused({ headers: { 'x-bad': 'a\r\nb' } })).toThrow('at most 8 extra header values');
    // A missing key is allowed only with both an endpoint and a credential header. TypeScript refuses these calls;
    // the casts check that plain JavaScript callers are refused too.
    expect(() => openAIResponses({ ...common } as never)).toThrow('bounded API key are required');
    expect(() => openAIResponses({ ...common, endpoint: `${gateway}/openai/responses` } as never)).toThrow('bounded API key are required');
    expect(() => openAIResponses({ ...common, headers: token } as never)).toThrow('bounded API key are required');
  });
});

describe('anthropicMessages behind a gateway', () => {
  it('sends to the endpoint with the gateway credential and the API version, and no x-api-key when the gateway holds it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => anthropicAnswer());
    await expect(anthropicMessages({ ...common, endpoint: `${gateway}/anthropic/v1/messages`, headers: token, fetch }).generate(request)).resolves.toMatchObject({ output: { answer: 'ok' } });
    expect(call(fetch)).toEqual({ url: `${gateway}/anthropic/v1/messages`,
      headers: { 'cf-aig-authorization': 'Bearer gateway-token', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  });

  it('refuses a bad endpoint and headers that replace its own', () => {
    const refused = (options: Partial<AnthropicMessagesSettings>) => () => anthropicMessages({ ...common, apiKey: 'key', ...options });
    expect(refused({ endpoint: 'https://gateway.example.com/anthropic/v1/complete' })).toThrow('endpoint must be an https:// URL ending in /messages');
    expect(refused({ headers: { 'X-Api-Key': 'other' } })).toThrow('cannot replace x-api-key, anthropic-version');
    expect(refused({ headers: { 'anthropic-version': '2099-01-01' } })).toThrow('cannot replace');
    expect(() => anthropicMessages({ ...common, endpoint: `${gateway}/anthropic/v1/messages` } as never)).toThrow('bounded API key are required');
  });
});
