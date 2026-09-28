import { afterEach, describe, expect, it, vi } from 'vitest';
import { media, mediaUrl, type JsonObject, type JsonValue, type ModelMessage, type ModelRequest } from '@mayura/core';
import { testImage, testPdf } from '../../testing/src/index.js';
import { openAICompatibleChat, openAIResponses } from '../src/index.js';

// Images and PDFs on the wire: Responses input parts, Chat Completions content parts, tool-returned media as a user
// turn after the tool results, and continuations that never hold media bytes.

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: {}, required: [], additionalProperties: false };
const image = testImage({ name: 'shot.png' }); const pdf = testPdf({ name: 'invoice.pdf' });
const imageBase64 = Buffer.from((image as { data: Uint8Array }).data).toString('base64');
const pricing = { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 };
const request = (messages: ModelMessage[], overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Look.', messages,
  tools: [{ id: 'screen.capture', description: 'Screenshot.', inputJsonSchema: toolSchema }], signal: new AbortController().signal, maxOutputTokens: 64, outputJsonSchema: outputSchema, ...overrides });
const json = (value: JsonValue): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const sentBody = (transport: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): JsonObject => JSON.parse(String(transport.mock.calls[index]![1]!.body)) as JsonObject;
const history: ModelMessage[] = [
  { role: 'user', content: { question: 'What is on screen?' }, media: [image] },
  { role: 'assistant', calls: [{ id: 'call_1', toolId: 'screen.capture', input: {} }] },
  { role: 'tool', callId: 'call_1', toolId: 'screen.capture', result: { captured: true }, media: [testImage()] },
];
afterEach(() => { vi.restoreAllMocks(); });

describe('OpenAI Responses', () => {
  const answer = json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"answer":"a cat"}' }] }], usage: { input_tokens: 10, output_tokens: 2 } });
  const adapter = (transport: typeof globalThis.fetch, extra = {}) => openAIResponses({ apiKey: 'fixture-key', model: 'fixture-model', maxCostMicros: 100, pricing, fetch: transport, ...extra });

  it('sends input images and PDFs as input parts, and tool media as a user turn after the tool results', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => answer.clone());
    await adapter(transport).generate(request([{ role: 'user', content: { q: 1 }, media: [image, pdf, mediaUrl('https://cdn.example.com/a.png', 'image/png')] }]));
    expect((sentBody(transport)['input'] as JsonObject[])[0]).toEqual({ role: 'user', content: [
      { type: 'input_text', text: '{"q":1}' },
      { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' },
      { type: 'input_file', filename: 'invoice.pdf', file_data: expect.stringMatching(/^data:application\/pdf;base64,JVBERi0/u) },
      { type: 'input_image', image_url: 'https://cdn.example.com/a.png', detail: 'auto' },
    ] });
    await adapter(transport).generate(request(history));
    const input = sentBody(transport, 1)['input'] as JsonObject[];
    expect(input.map(item => item['type'] ?? item['role'])).toEqual(['user', 'function_call', 'function_call_output', 'user']);
    expect(input[3]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Media returned by the tool calls above:' }, { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' }] });
  });

  it('keeps media bytes out of the continuation, and puts them back from the request on the next call', async () => {
    const transport = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ status: 'completed', output: [{ type: 'function_call', id: 'fc', status: 'completed', call_id: 'call_1', name: 'screen_capture', arguments: '{}' }], usage: { input_tokens: 10, output_tokens: 2 } }))
      .mockResolvedValueOnce(answer.clone());
    const model = adapter(transport);
    const first = await model.generate(request(history.slice(0, 1)));
    expect(JSON.stringify(first.continuation)).not.toContain(imageBase64);
    expect(JSON.stringify(first.continuation)).toContain('mayura_media');
    await model.generate(request(history, { continuation: first.continuation! }));
    const input = sentBody(transport, 1)['input'] as JsonObject[];
    expect(JSON.stringify(input)).not.toContain('mayura_media');
    expect((input[0]!['content'] as JsonObject[])[1]).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' });
    // A continuation that points at media the request does not hold is refused.
    await expect(model.generate(request([{ role: 'user', content: 1 }, ...history.slice(1)], { continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('declares what it sees, and allows encoded media on top of the JSON request limit', async () => {
    expect(adapter(vi.fn()).capabilities.media).toEqual({ types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'], urls: true });
    expect(adapter(vi.fn(), { media: false }).capabilities.media).toBeUndefined();
    expect(adapter(vi.fn(), { media: { types: ['image/png'], urls: false } }).capabilities.media).toEqual({ types: ['image/png'], urls: false });
    expect(() => adapter(vi.fn(), { media: { types: ['image/svg+xml'], urls: false } })).toThrow('media must list media types');
    const big = new Uint8Array(1_500_000); big.set((image as { data: Uint8Array }).data);
    const transport = vi.fn<typeof globalThis.fetch>(async () => answer.clone());
    await expect(adapter(transport).generate(request([{ role: 'user', content: 1, media: [media(big, 'image/png')] }]))).resolves.toMatchObject({ type: 'final' });
  });
});

describe('OpenAI-compatible Chat Completions', () => {
  const answer = json({ choices: [{ message: { role: 'assistant', content: '{"answer":"a cat"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const adapter = (transport: typeof globalThis.fetch, extra = {}) => openAICompatibleChat({ endpoint: 'https://api.example.com/v1/chat/completions', remote: { id: 'vision' },
    apiKey: 'fixture-key', model: 'fixture-model', maxCostMicros: 100, pricing, fetch: transport, ...extra });

  it('declares no media unless told what the model sees', () => {
    expect(adapter(vi.fn()).capabilities.media).toBeUndefined();
    expect(adapter(vi.fn(), { media: { types: ['image/png', 'image/jpeg'], urls: true } }).capabilities.media).toEqual({ types: ['image/png', 'image/jpeg'], urls: true });
  });

  it('sends images as image_url parts, PDFs as file parts, and tool media after all the tool results', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => answer.clone());
    const model = adapter(transport, { media: { types: ['image/png', 'application/pdf'], urls: true } });
    await model.generate(request([{ role: 'user', content: { q: 1 }, media: [image, pdf, mediaUrl('https://cdn.example.com/a.png', 'image/png')] }]));
    expect((sentBody(transport)['messages'] as JsonObject[])[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: '{"q":1}' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
      { type: 'file', file: { filename: 'invoice.pdf', file_data: expect.stringMatching(/^data:application\/pdf;base64,/u) } },
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
    ] });
    const twoTools: ModelMessage[] = [history[0]!, { role: 'assistant', calls: [{ id: 'call_1', toolId: 'screen.capture', input: {} }, { id: 'call_2', toolId: 'screen.capture', input: {} }] },
      { ...history[2]!, callId: 'call_1' } as ModelMessage, { role: 'tool', callId: 'call_2', toolId: 'screen.capture', result: { captured: true }, media: [testImage()] }];
    await model.generate(request(twoTools));
    const messages = sentBody(transport, 1)['messages'] as JsonObject[];
    expect(messages.map(message => message['role'])).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(messages[3]!['content']).toBe('{"captured":true}');
    expect((messages[5]!['content'] as JsonObject[]).map(part => part['type'])).toEqual(['text', 'image_url', 'image_url']);
  });

  it('refuses a PDF by URL, which Chat Completions cannot take', async () => {
    const model = adapter(vi.fn<typeof globalThis.fetch>(async () => answer.clone()), { media: { types: ['application/pdf'], urls: true } });
    await expect(model.generate(request([{ role: 'user', content: 1, media: [mediaUrl('https://cdn.example.com/a.pdf', 'application/pdf')] }])))
      .rejects.toMatchObject({ reason: 'configuration' });
  });
});
