import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaUrl, type JsonObject, type ModelMessage, type ModelRequest } from '@mayura/core';
import { testImage, testPdf } from '../../testing/src/index.js';
import { anthropicMessages } from '../src/index.js';

// Images and PDFs as Anthropic content blocks: with the user's input, and inside (or beside) tool results.

const schema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: {}, required: [], additionalProperties: false };
const image = testImage({ name: 'shot.png' }); const pdf = testPdf({ name: 'invoice.pdf' });
const imageBase64 = Buffer.from((image as { data: Uint8Array }).data).toString('base64');
const answer = (): Response => new Response(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '{"answer":"a cat"}' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }));
const adapter = (fetch: typeof globalThis.fetch, extra = {}) => anthropicMessages({ apiKey: 'fixture-key', model: 'claude-fixture', maxCostMicros: 100,
  pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 }, fetch, ...extra });
const request = (messages: ModelMessage[]): ModelRequest => ({ instructions: 'Look.', messages, tools: [{ id: 'screen.capture', description: 'Screenshot.', inputJsonSchema: toolSchema }],
  signal: new AbortController().signal, maxOutputTokens: 64, outputJsonSchema: schema });
const sent = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): JsonObject[] => JSON.parse(String(fetch.mock.calls[index]![1]!.body)).messages as JsonObject[];
afterEach(() => { vi.restoreAllMocks(); });

describe('Anthropic media', () => {
  it('sends images and PDFs as image and document blocks, inline or by URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
    await adapter(fetch).generate(request([{ role: 'user', content: { q: 1 }, media: [image, pdf, mediaUrl('https://cdn.example.com/a.png', 'image/png')] }]));
    expect(sent(fetch)[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: '{"q":1}' },
      { type: 'text', text: 'Image: shot.png' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
      { type: 'document', title: 'invoice.pdf', source: { type: 'base64', media_type: 'application/pdf', data: expect.stringMatching(/^JVBERi0/u) } },
      { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/a.png' } },
    ] });
  });

  it('puts tool images inside the tool result and tool PDFs after it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
    await adapter(fetch).generate(request([{ role: 'user', content: 1 }, { role: 'assistant', calls: [{ id: 'call_1', toolId: 'screen.capture', input: {} }] },
      { role: 'tool', callId: 'call_1', toolId: 'screen.capture', result: { captured: true }, media: [testImage(), testPdf()] }]));
    expect(sent(fetch)[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '{"captured":true}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } }] },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: expect.any(String) } },
    ] });
  });

  it('declares every type by default, and what it is told otherwise', () => {
    expect(adapter(vi.fn()).capabilities.media).toEqual({ types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'], urls: true });
    expect(adapter(vi.fn(), { media: false }).capabilities.media).toBeUndefined();
    expect(() => adapter(vi.fn(), { media: { types: ['text/html'], urls: false } })).toThrow('media must be false');
  });
});
