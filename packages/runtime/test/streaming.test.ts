import { describe, expect, it } from 'vitest';
import { MayuraError, type Guard, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type ModelStreamEvent, type RunEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent, type AgentStreamPolicy } from '../src/index.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'streaming-test', validate: value => ({ value: value as JsonValue }) } };
const reply = 'Your order ships today. It should arrive on Thursday, and you will get a tracking email.';
const final = (output: JsonValue, costMicros = 3): ModelResponse => ({ type: 'final', output, usage: { costMicros } });

/** A streaming adapter that splits the JSON text of each scripted response into small fragments. */
function streaming(script: ((request: ModelRequest) => ModelResponse)[], options: { fragment?: number; after?: (events: ModelStreamEvent[]) => ModelStreamEvent[] } = {}) {
  let call = 0; const counts = { generate: 0, stream: 0 };
  const adapter: ModelAdapter = {
    id: 'streamer', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 10,
    async generate(request) { counts.generate++; return script[call++]!(request); },
    async *stream(request) {
      counts.stream++;
      const response = script[call++]!(request); const events: ModelStreamEvent[] = [];
      if (response.type === 'final') {
        const text = JSON.stringify(response.output); const size = options.fragment ?? 5;
        for (let index = 0; index < text.length; index += size) events.push({ type: 'output.delta', text: text.slice(index, index + size) });
      }
      events.push({ type: 'response', response });
      for (const event of options.after ? options.after(events) : events) { request.signal.throwIfAborted(); yield event; await Promise.resolve(); }
    },
  };
  return { adapter, counts };
}
async function run(adapter: ModelAdapter, stream: AgentStreamPolicy | undefined, extra: { guards?: Guard[]; tools?: ReturnType<typeof defineTool>[]; maxConcurrentOperations?: number } = {}) {
  const agent = defineAgent({ id: 'streamed', version: '1', instructions: 'x', input: any, output: any, model: adapter, tools: extra.tools ?? [],
    ...(stream ? { stream } : {}), ...(extra.guards ? { guards: { output: extra.guards } } : {}) });
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:streamer', 'tool:lookup'] },
    limits: { maxCostMicros: 100, ...(extra.maxConcurrentOperations ? { maxConcurrentOperations: extra.maxConcurrentOperations } : {}) } });
  try {
    const handle = runtime.submit(agent, { input: 'hi' });
    const outcome = await handle.result(); const events: RunEvent[] = [];
    for await (const event of handle.observe()) events.push(event);
    return { outcome, events, deltas: events.filter(event => event.type === 'output.delta'), budget: runtime.inspect(handle).budget };
  } finally { await runtime.close(); }
}
const text = (deltas: RunEvent[]): string => deltas.map(event => event.metadata['text']).join('');

describe('streamed agent output', () => {
  it('releases the chosen field in guarded batches and still returns the validated whole output', async () => {
    const { adapter, counts } = streaming([() => final({ reply, references: ['ord-1'] })]);
    const seen: string[] = [];
    const logger: Guard = { id: 'batch-logger', check: value => { seen.push(value as string); return { decision: 'allow' }; } };
    const result = await run(adapter, { field: ['reply'], guards: [logger], batch: { minChars: 10, maxChars: 40 } });
    expect(result.outcome).toMatchObject({ status: 'succeeded', output: { reply, references: ['ord-1'] } });
    expect(counts).toEqual({ generate: 0, stream: 1 });
    expect(text(result.deltas)).toBe(reply);
    expect(result.deltas.length).toBeGreaterThan(2);
    expect(result.deltas.map(event => event.metadata['index'])).toEqual(result.deltas.map((_, index) => index));
    expect(result.deltas.every(event => event.metadata['modelCall'] === 1 && (event.metadata['text'] as string).length <= 40)).toBe(true);
    // Each check sees the new batch with the already released text before it as context.
    expect(seen.at(-1)!.endsWith(result.deltas.at(-1)!.metadata['text'] as string)).toBe(true);
    expect(result.budget.spentMicros).toBe(3);
  });

  it('is buffered by default: an agent without a stream policy never streams, even on a streaming adapter', async () => {
    const { adapter, counts } = streaming([() => final({ reply })]);
    const result = await run(adapter, undefined);
    expect(result.outcome.status).toBe('succeeded'); expect(counts).toEqual({ generate: 1, stream: 0 }); expect(result.deltas).toEqual([]);
  });

  it('stops releasing when a batch guard blocks, and the whole-output guards still decide the run', async () => {
    const { adapter } = streaming([() => final({ reply: 'Card 4111 1111 1111 1111 is on file, thanks for asking today.' })]);
    const noCards: Guard = { id: 'no-cards', check: value => ({ decision: /\d{4} \d{4}/u.test(typeof value === 'string' ? value : JSON.stringify(value)) ? 'block' : 'allow' }) };
    const result = await run(adapter, { field: ['reply'], guards: [noCards], batch: { minChars: 4, maxChars: 8 } }, { guards: [noCards] });
    expect(text(result.deltas)).not.toMatch(/\d{4} \d{4}/u);
    expect(result.events.filter(event => event.type === 'output.withheld')).toHaveLength(1);
    expect(result.outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
  });

  it('treats a throwing batch guard as a block, not as permission', async () => {
    const { adapter } = streaming([() => final({ reply })]);
    const broken: Guard = { id: 'broken', check: () => { throw new Error('down'); } };
    const result = await run(adapter, { field: ['reply'], guards: [broken] });
    expect(result.deltas).toEqual([]); expect(result.events.some(event => event.type === 'output.withheld')).toBe(true);
    expect(result.outcome.status).toBe('succeeded');
  });

  it('streams only the final answer after tool calls, never tool arguments', async () => {
    const lookup = defineTool({ id: 'lookup', version: '1', description: 'Look up.', input: any, output: any, effects: 'none', capabilities: [], costMicros: 0, execute: () => ({ status: 'shipped' }) });
    const { adapter } = streaming([() => ({ type: 'tool_calls', calls: [{ id: 'l1', toolId: 'lookup', input: { secretArgument: 'x' } }], usage: { costMicros: 1 } }), () => final({ reply })]);
    const result = await run(adapter, { field: ['reply'], guards: [] }, { tools: [lookup] });
    expect(result.outcome.status).toBe('succeeded');
    expect(text(result.deltas)).toBe(reply); expect(JSON.stringify(result.events)).not.toContain('secretArgument');
    expect(new Set(result.deltas.map(event => event.metadata['modelCall']))).toEqual(new Set([2]));
  });

  it('fails closed on a malformed stream', async () => {
    const extra = streaming([() => final({ reply })], { after: events => [...events, { type: 'output.delta', text: 'late' }] });
    expect((await run(extra.adapter, { field: ['reply'], guards: [] })).outcome.status).toBe('failed');
    const missing = streaming([() => final({ reply })], { after: events => events.filter(event => event.type !== 'response') });
    expect((await run(missing.adapter, { field: ['reply'], guards: [] })).outcome.status).toBe('failed');
    const odd = streaming([() => final({ reply })], { after: events => [{ type: 'reasoning', text: 'x' } as unknown as ModelStreamEvent, ...events] });
    expect((await run(odd.adapter, { field: ['reply'], guards: [] })).outcome.status).toBe('failed');
  });

  it('keeps accounting when a stream fails after a confirmed cost is unknown', async () => {
    const failing: ModelAdapter = { id: 'streamer', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 7,
      async generate() { throw new Error('unused'); },
      async *stream() { yield { type: 'output.delta', text: '{"reply":"par' }; throw new MayuraError('MODEL_FAILED', 'Connection lost.'); } };
    const result = await run(failing, { field: ['reply'], guards: [] });
    expect(result.outcome.status).not.toBe('succeeded'); expect(result.budget.reservedMicros + Number(result.budget.spentMicros)).toBe(7);
  });

  it('does not deadlock batch guards against the model call permit', async () => {
    const { adapter } = streaming([() => final({ reply })]);
    const allow: Guard = { id: 'allow', check: () => ({ decision: 'allow' }) };
    const result = await run(adapter, { field: ['reply'], guards: [allow], batch: { minChars: 8, maxChars: 16 } }, { maxConcurrentOperations: 1 });
    expect(result.outcome.status).toBe('succeeded'); expect(text(result.deltas)).toBe(reply);
  });

  it('validates the stream policy when the agent is defined', () => {
    const { adapter } = streaming([]);
    const define = (stream: unknown) => () => defineAgent({ id: 'a', version: '1', instructions: 'x', input: any, output: any, model: adapter, tools: [], stream: stream as AgentStreamPolicy });
    expect(define({ field: [], guards: [] })).toThrow(MayuraError);
    expect(define({ field: ['reply'] })).toThrow(MayuraError);
    expect(define({ field: ['reply'], guards: [], batch: { minChars: 10, maxChars: 5 } })).toThrow(MayuraError);
    expect(define({ field: ['reply'], guards: [] })).not.toThrow();
  });
});
