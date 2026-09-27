import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type ClientSchema } from '../src/index.js';
import { createHeadlessRunStore, createRunActivityProjection } from '../src/headless.js';
import { createAgentServer, type AgentServer } from '../../server/src/index.js';
import { defineAgent } from '../../runtime/dist/index.js';
import type { JsonValue, ModelAdapter, ModelStreamEvent, Schema } from '../../core/src/index.js';

const origin = 'https://mayura.test';
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'stream-e2e', validate: value => ({ value: value as JsonValue }) } };
const identity: ClientSchema<unknown> = { '~standard': { version: 1, validate: value => ({ value }) } };
const reply = 'Your parcel left the depot this morning and should arrive tomorrow before noon.';
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function streamingModel(output: JsonValue): ModelAdapter {
  return {
    id: 'streamer', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    async generate() { return { type: 'final', output, usage: { costMicros: 0 } }; },
    async *stream(): AsyncIterable<ModelStreamEvent> {
      const text = JSON.stringify(output);
      for (let index = 0; index < text.length; index += 7) yield { type: 'output.delta', text: text.slice(index, index + 7) };
      yield { type: 'response', response: { type: 'final', output, usage: { costMicros: 0 } } };
    },
  };
}
function setup(output: JsonValue, stream = true) {
  const agent = defineAgent({ id: 'chat', version: '1', instructions: 'x', input: any, output: any, tools: [], model: streamingModel(output),
    ...(stream ? { stream: { field: ['reply'], guards: [], batch: { minChars: 12, maxChars: 32 } } } : {}) });
  const server = createAgentServer({ publicOrigin: origin, agents: [{ agent, permissions: { allow: ['model:streamer'] } }],
    authenticate: async () => ({ scope: { principalId: 'p', projectId: 'x' }, agentIds: ['chat'], capabilities: ['runs:submit', 'runs:read'], expiresAtMs: Date.now() + 60_000 }) });
  servers.push(server);
  return createClient({ baseUrl: origin, token: () => 'token', fetch: async (input, init) => server.fetch(new Request(input, init)) });
}

describe('streamed output end to end', () => {
  it('reaches the browser as ordered deltas that the headless store assembles', async () => {
    const client = setup({ reply, citations: [] });
    const run = await client.submit('chat', 'hi', { idempotencyKey: 'stream-1' });
    const store = createHeadlessRunStore({ run }); const seen: string[] = [];
    store.subscribe(() => { const text = store.getSnapshot().streamedOutput?.text; if (text && text !== seen.at(-1)) seen.push(text); });
    const state = await store.observe();
    expect(state.streamedOutput).toEqual({ modelCall: 1, text: reply, withheld: false, complete: true });
    expect(seen.length).toBeGreaterThan(2); expect(seen.every(text => reply.startsWith(text))).toBe(true);
    expect(await run.result(identity)).toMatchObject({ status: 'succeeded', output: { reply, citations: [] } });
    expect(state.events.filter(event => event.type === 'output.delta').every(event => Object.keys(event.metadata).sort().join() === 'index,modelCall,step,text')).toBe(true);
    // The activity projection (tool chips, model calls) is unaffected by the text events around it.
    expect(createRunActivityProjection(state).items.map(item => item.kind)).toEqual(expect.arrayContaining(['run', 'step', 'model']));
  });

  it('sends no deltas for an agent that does not stream', async () => {
    const client = setup({ reply }, false);
    const run = await client.submit('chat', 'hi', { idempotencyKey: 'stream-2' });
    const state = await createHeadlessRunStore({ run }).observe();
    expect(state.streamedOutput).toBeNull(); expect(state.events.some(event => event.type === 'output.delta')).toBe(false);
  });

  it('refuses streamed events that carry anything beyond their exact fields', async () => {
    const frame = (metadata: Record<string, unknown>) => `id: 1\nevent: output.delta\ndata: ${JSON.stringify({ runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sequence: 1, timestamp: new Date(0).toISOString(), type: 'output.delta', metadata })}\n\n`;
    for (const metadata of [{ step: 0, modelCall: 1, index: 0, text: 'ok', extra: 'x' }, { step: 0, modelCall: 1, index: -1, text: 'ok' }, { step: 0, modelCall: 1, index: 0, text: 5 }]) {
      const client = createClient({ baseUrl: origin, token: () => 'token',
        fetch: async () => new Response(frame(metadata), { headers: { 'Content-Type': 'text/event-stream' } }) });
      const events = client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').events();
      await expect((async () => { for await (const _ of events) { /* consume */ } })()).rejects.toMatchObject({ code: 'INVALID_STREAM' });
    }
  });
});
