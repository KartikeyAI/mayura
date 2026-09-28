import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonValue, ModelAdapter, ModelRequest, ModelResponse, ModelStreamEvent, Schema } from '@mayura/core';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { agentCommandHelp, askPersonTool, confirmBeforeRunning, outputText, parseAgentCommand, runAgentCommand, runTerminalChat } from '../src/index.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'terminal-test', validate: value => ({ value: value as JsonValue }) } };
const scripted = (steps: ((request: ModelRequest) => ModelResponse)[], requests: ModelRequest[] = []): ModelAdapter => ({ id: 'fixture',
  capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
  async generate(request) { requests.push(request); const step = steps[requests.length - 1]; if (!step) throw new Error('No more scripted steps.'); return step(request); } });
const final = (output: JsonValue): ModelResponse => ({ type: 'final', output, usage: { costMicros: 0 } });
const call = (toolId: string, input: JsonValue): ModelResponse => ({ type: 'tool_calls', calls: [{ id: `c-${toolId}`, toolId, input }], usage: { costMicros: 0 } });

/** A fake terminal: keystrokes are typed only once the expected prompt is on screen. */
function terminal() {
  const input = new PassThrough(); let raw = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { raw += String(chunk); done(); } }), { columns: 100, rows: 40 });
  const screen = (): string => raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '');
  const count = (text: string): number => screen().split(text).length - 1;
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.\n${screen().slice(-1500)}`); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const type = async (keys: string): Promise<void> => { for (const key of keys) { input.write(key); await new Promise(resolve => setTimeout(resolve, 3)); } };
  /** Answer the n-th "You" prompt. */
  const say = async (n: number, text: string): Promise<void> => { await waitFor(() => count('◆  You') >= n, `prompt ${n}`); await type(`${text}\r`); };
  return { io: { input, output }, screen, count, waitFor, type, say };
}

describe('terminal chat', () => {
  it('chats, keeps history for the agent, reports cost and leaves on /exit', async () => {
    const requests: ModelRequest[] = [];
    const agent = defineAgent({ id: 'helper', version: '1', instructions: 'Help.', input: any, output: any, tools: [],
      model: scripted([() => final({ reply: 'Hello there.' }), request => final({ reply: `You said: ${JSON.stringify(request.messages[0])}` })], requests) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
    const t = terminal(); const seen: unknown[] = [];
    try {
      const chat = runTerminalChat({ agent, runtime, io: t.io, toInput: (message, history) => { seen.push(history.length); return { message, turns: history.length }; } });
      await t.say(1, 'hi'); await t.waitFor(() => t.screen().includes('Hello there.'), 'first reply');
      await t.say(2, '/help'); await t.waitFor(() => t.screen().includes('/clear  forget the conversation'), 'help');
      await t.say(3, 'again'); await t.waitFor(() => t.screen().includes('You said:'), 'second reply');
      await t.say(4, '/cost'); await t.waitFor(() => t.screen().includes('Spent $'), 'cost');
      await t.say(5, '/exit');
      expect(await chat).toEqual({ turns: 2, spentMicros: 0 });
      expect(seen).toEqual([0, 2]);
      expect(t.screen()).toContain('2 turns');
    } finally { await runtime.close(); }
  });

  it('asks the person before a confirmed tool runs, and refuses it when they decline', async () => {
    const refunds: JsonValue[] = [];
    const refund = confirmBeforeRunning(defineTool({ id: 'orders.refund', version: '1', description: 'Refund an order.', input: any, output: any, effects: 'write', capabilities: [],
      execute: input => { refunds.push(input); return { refunded: true }; } }), { describe: input => `Refund order ${JSON.stringify(input)}` });
    const requests: ModelRequest[] = [];
    const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help.', input: any, output: any, tools: [refund],
      model: scripted([() => call('orders.refund', { order: 'A1' }), () => call('orders.refund', { order: 'B2' }), () => final({ reply: 'Refunded B2.' })], requests) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:orders.refund', 'effect:write'] } });
    const t = terminal();
    try {
      const chat = runTerminalChat({ agent, runtime, io: t.io });
      await t.say(1, 'refund A1');
      await t.waitFor(() => t.screen().includes('Allow it?'), 'first confirmation'); expect(t.screen()).toContain('Refund order {"order":"A1"}');
      await t.type('\r'); // the default is No
      // A declined action ends the turn (Mayura fails closed on a refused tool) and says why; the chat continues.
      await t.waitFor(() => t.screen().includes('The person declined orders.refund.'), 'refusal');
      expect(refunds).toEqual([]);
      await t.say(2, 'refund B2');
      await t.waitFor(() => t.count('Allow it?') >= 2, 'second confirmation');
      await t.type('\u001b[D\r'); // left arrow: Yes
      await t.waitFor(() => t.screen().includes('Refunded B2.'), 'second reply');
      expect(refunds).toEqual([{ order: 'B2' }]);
      await t.say(3, '/exit'); await chat;
    } finally { await runtime.close(); }
  });

  it('lets the agent ask the person a question, and streams replies as they arrive', async () => {
    const text = JSON.stringify({ reply: 'Streaming works fine, one piece at a time.' });
    let streamed = 0;
    const model: ModelAdapter = { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
      async generate() { throw new Error('unused'); },
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        if (streamed++ === 0) { yield { type: 'response', response: call('person.ask', { question: 'Which city?' }) }; return; }
        const answer = JSON.stringify(request.messages.at(-1));
        if (!answer.includes('Paris')) throw new Error(`The answer did not reach the model: ${answer}`);
        for (let index = 0; index < text.length; index += 6) yield { type: 'output.delta', text: text.slice(index, index + 6) };
        yield { type: 'response', response: final(JSON.parse(text) as JsonValue) };
      } };
    const agent = defineAgent({ id: 'travel', version: '1', instructions: 'Help.', input: any, output: any, tools: [askPersonTool], model,
      stream: { field: ['reply'], guards: [], batch: { minChars: 8, maxChars: 32 } } });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:person.ask', 'person:ask'] } });
    const t = terminal();
    try {
      const chat = runTerminalChat({ agent, runtime, io: t.io });
      await t.say(1, 'plan a trip');
      await t.waitFor(() => t.screen().includes('Which city?'), 'question'); await t.type('Paris\r');
      await t.waitFor(() => t.screen().includes('one piece at a time.'), 'streamed reply');
      await t.say(2, '/exit'); await chat;
    } finally { await runtime.close(); }
  });
});

describe('terminal chat defaults', () => {
  it('remember earlier turns, and show the final answer when it differs from what streamed', async () => {
    const requests: ModelRequest[] = []; let turn = 0;
    const model: ModelAdapter = { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
      async generate() { throw new Error('unused'); },
      async *stream(request): AsyncIterable<ModelStreamEvent> {
        requests.push(request);
        if (turn++ === 0) { yield { type: 'response', response: final({ reply: 'Paris is lovely in May.' }) }; return; }
        // The streamed draft is not what the run returns (as when a guard or the output schema changes the answer).
        for (const piece of ['{"reply":"A draft ', 'that changes"}']) yield { type: 'output.delta', text: piece };
        yield { type: 'response', response: final({ reply: 'The final, checked answer.' }) };
      } };
    const agent = defineAgent({ id: 'travel', version: '1', instructions: 'Help.', input: any, output: any, tools: [], model,
      stream: { field: ['reply'], guards: [], batch: { minChars: 1, maxChars: 64 } } });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
    const t = terminal();
    try {
      const chat = runTerminalChat({ agent, runtime, io: t.io });
      await t.say(1, 'Where should I go?'); await t.waitFor(() => t.screen().includes('Paris is lovely'), 'first reply');
      await t.say(2, 'When?'); await t.waitFor(() => t.screen().includes('The final, checked answer.'), 'final answer');
      expect(requests[0]!.messages[0]).toEqual({ role: 'user', content: 'Where should I go?' });
      expect(requests[1]!.messages[0]).toEqual({ role: 'user', content:
        'The conversation so far:\nPerson: Where should I go?\nYou: Paris is lovely in May.\n\nThe person\'s new message:\nWhen?' });
      await t.say(3, '/exit'); await chat;
    } finally { await runtime.close(); }
  });
});

describe('agent commands', () => {
  const schema = { type: 'object', required: ['city'], properties: { city: { type: 'string', description: 'Where to go.' }, days: { type: 'integer' }, budget: { type: 'boolean' } } };
  const capture = () => { let text = ''; return { stream: Object.assign(new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }), { isTTY: false }), text: () => text }; };

  it('builds the input from flags, prints help, and prints JSON with --json', async () => {
    const requests: ModelRequest[] = [];
    const agent = defineAgent({ id: 'planner', version: '1', instructions: 'Plan.', input: any, output: any, tools: [],
      model: scripted([request => final({ reply: `Plan for ${JSON.stringify(request.messages[0])}` }), () => final({ reply: 'text plan' })], requests) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
    try {
      const out = capture(); const err = capture();
      expect(await runAgentCommand({ agent, runtime, inputJsonSchema: schema, argv: ['--city', 'Paris', '--days', '3', '--no-budget', '--json'], io: { stdout: out.stream, stderr: err.stream } })).toBe(0);
      const document = JSON.parse(out.text()) as { status: string; output: { reply: string } };
      expect(document.status).toBe('succeeded'); expect(document.output.reply).toContain('"city":"Paris"'); expect(document.output.reply).toContain('"days":3');
      expect(document.output.reply).toContain('"budget":false');
      const help = capture(); expect(await runAgentCommand({ agent, runtime, name: 'plan', inputJsonSchema: schema, argv: ['--help'], io: { stdout: help.stream } })).toBe(0);
      expect(help.text()).toContain('Usage: plan [options]'); expect(help.text()).toContain('--city <string> (required)  Where to go.');
      const plain = capture(); expect(await runAgentCommand({ agent, runtime, argv: ['a', 'short', 'trip'], io: { stdout: plain.stream } })).toBe(0);
      expect(plain.text()).toBe('text plan\n');
    } finally { await runtime.close(); }
  });

  it('reads piped input, refuses confirmations with nobody at a terminal, and exits 1 on failure', async () => {
    const refund = confirmBeforeRunning(defineTool({ id: 'orders.refund', version: '1', description: 'Refund.', input: any, output: any, effects: 'write', capabilities: [],
      execute: () => { throw new Error('must not run'); } }));
    const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help.', input: any, output: any, tools: [refund],
      model: scripted([request => { expect(JSON.stringify(request.messages[0])).toContain('from a pipe'); return call('orders.refund', {}); }]) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:orders.refund', 'effect:write'] } });
    try {
      const stdin = Object.assign(new PassThrough(), { isTTY: false }); stdin.end('from a pipe\n');
      const out = capture(); const refused = capture();
      expect(await runAgentCommand({ agent, runtime, argv: [], io: { stdin, stdout: out.stream, stderr: refused.stream } })).toBe(1);
      expect(refused.text()).toContain('orders.refund needs a person to confirm it, and nobody is available.');
      const err = capture();
      expect(await runAgentCommand({ agent, runtime, inputJsonSchema: schema, argv: ['--unknown', 'x'], io: { stderr: err.stream } })).toBe(1);
      expect(err.text()).toContain('Unknown option --unknown');
    } finally { await runtime.close(); }
  });

  it('take flags from the agent\'s own input schema when none is given', async () => {
    const requests: ModelRequest[] = [];
    const agent = defineAgent({ id: 'planner', version: '1', instructions: 'Plan.', input: z.object({ city: z.string().describe('Where to go.'), days: z.number().int() }),
      output: z.object({ reply: z.string() }), tools: [], model: scripted([() => final({ reply: 'planned' })], requests) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
    try {
      const out = capture();
      expect(await runAgentCommand({ agent, runtime, argv: ['--city', 'Paris', '--days', '3'], io: { stdout: out.stream } })).toBe(0);
      expect(requests[0]!.messages[0]).toEqual({ role: 'user', content: { city: 'Paris', days: 3 } });
      const help = capture(); await runAgentCommand({ agent, runtime, name: 'plan', argv: ['--help'], io: { stdout: help.stream } });
      expect(help.text()).toContain('--city <string> (required)  Where to go.');
    } finally { await runtime.close(); }
  });

  it('parses and explains its input', async () => {
    expect((await parseAgentCommand(['--input', '{"a":1}'])).input).toEqual({ a: 1 });
    await expect(parseAgentCommand(['--days', 'x'], { properties: { days: { type: 'integer' } } })).rejects.toThrow(/must be a integer/u);
    await expect(parseAgentCommand([], undefined, Object.assign(new PassThrough(), { isTTY: true }))).rejects.toThrow(/No input/u);
    expect(agentCommandHelp('echo')).toContain('Usage: echo <text>');
    expect(outputText({ answer: 'yes' })).toBe('yes'); expect(outputText({ count: 2 })).toBe('{\n  "count": 2\n}');
  });
});
