import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Guard, JsonValue, ModelAdapter, ModelRequest, ModelResponse, ModelStreamEvent } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent } from '../src/index.js';

const reply = z.strictObject({ reply: z.string() });
const redactEmails: Guard = { id: 'redact-emails', check: value => {
  const text = JSON.stringify(value); const redacted = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, '[EMAIL]');
  return redacted === text ? { decision: 'allow' } : { decision: 'rewrite', value: JSON.parse(redacted) as JsonValue };
} };
function model(script: ((request: ModelRequest) => ModelResponse)[], requests: ModelRequest[] = []): ModelAdapter {
  return { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    async generate(request) { requests.push(request); return script[requests.length - 1]!(request); } };
}
async function run(agent: ReturnType<typeof defineAgent>, input: unknown, allow: string[] = []) {
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', ...allow] } });
  try { const handle = runtime.submit(agent, { input }); const outcome = await handle.result(); const events = []; for await (const event of handle.observe()) events.push(event); return { outcome, events }; }
  finally { await runtime.close(); }
}

describe('guards that rewrite', () => {
  it('redacts the input before the model sees it, and the output before it is released', async () => {
    const requests: ModelRequest[] = [];
    const agent = defineAgent({ id: 'redacting', version: '1', instructions: 'x', input: z.strictObject({ message: z.string() }), output: reply, tools: [],
      guards: { input: [redactEmails], output: [redactEmails] },
      model: model([request => ({ type: 'final', output: { reply: `You wrote ${JSON.stringify(request.messages[0])}; mail us at help@example.com` }, usage: { costMicros: 0 } })], requests) });
    const { outcome } = await run(agent, { message: 'I am ada@example.com' });
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('ada@example.com');
    expect(outcome).toMatchObject({ status: 'succeeded' });
    const text = outcome.status === 'succeeded' ? (outcome.output as { reply: string }).reply : '';
    expect(text).toContain('[EMAIL]'); expect(text).not.toContain('help@example.com');
  });

  it('redacts a tool result before it enters the model history', async () => {
    const lookup = defineTool({ id: 'lookup', version: '1', description: 'Look up.', input: z.object({}), output: z.object({ contact: z.string() }),
      effects: 'none', capabilities: [], inputJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: () => ({ contact: 'grace@example.com' }) });
    const requests: ModelRequest[] = [];
    const agent = defineAgent({ id: 'tools', version: '1', instructions: 'x', input: z.string(), output: reply, tools: [lookup], guards: { output: [redactEmails] },
      model: model([() => ({ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'lookup', input: {} }], usage: { costMicros: 0 } }),
        () => ({ type: 'final', output: { reply: 'done' }, usage: { costMicros: 0 } })], requests) });
    expect((await run(agent, 'go', ['tool:lookup'])).outcome.status).toBe('succeeded');
    expect(JSON.stringify(requests[1]!.messages)).toContain('[EMAIL]'); expect(JSON.stringify(requests[1]!.messages)).not.toContain('grace@example.com');
  });

  it('applies guards in order, and refuses a rewrite that no longer fits the schema', async () => {
    const order: string[] = [];
    const first: Guard = { id: 'first', check: () => { order.push('first'); return { decision: 'rewrite', value: { reply: 'first' } }; } };
    const second: Guard = { id: 'second', check: value => { order.push(`second saw ${(value as { reply: string }).reply}`); return { decision: 'allow' }; } };
    const ordered = defineAgent({ id: 'ordered', version: '1', instructions: 'x', input: z.string(), output: reply, tools: [], guards: { output: [first, second] },
      model: model([() => ({ type: 'final', output: { reply: 'original' }, usage: { costMicros: 0 } })]) });
    expect((await run(ordered, 'x')).outcome).toMatchObject({ status: 'succeeded', output: { reply: 'first' } });
    expect(order).toEqual(['first', 'second saw first']);
    const breaking: Guard = { id: 'breaking', check: () => ({ decision: 'rewrite', value: { unexpected: true } }) };
    const invalid = defineAgent({ id: 'invalid', version: '1', instructions: 'x', input: z.string(), output: reply, tools: [], guards: { output: [breaking] },
      model: model([() => ({ type: 'final', output: { reply: 'original' }, usage: { costMicros: 0 } })]) });
    expect((await run(invalid, 'x')).outcome.status).not.toBe('succeeded');
  });

  it('redacts a streamed batch instead of withholding the rest of the answer', async () => {
    const text = JSON.stringify({ reply: 'Write to ada@example.com any time and we will reply within a day or so.' });
    const streaming: ModelAdapter = { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
      async generate() { throw new Error('unused'); },
      async *stream(): AsyncIterable<ModelStreamEvent> { for (let index = 0; index < text.length; index += 7) yield { type: 'output.delta', text: text.slice(index, index + 7) };
        yield { type: 'response', response: { type: 'final', output: JSON.parse(text) as JsonValue, usage: { costMicros: 0 } } }; } };
    const redactWindow: Guard = { id: 'redact-window', check: value => {
      const redacted = String(value).replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, '[EMAIL]'); return redacted === value ? { decision: 'allow' } : { decision: 'rewrite', value: redacted };
    } };
    const agent = defineAgent({ id: 'stream', version: '1', instructions: 'x', input: z.string(), output: reply, tools: [], model: streaming,
      guards: { output: [redactEmails] }, stream: { field: ['reply'], guards: [redactWindow], batch: { minChars: 30, maxChars: 60 } } });
    const { outcome, events } = await run(agent, 'x');
    const streamed = events.filter(event => event.type === 'output.delta').map(event => String(event.metadata['text'])).join('');
    expect(streamed).toContain('[EMAIL]'); expect(streamed).not.toContain('ada@example.com');
    expect(events.some(event => event.type === 'output.withheld')).toBe(false);
    expect(outcome).toMatchObject({ status: 'succeeded' }); expect(JSON.stringify(outcome)).not.toContain('ada@example.com');
  });
});
