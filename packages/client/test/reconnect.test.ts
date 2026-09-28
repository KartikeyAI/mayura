import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, ClientError, type ClientEvent, type ClientOptions, type EventReconnect } from '../src/index.js';
import { createHeadlessRunStore, type HeadlessRunState } from '../src/headless.js';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '../../server/src/index.js';
import { defineAgent } from '../../runtime/dist/index.js';
import type { ModelAdapter, ModelResponse, Schema } from '../../core/src/index.js';

const origin = 'https://mayura.test';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const numberSchema: Schema<number> = { '~standard': { version: 1, vendor: 'fixture', validate: value => typeof value === 'number' ? { value } : { issues: [{ message: 'number required' }] } } };
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.useRealTimers(); });

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
function event(sequence: number, type: ClientEvent['type'] = 'step.started', metadata: Record<string, string | number | boolean> = {}): ClientEvent {
  return { runId: id, sequence, type, timestamp: '2026-09-28T00:00:00.000Z', metadata };
}
const frame = (value: ClientEvent) => `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const sse = (body: string | ReadableStream<Uint8Array>) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function scripted(responses: (() => Response | Promise<Response>)[], options: Partial<ClientOptions> = {}) {
  const transport = vi.fn<typeof fetch>(async () => { const next = responses.shift(); if (!next) throw new Error('no more responses'); return next(); });
  return { client: createClient({ baseUrl: origin, token: () => 'test-token', fetch: transport, reconnectDelayMs: 1, ...options }), transport };
}
const afterOf = (transport: ReturnType<typeof scripted>['transport'], call: number) => new URL(String(transport.mock.calls[call]?.[0])).searchParams.get('after');

/** A real server whose streams end every `streamDurationMs`, with a model that works for `workMs`. */
function cutting(limits: AgentServerOptions['limits'], workMs: number, clientOptions: Partial<ClientOptions> = {}) {
  const generate = vi.fn<ModelAdapter['generate']>(async request => {
    // Several model steps, each a burst of events, spread over time so streams are cut between them.
    await new Promise(resolve => setTimeout(resolve, workMs));
    if (request.signal.aborted) throw new Error('aborted');
    return { type: 'final', output: 4, usage: { costMicros: 0 } } satisfies ModelResponse;
  });
  const agent = defineAgent({ id: 'fixture.agent', version: '1', instructions: 'Fixture.', input: numberSchema, output: numberSchema, tools: [],
    model: { id: 'fixture.model', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate } });
  const server = createAgentServer({ publicOrigin: origin, agents: [{ agent, permissions: { allow: ['model:fixture.model'] } }], ...(limits ? { limits } : {}),
    authenticate: async () => ({ scope: { principalId: 'developer', projectId: 'project' }, agentIds: [agent.id], capabilities: ['runs:read', 'runs:submit'], expiresAtMs: Date.now() + 60_000 }) });
  servers.push(server);
  const transport = vi.fn<typeof fetch>(async (input, init) => server.fetch(new Request(input, init)));
  return { client: createClient({ baseUrl: origin, token: () => 'test-token', fetch: transport, reconnectDelayMs: 1, ...clientOptions }), transport, generate };
}

describe('event streams that outlive one connection', () => {
  it('follows a run across server stream cuts until run.completed, without duplicates or holes', async () => {
    // Quiet stretches cut many streams; those ends are routine and do not count against maxReconnectAttempts.
    const { client, transport } = cutting({ streamDurationMs: 40 }, 250, { maxReconnectAttempts: 1 });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'cut' });
    const reconnects: EventReconnect[] = [];
    const events = await collect(run.events({ onReconnect: value => { reconnects.push(value); } }));
    expect(events.map(item => item.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)?.type).toBe('run.completed');
    const streams = transport.mock.calls.filter(([url]) => String(url).includes('/events'));
    expect(streams.length).toBeGreaterThan(2);
    // Every reconnect resumes after the last sequence it delivered.
    expect(reconnects.every(item => item.code === null || item.code === 'TIMEOUT')).toBe(true);
    for (const [index, reconnect] of reconnects.entries()) expect(new URL(String(streams[index + 1]?.[0])).searchParams.get('after')).toBe(String(reconnect.after));
    expect(await run.result(numberSchema)).toMatchObject({ status: 'succeeded', output: 4 });
  });

  it('is not bounded by requestTimeoutMs: quiet runs stay open on the server keep-alive', async () => {
    const { client, transport } = cutting({ streamDurationMs: 60_000, streamHeartbeatMs: 20 }, 400, { requestTimeoutMs: 100, eventIdleTimeoutMs: 150 });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'quiet' });
    const events = await collect(run.events());
    expect(events.at(-1)?.type).toBe('run.completed');
    // One connection carried the whole run although it lasted four times requestTimeoutMs.
    expect(transport.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(1);
  });

  it('reconnects a silent stream after eventIdleTimeoutMs, and a failed connection with backoff', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(frame(event(1)))); } });
    const { client, transport } = scripted([
      () => sse(stalled),
      () => { throw new Error('PRIVATE network failure'); },
      () => jsonResponse({ error: { code: 'SERVER_CLOSED', message: 'The server is shutting down. Retry against another replica.', retryAfterMs: 5 } }, 503),
      () => sse(frame(event(2)) + frame(event(3, 'run.completed', { status: 'succeeded' }))),
    ], { eventIdleTimeoutMs: 30 });
    const reconnects: EventReconnect[] = [];
    const events = await collect(client.run(id).events({ onReconnect: value => { reconnects.push(value); throw new Error('ignored'); } }));
    expect(events.map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(reconnects.map(item => [item.attempt, item.after, item.code])).toEqual([[1, 1, 'TIMEOUT'], [2, 1, 'TRANSPORT_FAILED'], [3, 1, 'SERVER_CLOSED']]);
    expect(reconnects[2]!.delayMs).toBeGreaterThanOrEqual(5);
    expect([1, 2, 3].map(call => afterOf(transport, call))).toEqual(['1', '1', '1']);
  });

  it('surfaces a gap the server reports after a reconnect, then continues', async () => {
    const { client } = scripted([
      () => sse(frame(event(1)) + frame(event(2))),
      () => sse(frame(event(9, 'events.gap', { from: 3, to: 9 })) + frame(event(10, 'run.completed', { status: 'succeeded' }))),
    ]);
    expect((await collect(client.run(id).events())).map(item => [item.sequence, item.type])).toEqual([[1, 'step.started'], [2, 'step.started'], [9, 'events.gap'], [10, 'run.completed']]);
  });

  it('stops at once on a final error, and after maxReconnectAttempts on repeated failures', async () => {
    const notFound = scripted([() => sse(frame(event(1))), () => jsonResponse({ error: { code: 'RUN_NOT_FOUND', message: 'No run with this id is visible to this access token.' } }, 404)]);
    const error = await collect(notFound.client.run(id).events()).catch(value => value as ClientError);
    expect(error).toMatchObject({ code: 'RUN_NOT_FOUND', status: 404 }); expect(notFound.transport).toHaveBeenCalledTimes(2);
    const broken = scripted(Array.from({ length: 10 }, () => () => { throw new Error('down'); }), { maxReconnectAttempts: 2 });
    await expect(collect(broken.client.run(id).events())).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' }); expect(broken.transport).toHaveBeenCalledTimes(3);
    const protocol = scripted([() => sse(frame(event(2)))]);
    await expect(collect(protocol.client.run(id).events())).rejects.toMatchObject({ code: 'INVALID_STREAM' }); expect(protocol.transport).toHaveBeenCalledOnce();
    // A caller's abort is never retried.
    const controller = new AbortController(); controller.abort();
    await expect(collect(scripted([() => sse('')]).client.run(id).events({ signal: controller.signal }))).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('checks the run when a stream ends without progress, and ends when the run already has', async () => {
    const snapshot = { id, status: 'succeeded', budget: { spentMicros: 0, reservedMicros: 0, calls: 1 }, evidence: [], outcome: { status: 'succeeded', output: 4 } };
    const { client, transport } = scripted([() => sse(frame(event(1))), () => sse(': keep-alive\n\n'), () => jsonResponse(snapshot), () => sse('')]);
    expect((await collect(client.run(id).events())).map(item => item.sequence)).toEqual([1]);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('keeps single-connection behaviour with reconnect: false', async () => {
    const { client, transport } = scripted([() => sse(frame(event(1)))]);
    expect((await collect(client.run(id).events({ reconnect: false }))).map(item => item.sequence)).toEqual([1]); expect(transport).toHaveBeenCalledOnce();
    await expect(collect(client.run(id).events({ onReconnect: 'no' as never }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(() => createClient({ baseUrl: origin, token: () => 't', eventIdleTimeoutMs: 0 })).toThrow(ClientError);
    expect(() => createClient({ baseUrl: origin, token: () => 't', maxReconnectAttempts: -1 })).toThrow(ClientError);
  });

  it('shows reconnecting in the headless store and follows the run to its end', async () => {
    const { client } = scripted([
      () => sse(frame(event(1, 'model.started'))),
      () => { throw new Error('down'); },
      () => sse(frame(event(2, 'model.completed')) + frame(event(3, 'run.completed', { status: 'succeeded' }))),
      () => jsonResponse({ id, status: 'succeeded', budget: { spentMicros: 0, reservedMicros: 0, calls: 1 }, evidence: [] }),
    ]);
    const store = createHeadlessRunStore({ run: client.run(id) }); const seen: HeadlessRunState[] = [];
    store.subscribe(() => { seen.push(store.getSnapshot()); });
    const final = await store.observe();
    expect(final).toMatchObject({ connection: 'stopped', lastSequence: 3, errorCode: null, snapshot: { status: 'succeeded' } });
    const reconnecting = seen.find(state => state.connection === 'reconnecting');
    expect(reconnecting).toMatchObject({ errorCode: 'TRANSPORT_FAILED', lastSequence: 1 });
    expect(seen.find(state => state.lastSequence === 2)).toMatchObject({ connection: 'observing', errorCode: null });
  });
});
