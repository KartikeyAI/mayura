import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonObject, JsonValue, ModelHistoryMessage, ModelMessage, ModelRequest, ModelStreamEvent } from '@mayura/core';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { openAICompatibleChat, openAIResponses } from '../src/index.js';

// A run given a conversation history sends it first, in the provider's own form, on every call of the run. The
// continuation stays about the run's own messages.

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
const inputSchema: JsonObject = { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } }, required: ['left', 'right'], additionalProperties: false };
const tools: ModelRequest['tools'] = [{ id: 'math/add.v1', description: 'Add numbers.', inputJsonSchema: inputSchema }];
const pricing = { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 };
// Every kind of history message. `math.add.v1` is a tool this run does not offer whose safe name would be the offered
// tool's, and `call.h/2` an id with characters some providers refuse.
const history: ModelHistoryMessage[] = [
  { role: 'user', content: { message: 'Add 1 and 2, and look up A-1.' } },
  { role: 'assistant', calls: [{ id: 'call_h1', toolId: 'math/add.v1', input: { left: 1, right: 2 } }, { id: 'call.h/2', toolId: 'math.add.v1', input: { left: 0, right: 0 } }] },
  { role: 'tool', callId: 'call_h1', toolId: 'math/add.v1', result: { sum: 3 } },
  { role: 'tool', callId: 'call.h/2', toolId: 'math.add.v1', result: { sum: 0 } },
  { role: 'assistant', output: { answer: 3 } },
  { role: 'user', content: 'Thanks.' },
  { role: 'assistant', output: 'You are welcome.' },
];
const own: ModelMessage[] = [{ role: 'user', content: { question: '2 + 3' } }];
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Return JSON.', messages: own, tools,
  signal: new AbortController().signal, maxOutputTokens: 64, outputJsonSchema: outputSchema, ...overrides });
const bodyOf = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): JsonObject => JSON.parse(String(fetch.mock.calls[index]![1]!.body)) as JsonObject;
afterEach(() => { vi.restoreAllMocks(); });

describe('openAIResponses with a conversation history', () => {
  const message = (text: string): JsonObject => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
  const functionCall = (callId: string): JsonObject => ({ type: 'function_call', id: 'fc_1', status: 'completed', call_id: callId, name: 'math_add_v1', arguments: '{"left":2,"right":3}' });
  const reasoning: JsonObject = { type: 'reasoning', id: 'rs_1', encrypted_content: 'OPAQUE', summary: [] };
  const reply = (output: JsonValue[]): Response => new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } }));
  const adapter = (fetch: typeof globalThis.fetch) => openAIResponses({ apiKey: 'fixture-not-a-real-key', model: 'fixture-model', maxCostMicros: 100, pricing, fetch });
  const renderedHistory: JsonValue[] = [
    { role: 'user', content: '{"message":"Add 1 and 2, and look up A-1."}' },
    { type: 'function_call', call_id: 'call_h1', name: 'math_add_v1', arguments: '{"left":1,"right":2}' },
    { type: 'function_call', call_id: 'call.h/2', name: 'math_add_v1_2', arguments: '{"left":0,"right":0}' },
    { type: 'function_call_output', call_id: 'call_h1', output: '{"sum":3}' },
    { type: 'function_call_output', call_id: 'call.h/2', output: '{"sum":0}' },
    { role: 'assistant', content: '{"answer":3}' },
    { role: 'user', content: '"Thanks."' },
    { role: 'assistant', content: '"You are welcome."' },
  ];

  it('declares the capability and sends the history first, every kind in its own form, then the run\'s messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply([message('{"answer":5}')]));
    const model = adapter(fetch);
    expect(model.capabilities.history).toBe(true);
    expect(await model.generate(request({ history }))).toMatchObject({ type: 'final', output: { answer: 5 } });
    const body = bodyOf(fetch);
    expect(body['input']).toEqual([...renderedHistory, { role: 'user', content: '{"question":"2 + 3"}' }]);
    // Only this run's tools are offered, under the names they have without a history.
    expect((body['tools'] as JsonObject[]).map(tool => tool['name'])).toEqual(['math_add_v1']);
  });

  it('sends the history first on a later call too, keeping the continuation about the run\'s own messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply([reasoning, functionCall('call_1')])).mockResolvedValueOnce(reply([reasoning, functionCall('call_1')]));
    const model = adapter(fetch);
    const first = await model.generate(request({ history }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'math/add.v1' }] });
    // The same continuation as a run without a history: the history is never stored in it.
    const plain = await model.generate(request());
    expect(first.continuation).toEqual(plain.continuation);
    expect(first.continuation).toMatchObject({ consumed: 1, history: [{ role: 'user', content: '{"question":"2 + 3"}' }, reasoning, functionCall('call_1')] });
    const messages: ModelMessage[] = [...own, { role: 'assistant', calls: [{ id: 'call_1', toolId: 'math/add.v1', input: { left: 2, right: 3 } }] },
      { role: 'tool', callId: 'call_1', toolId: 'math/add.v1', result: { sum: 5 } }];
    fetch.mockResolvedValueOnce(reply([message('{"answer":5}')]));
    expect(await model.generate(request({ history, messages, continuation: first.continuation! }))).toMatchObject({ type: 'final', output: { answer: 5 } });
    expect(bodyOf(fetch, 2)['input']).toEqual([...renderedHistory, { role: 'user', content: '{"question":"2 + 3"}' }, reasoning, functionCall('call_1'),
      { type: 'function_call_output', call_id: 'call_1', output: '{"sum":5}' }]);
    // A continuation that has consumed more messages than the run has is still refused, history or not.
    await expect(model.generate(request({ history, messages: own, continuation: { ...(first.continuation as JsonObject), consumed: 2 } }))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('refuses a call of this run that reuses a call id from the history', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => reply([functionCall('call_h1')]));
    await expect(adapter(fetch).generate(request({ history }))).rejects.toMatchObject({ reason: 'invalid_response', costMicros: 1 });
    await expect(adapter(fetch).generate(request())).resolves.toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_h1' }] });
  });

  it('streams with the history first', async () => {
    const events = [{ type: 'response.output_text.delta', delta: '{"answer":5}' },
      { type: 'response.completed', response: { status: 'completed', output: [message('{"answer":5}')], usage: { input_tokens: 1, output_tokens: 1 } } }];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const seen: ModelStreamEvent[] = [];
    for await (const event of adapter(fetch).stream!(request({ history }))) seen.push(event);
    expect(seen.at(-1)).toMatchObject({ type: 'response', response: { type: 'final', output: { answer: 5 } } });
    expect((bodyOf(fetch)['input'] as JsonValue[]).slice(0, renderedHistory.length)).toEqual(renderedHistory);
  });

  it('continues a conversation end to end through the runtime', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply([reasoning, { ...functionCall('call_1'), name: 'math_add' }]))
      .mockResolvedValueOnce(reply([message('{"answer":5}')]));
    const add = defineTool({ id: 'math.add', version: '1', description: 'Add numbers.', input: z.object({ left: z.number(), right: z.number() }), output: z.object({ sum: z.number() }),
      effects: 'read', capabilities: [], execute: ({ left, right }) => ({ sum: left + right }) });
    const agent = defineAgent({ id: 'adder', version: '1', instructions: 'Add.', input: z.string(), output: z.object({ answer: z.number() }), tools: [add], model: adapter(fetch) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai.responses', 'tool:math.add', 'effect:read'] }, limits: { maxCostMicros: 1_000 } });
    try {
      const earlier: ModelHistoryMessage[] = [{ role: 'user', content: 'What is 1 + 2?' }, { role: 'assistant', output: { answer: 3 } }];
      expect(await runtime.submit(agent, { input: 'And 2 + 3?', history: earlier }).result()).toMatchObject({ status: 'succeeded', output: { answer: 5 } });
      for (const index of [0, 1]) {
        expect((bodyOf(fetch, index)['input'] as JsonValue[]).slice(0, 3)).toEqual([{ role: 'user', content: '"What is 1 + 2?"' }, { role: 'assistant', content: '{"answer":3}' },
          { role: 'user', content: '"And 2 + 3?"' }]);
      }
    } finally { await runtime.close(); }
  });
});

describe('openAICompatibleChat with a conversation history', () => {
  const reply = (message: JsonObject, finish = 'stop'): Response => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  const toolCall = (id: string): JsonObject => ({ id, type: 'function', function: { name: 'math_add_v1', arguments: '{"left":2,"right":3}' } });
  const adapter = (fetch: typeof globalThis.fetch) => openAICompatibleChat({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'local-fixture', maxCostMicros: 10, pricing, fetch });
  const renderedHistory: JsonValue[] = [
    { role: 'user', content: '{"message":"Add 1 and 2, and look up A-1."}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_h1', type: 'function', function: { name: 'math_add_v1', arguments: '{"left":1,"right":2}' } },
      { id: 'call.h/2', type: 'function', function: { name: 'math_add_v1_2', arguments: '{"left":0,"right":0}' } }] },
    { role: 'tool', tool_call_id: 'call_h1', content: '{"sum":3}' },
    { role: 'tool', tool_call_id: 'call.h/2', content: '{"sum":0}' },
    { role: 'assistant', content: '{"answer":3}' },
    { role: 'user', content: '"Thanks."' },
    { role: 'assistant', content: '"You are welcome."' },
  ];

  it('declares the capability and sends the history after the instructions and before the run\'s messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply({ content: '{"answer":5}' }));
    const model = adapter(fetch);
    expect(model.capabilities.history).toBe(true);
    expect(await model.generate(request({ history }))).toMatchObject({ type: 'final', output: { answer: 5 } });
    const body = bodyOf(fetch);
    expect(body['messages']).toEqual([{ role: 'system', content: 'Return JSON.' }, ...renderedHistory, { role: 'user', content: '{"question":"2 + 3"}' }]);
    expect((body['tools'] as JsonObject[]).map(tool => (tool['function'] as JsonObject)['name'])).toEqual(['math_add_v1']);
  });

  it('sends the history first on a later call, and matches the continuation\'s turns to the run\'s own assistant turns only', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ content: null, reasoning_content: 'Add them.', tool_calls: [toolCall('call_1')] }, 'tool_calls'))
      .mockResolvedValue(reply({ content: '{"answer":5}' }));
    const model = adapter(fetch);
    const first = await model.generate(request({ history }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'math/add.v1' }] });
    const messages: ModelMessage[] = [...own, { role: 'assistant', calls: [{ id: 'call_1', toolId: 'math/add.v1', input: { left: 2, right: 3 } }] },
      { role: 'tool', callId: 'call_1', toolId: 'math/add.v1', result: { sum: 5 } }];
    expect(await model.generate(request({ history, messages, continuation: first.continuation! }))).toMatchObject({ type: 'final', output: { answer: 5 } });
    // The provider's own turn, with its reasoning, answers the run's first assistant turn, not the history's.
    expect(bodyOf(fetch, 1)['messages']).toEqual([{ role: 'system', content: 'Return JSON.' }, ...renderedHistory, { role: 'user', content: '{"question":"2 + 3"}' },
      { role: 'assistant', content: null, reasoning_content: 'Add them.', tool_calls: [toolCall('call_1')] }, { role: 'tool', tool_call_id: 'call_1', content: '{"sum":5}' }]);
    // History assistant turns do not count toward the continuation: one own turn and no run assistant message is refused.
    await expect(model.generate(request({ history, messages: own, continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a call of this run that reuses a call id from the history', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => reply({ content: null, tool_calls: [toolCall('call_h1')] }, 'tool_calls'));
    await expect(adapter(fetch).generate(request({ history }))).rejects.toMatchObject({ reason: 'invalid_response', costMicros: 1 });
    await expect(adapter(fetch).generate(request())).resolves.toMatchObject({ type: 'tool_calls', calls: [{ id: 'call_h1' }] });
  });
});
