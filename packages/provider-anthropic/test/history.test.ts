import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonObject, JsonValue, ModelHistoryMessage, ModelMessage, ModelRequest, ModelStreamEvent } from '@mayura/core';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { anthropicMessages } from '../src/index.js';

// A run given a conversation history sends it first, as Anthropic messages, on every call of the run. The
// continuation's thinking turns stay matched to the run's own assistant turns.

const schema: JsonObject = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } }, required: ['left', 'right'], additionalProperties: false };
const tools: ModelRequest['tools'] = [{ id: 'math/add.v1', description: 'Add numbers.', inputJsonSchema: toolSchema }];
const thinking: JsonObject = { type: 'thinking', thinking: '', signature: 'SIGNED-by-the-provider' };
const reply = (content: JsonObject[], stop = 'end_turn'): Response => new Response(JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: stop,
  usage: { input_tokens: 5, output_tokens: 2 } }));
const adapter = (fetch: typeof globalThis.fetch) => anthropicMessages({ apiKey: 'fixture-key', model: 'claude-fixture', maxCostMicros: 100,
  pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 }, fetch });
// Every kind of history message. `math.add.v1` is a tool this run does not offer whose safe name would be the offered
// tool's, and `call.h/2` an id Anthropic would refuse.
const history: ModelHistoryMessage[] = [
  { role: 'user', content: { message: 'Add 1 and 2, twice.' } },
  { role: 'assistant', calls: [{ id: 'toolu_h1', toolId: 'math/add.v1', input: { left: 1, right: 2 } }, { id: 'call.h/2', toolId: 'math.add.v1', input: { left: 0, right: 0 } }] },
  { role: 'tool', callId: 'toolu_h1', toolId: 'math/add.v1', result: { sum: 3 } },
  { role: 'tool', callId: 'call.h/2', toolId: 'math.add.v1', result: { sum: 0 } },
  { role: 'assistant', output: { answer: 3 } },
  { role: 'user', content: 'Thanks.' },
  { role: 'assistant', output: 'You are welcome.' },
];
const renderedHistory: JsonValue[] = [
  { role: 'user', content: [{ type: 'text', text: '{"message":"Add 1 and 2, twice."}' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_h1', name: 'math_add_v1', input: { left: 1, right: 2 } },
    { type: 'tool_use', id: 'call_h_2', name: 'math_add_v1_2', input: { left: 0, right: 0 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_h1', content: '{"sum":3}' }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_h_2', content: '{"sum":0}' }] },
  { role: 'assistant', content: [{ type: 'text', text: '{"answer":3}' }] },
  { role: 'user', content: [{ type: 'text', text: '"Thanks."' }] },
  { role: 'assistant', content: [{ type: 'text', text: '"You are welcome."' }] },
];
const own: ModelMessage[] = [{ role: 'user', content: { question: '2 + 3' } }];
const ownUser: JsonValue = { role: 'user', content: [{ type: 'text', text: '{"question":"2 + 3"}' }] };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Return JSON.', messages: own, tools,
  signal: new AbortController().signal, maxOutputTokens: 64, outputJsonSchema: schema, ...overrides });
const bodyOf = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): JsonObject => JSON.parse(String(fetch.mock.calls[index]![1]!.body)) as JsonObject;
afterEach(() => { vi.restoreAllMocks(); });

describe('anthropicMessages with a conversation history', () => {
  it('declares the capability and sends the history first, every kind in its own form, then the run\'s messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply([thinking, { type: 'text', text: '{"answer":5}' }]));
    const model = adapter(fetch);
    expect(model.capabilities.history).toBe(true);
    expect(await model.generate(request({ history }))).toMatchObject({ type: 'final', output: { answer: 5 } });
    const body = bodyOf(fetch);
    expect(body['messages']).toEqual([...renderedHistory, ownUser]);
    // Only this run's tools are offered, under the names they have without a history.
    expect((body['tools'] as JsonObject[]).map(tool => tool['name'])).toEqual(['math_add_v1']);
  });

  it('sends the history first on a later call, replaying the run\'s own thinking turn after it', async () => {
    const toolUse: JsonObject = { type: 'tool_use', id: 'toolu_1', name: 'math_add_v1', input: { left: 2, right: 3 } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply([thinking, toolUse], 'tool_use'))
      .mockResolvedValue(reply([thinking, { type: 'text', text: '{"answer":5}' }]));
    const model = adapter(fetch);
    const first = await model.generate(request({ history }));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'toolu_1', toolId: 'math/add.v1' }] });
    expect(first.continuation).toEqual({ provider: 'anthropic.messages.v1', model: 'claude-fixture', assistants: [[thinking, toolUse]] });
    const messages: ModelMessage[] = [...own, { role: 'assistant', calls: [{ id: 'toolu_1', toolId: 'math/add.v1', input: { left: 2, right: 3 } }] },
      { role: 'tool', callId: 'toolu_1', toolId: 'math/add.v1', result: { sum: 5 } }];
    expect(await model.generate(request({ history, messages, continuation: first.continuation! }))).toMatchObject({ type: 'final', output: { answer: 5 } });
    expect(bodyOf(fetch, 1)['messages']).toEqual([...renderedHistory, ownUser, { role: 'assistant', content: [thinking, toolUse] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"sum":5}' }] }]);
    // History assistant turns do not count toward the continuation: one own turn and no run assistant message is refused.
    await expect(model.generate(request({ history, messages: own, continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives call ids Anthropic refuses a stand-in no other call uses, for the call and its result alike', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply([{ type: 'text', text: '{"answer":5}' }]));
    const clash: ModelHistoryMessage[] = [{ role: 'user', content: 'go' },
      { role: 'assistant', calls: [{ id: 'a.b', toolId: 'math/add.v1', input: { left: 1, right: 1 } }, { id: 'a_b', toolId: 'math/add.v1', input: { left: 2, right: 2 } }] },
      { role: 'tool', callId: 'a.b', toolId: 'math/add.v1', result: 2 }, { role: 'tool', callId: 'a_b', toolId: 'math/add.v1', result: 4 }];
    await adapter(fetch).generate(request({ history: clash }));
    const sent = bodyOf(fetch)['messages'] as { content: JsonObject[] }[];
    expect(sent[1]!.content.map(block => block['id'])).toEqual(['a_b_2', 'a_b']);
    expect([sent[2]!.content[0]!['tool_use_id'], sent[3]!.content[0]!['tool_use_id']]).toEqual(['a_b_2', 'a_b']);
  });

  it('states earlier calls and results as text when this run offers no tools, since Anthropic refuses tool blocks then', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply([{ type: 'text', text: '{"answer":5}' }]));
    await adapter(fetch).generate(request({ history, tools: [] }));
    const body = bodyOf(fetch);
    expect(body).not.toHaveProperty('tools');
    expect(body['messages']).toEqual([renderedHistory[0],
      { role: 'assistant', content: [{ type: 'text', text: '{"tool_calls":[{"call_id":"toolu_h1","tool":"math/add.v1","input":{"left":1,"right":2}},{"call_id":"call.h/2","tool":"math.add.v1","input":{"left":0,"right":0}}]}' }] },
      { role: 'user', content: [{ type: 'text', text: '{"tool_result":{"call_id":"toolu_h1","tool":"math/add.v1","result":{"sum":3}}}' }] },
      { role: 'user', content: [{ type: 'text', text: '{"tool_result":{"call_id":"call.h/2","tool":"math.add.v1","result":{"sum":0}}}' }] },
      ...renderedHistory.slice(4), ownUser]);
  });

  it('refuses a call of this run that reuses a history call id, as recorded or as sent', async () => {
    for (const id of ['toolu_h1', 'call_h_2']) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => reply([{ type: 'tool_use', id, name: 'math_add_v1', input: { left: 2, right: 3 } }], 'tool_use'));
      await expect(adapter(fetch).generate(request({ history }))).rejects.toMatchObject({ reason: 'invalid_response', costMicros: 1 });
      await expect(adapter(fetch).generate(request())).resolves.toMatchObject({ type: 'tool_calls', calls: [{ id }] });
    }
  });

  it('streams with the history first', async () => {
    const start = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } };
    const events = [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"answer":5}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
    const seen: ModelStreamEvent[] = [];
    for await (const event of adapter(fetch).stream!(request({ history }))) seen.push(event);
    expect(seen.at(-1)).toMatchObject({ type: 'response', response: { type: 'final', output: { answer: 5 } } });
    expect(bodyOf(fetch)['messages']).toEqual([...renderedHistory, ownUser]);
  });

  it('continues a conversation end to end against a provider that holds Anthropic\'s rules', async () => {
    // A fake Claude: tool blocks need tools and ids in Anthropic's alphabet, every result answers an earlier call, and the
    // assistant turns of the current turn (since the last user text) must carry their signed thinking.
    let calls = 0;
    const claude = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { tools?: unknown[]; messages: { role: string; content: JsonObject[] }[] };
      const refuse = (message: string) => new Response(JSON.stringify({ type: 'error', error: { message } }), { status: 400 });
      const used = new Set<unknown>(); let turnStart = 0;
      for (const [index, message] of body.messages.entries()) {
        for (const block of message.content) {
          if (block['type'] === 'tool_use' || block['type'] === 'tool_result') { if (!body.tools?.length) return refuse('tool blocks need tools'); }
          if (block['type'] === 'tool_use') { if (!/^[A-Za-z0-9_-]+$/u.test(String(block['id']))) return refuse('bad tool_use id'); used.add(block['id']); }
          if (block['type'] === 'tool_result' && !used.has(block['tool_use_id'])) return refuse('tool_result without tool_use');
          if (message.role === 'user' && block['type'] === 'text') turnStart = index;
        }
      }
      const current = body.messages.slice(turnStart).filter(message => message.role === 'assistant');
      if (current.some(turn => turn.content[0]?.['signature'] !== 'SIGNED-by-the-provider')) return refuse('thinking blocks must be passed back');
      if (current.length === 0) return reply([thinking, { type: 'tool_use', id: 'toolu_1', name: 'math_add', input: { left: 2, right: 3 } }], 'tool_use');
      return reply([thinking, { type: 'text', text: '{"answer":5}' }]);
    };
    const add = defineTool({ id: 'math.add', version: '1', description: 'Add numbers.', input: z.object({ left: z.number(), right: z.number() }), output: z.object({ sum: z.number() }),
      effects: 'read', capabilities: [], execute: ({ left, right }) => ({ sum: left + right }) });
    const agent = defineAgent({ id: 'adder', version: '1', instructions: 'Add.', input: z.string(), output: z.object({ answer: z.number() }), tools: [add],
      model: adapter(claude as typeof globalThis.fetch) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:anthropic.messages', 'tool:math.add', 'effect:read'] }, limits: { maxCostMicros: 1_000 } });
    try {
      const earlier: ModelHistoryMessage[] = [{ role: 'user', content: 'What is 1 + 2?' }, { role: 'assistant', calls: [{ id: 'call.1', toolId: 'math.add', input: { left: 1, right: 2 } }] },
        { role: 'tool', callId: 'call.1', toolId: 'math.add', result: { sum: 3 } }, { role: 'assistant', output: { answer: 3 } }];
      expect(await runtime.submit(agent, { input: 'And 2 + 3?', history: earlier }).result()).toMatchObject({ status: 'succeeded', output: { answer: 5 } });
      expect(calls).toBe(2);
    } finally { await runtime.close(); }
  });
});
