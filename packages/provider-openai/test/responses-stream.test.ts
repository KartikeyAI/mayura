import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, ModelProviderError, type JsonObject, type JsonValue, type ModelRequest, type ModelStreamEvent } from '@mayura/core';
import { openAIResponses, type OpenAIResponsesOptions } from '../src/index.js';

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const options = (fetch: typeof globalThis.fetch, overrides: Partial<OpenAIResponsesOptions> = {}): OpenAIResponsesOptions => ({
  apiKey: 'fixture-not-a-real-api-key', model: 'fixture-model', outputJsonSchema: outputSchema, maxCostMicros: 100,
  pricing: { inputMicrosPerMillionTokens: 2_000, outputMicrosPerMillionTokens: 5_000 }, fetch, ...overrides });
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [],
  signal: new AbortController().signal, maxOutputTokens: 64, ...overrides });
const sse = (events: JsonValue[], split = 0): Response => {
  const text = events.map(event => `event: ${(event as JsonObject)['type']}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text); const size = split || bytes.length; let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + size)); offset += size; } } }),
    { headers: { 'Content-Type': 'text/event-stream' } });
};
const completed = (text: string, usage = { input_tokens: 10, output_tokens: 2 }): JsonValue => ({ type: 'response.completed',
  response: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], usage } });
async function collect(source: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> { const events: ModelStreamEvent[] = []; for await (const event of source) events.push(event); return events; }
afterEach(() => { vi.restoreAllMocks(); });

describe('Responses streaming', () => {
  it('reports output text deltas as they arrive, then the same complete response a non-streamed call returns', async () => {
    const final = '{"answer":"five"}';
    const transport = vi.fn<typeof globalThis.fetch>(async () => sse([
      { type: 'response.created' }, { type: 'response.output_text.delta', delta: '{"answer":' }, { type: 'response.output_text.delta', delta: '"five"}' },
      { type: 'response.function_call_arguments.delta', delta: '{"secret"' }, completed(final)], 9));
    const events = await collect(openAIResponses(options(transport)).stream!(request()));
    expect(events).toEqual([{ type: 'output.delta', text: '{"answer":' }, { type: 'output.delta', text: '"five"}' },
      { type: 'response', response: { type: 'final', output: { answer: 'five' }, usage: { costMicros: 1 } } }]);
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toMatchObject({ stream: true, store: false });
  });

  it('parses tool calls from the completed response and never reports their argument fragments', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => sse([{ type: 'response.function_call_arguments.delta', delta: '{"q":1' }, { type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'function_call', status: 'completed', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}' }], usage: { input_tokens: 1, output_tokens: 1 } } }]));
    const events = await collect(openAIResponses(options(transport)).stream!(request({ tools: [{ id: 'lookup', description: 'x', inputJsonSchema: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'], additionalProperties: false } }] })));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'response', response: { type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'lookup', input: { q: 1 } }] } });
  });

  it('fails closed on failed, incomplete, truncated or mistyped streams, keeping known cost', async () => {
    for (const body of [[{ type: 'response.failed' }], [{ type: 'response.output_text.delta', delta: '{' }], [{ type: 'response.incomplete' }]]) {
      await expect(collect(openAIResponses(options(async () => sse(body))).stream!(request()))).rejects.toBeInstanceOf(MayuraError);
    }
    await expect(collect(openAIResponses(options(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).stream!(request()))).rejects.toBeInstanceOf(MayuraError);
    const invalid = await collect(openAIResponses(options(async () => sse([completed('not json')]))).stream!(request())).catch(error => error);
    expect(invalid).toBeInstanceOf(ModelProviderError); expect(invalid.costMicros).toBe(1);
  });

  it('aborts the request when the consumer stops reading', async () => {
    let aborted = false;
    const transport = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{"a' })}\n\n`)); } }),
      { headers: { 'Content-Type': 'text/event-stream' } });
    });
    for await (const event of openAIResponses(options(transport)).stream!(request())) { expect(event.type).toBe('output.delta'); break; }
    await vi.waitFor(() => { expect(aborted).toBe(true); });
  });

  it('enforces the response bound across the stream', async () => {
    const huge = Array.from({ length: 200 }, () => ({ type: 'response.output_text.delta', delta: 'x'.repeat(100) }));
    await expect(collect(openAIResponses(options(async () => sse(huge), { maxResponseBytes: 4_096 })).stream!(request()))).rejects.toBeInstanceOf(MayuraError);
  });
});
