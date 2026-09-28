import { describe, expect, it, vi } from 'vitest';
import { MayuraError, ModelProviderError, type JsonObject, type JsonValue, type ModelRequest, type ModelStreamEvent } from '@mayura/core';
import { anthropicMessages, type AnthropicMessagesOptions } from '../src/index.js';

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const options = (fetch: typeof globalThis.fetch): AnthropicMessagesOptions => ({ apiKey: 'fixture-not-a-real-key', model: 'fixture-model', outputJsonSchema: outputSchema,
  maxCostMicros: 100, pricing: { inputMicrosPerMillionTokens: 3_000, outputMicrosPerMillionTokens: 15_000 }, fetch });
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [],
  signal: new AbortController().signal, maxOutputTokens: 64, ...overrides });
const sse = (events: JsonValue[], split = 0): Response => {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${(event as JsonObject)['type']}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  const size = split || bytes.length; let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + size)); offset += size; } } }),
    { headers: { 'content-type': 'text/event-stream' } });
};
const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'fixture-model', stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } };
const textMessage = (parts: string[], stop = 'end_turn'): JsonValue[] => [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'ping' },
  ...parts.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })), { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 20 } }, { type: 'message_stop' }];
async function collect(source: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> { const events: ModelStreamEvent[] = []; for await (const event of source) events.push(event); return events; }

describe('Messages streaming', () => {
  it('reports text deltas and rebuilds the complete message with combined usage', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => sse(textMessage(['{"answer"', ':"four"}']), 11));
    const events = await collect(anthropicMessages(options(transport)).stream!(request()));
    // Cost: 100 input tokens at 3,000 plus 20 output tokens at 15,000 micros per million, rounded up.
    expect(events).toEqual([{ type: 'output.delta', text: '{"answer"' }, { type: 'output.delta', text: ':"four"}' },
      { type: 'response', response: { type: 'final', output: { answer: 'four' }, usage: { costMicros: 1 } } }]);
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toMatchObject({ stream: true });
  });

  it('assembles tool calls from input fragments without reporting them', async () => {
    const events = await collect(anthropicMessages(options(async () => sse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '7}' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }])))
      .stream!(request({ tools: [{ id: 'lookup', description: 'x', inputJsonSchema: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'], additionalProperties: false } }] })));
    expect(events).toEqual([{ type: 'response', response: { type: 'tool_calls', calls: [{ id: 'toolu_1', toolId: 'lookup', input: { q: 7 } }], usage: { costMicros: 1 },
      continuation: expect.objectContaining({ provider: 'anthropic.messages.v1' }) } }]);
  });

  it('fails closed on errors, missing stop, out-of-order blocks or refusals, keeping known cost', async () => {
    for (const body of [[start, { type: 'error', error: { type: 'overloaded_error' } }], textMessage(['{"answer":"x"}']).slice(0, -1),
      [start, { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }], [{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }]]) {
      await expect(collect(anthropicMessages(options(async () => sse(body))).stream!(request()))).rejects.toBeInstanceOf(MayuraError);
    }
    const refused = await collect(anthropicMessages(options(async () => sse(textMessage(['no'], 'refusal')))).stream!(request())).catch(error => error);
    expect(refused).toBeInstanceOf(ModelProviderError);
  });
});
