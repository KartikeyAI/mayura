import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonObject, ModelMessage, ModelRequest, ModelStreamEvent } from '@mayura/core';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { anthropicMessages } from '../src/index.js';

// Claude models that think: a tool-call turn starts with a signed thinking block, which Anthropic requires back,
// unchanged, on the next request. Found by the live check through Cloudflare AI Gateway (claude-sonnet-5).

const schema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const toolSchema: JsonObject = { type: 'object', properties: { q: { type: 'number' } }, required: ['q'], additionalProperties: false };
const thinking = { type: 'thinking', thinking: '', signature: 'SIGNED-by-the-provider' };
const reply = (content: JsonObject[], stop = 'end_turn'): Response => new Response(JSON.stringify({ type: 'message', role: 'assistant', content, stop_reason: stop,
  usage: { input_tokens: 5, output_tokens: 2 } }));
const adapter = (fetch: typeof globalThis.fetch, model = 'claude-fixture') => anthropicMessages({ apiKey: 'fixture-key', model, maxCostMicros: 100,
  pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 }, fetch });
const request = (messages: ModelMessage[], extra: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'Help.', messages,
  tools: [{ id: 'lookup', description: 'Look up.', inputJsonSchema: toolSchema }], signal: new AbortController().signal, maxOutputTokens: 64, outputJsonSchema: schema, ...extra });
const sent = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index: number): JsonObject[] => JSON.parse(String(fetch.mock.calls[index]![1]!.body)).messages as JsonObject[];
const history: ModelMessage[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', calls: [{ id: 'toolu_1', toolId: 'lookup', input: { q: 4 } }] },
  { role: 'tool', callId: 'toolu_1', toolId: 'lookup', result: { found: 4 } }];
afterEach(() => { vi.restoreAllMocks(); });

describe('Anthropic thinking', () => {
  it('keeps a tool-call turn\'s signed thinking and sends it back unchanged, never as output', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply([thinking, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 4 }, caller: { type: 'direct' } }], 'tool_use'))
      .mockResolvedValueOnce(reply([{ type: 'redacted_thinking', data: 'OPAQUE' }, { type: 'text', text: '{"answer":"four"}' }]));
    const model = adapter(fetch);
    const first = await model.generate(request(history.slice(0, 1)));
    expect(first).toMatchObject({ type: 'tool_calls', calls: [{ id: 'toolu_1', toolId: 'lookup', input: { q: 4 } }] });
    expect(first.continuation).toEqual({ provider: 'anthropic.messages.v1', model: 'claude-fixture',
      assistants: [[thinking, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 4 } }]] });
    // A final answer after thinking is the text alone.
    expect(await model.generate(request(history, { continuation: first.continuation! }))).toMatchObject({ type: 'final', output: { answer: 'four' } });
    expect(sent(fetch, 1)[1]).toEqual({ role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 4 } }] });
  });

  it('refuses a continuation from another model or one whose calls do not match the history', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply([thinking, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 4 } }], 'tool_use'));
    const first = await adapter(fetch).generate(request(history.slice(0, 1)));
    await expect(adapter(fetch, 'claude-other').generate(request(history, { continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
    const other: ModelMessage[] = [history[0]!, { role: 'assistant', calls: [{ id: 'toolu_9', toolId: 'lookup', input: { q: 4 } }] }, { ...history[2]!, callId: 'toolu_9' } as ModelMessage];
    await expect(adapter(fetch).generate(request(other, { continuation: first.continuation! }))).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('streams only answer text, assembling thinking and its signature for the next request', async () => {
    const events = (list: JsonObject[]) => new Response(list.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const start = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE reasoning' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIGNED' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"answer":"ok"}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]));
    const seen: ModelStreamEvent[] = [];
    for await (const event of adapter(fetch).stream!(request([{ role: 'user', content: 'hi' }]))) seen.push(event);
    expect(seen.filter(event => event.type === 'output.delta')).toEqual([{ type: 'output.delta', text: '{"answer":"ok"}' }]);
    expect(seen.at(-1)).toMatchObject({ type: 'response', response: { type: 'final', output: { answer: 'ok' } } });
    expect(JSON.stringify(seen)).not.toContain('PRIVATE');
  });

  it('runs a tool-using agent end to end against a provider that requires its thinking back', async () => {
    // A fake Claude: it thinks before each tool call, and answers 400 when a later request drops that turn's thinking.
    let calls = 0;
    const claude = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls += 1; const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: JsonObject[] }[] };
      const turns = body.messages.filter(message => message.role === 'assistant');
      if (turns.some(turn => turn.content[0]?.['type'] !== 'thinking' || turn.content[0]?.['signature'] !== 'SIGNED-by-the-provider')) {
        return new Response('{"type":"error","error":{"message":"thinking blocks must be passed back"}}', { status: 400 });
      }
      if (turns.length === 0) return reply([thinking, { type: 'tool_use', id: 'toolu_w', name: 'weather_get', input: { city: 'Paris' } }], 'tool_use');
      return reply([thinking, { type: 'text', text: '{"reply":"Sunny in Paris."}' }]);
    };
    const weather = defineTool({ id: 'weather.get', version: '1', description: 'Weather.', input: z.object({ city: z.string() }), output: z.object({ sky: z.string() }),
      effects: 'read', capabilities: [], execute: () => ({ sky: 'sunny' }) });
    const agent = defineAgent({ id: 'weather', version: '1', instructions: 'Help.', input: z.string(), output: z.object({ reply: z.string() }), tools: [weather],
      model: adapter(claude as typeof globalThis.fetch) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:anthropic.messages', 'tool:weather.get', 'effect:read'] }, limits: { maxCostMicros: 1_000 } });
    try {
      expect(await runtime.submit(agent, { input: 'Weather in Paris?' }).result()).toMatchObject({ status: 'succeeded', output: { reply: 'Sunny in Paris.' } });
      expect(calls).toBe(2);
    } finally { await runtime.close(); }
  });
});
