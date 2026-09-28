import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, ModelAdapter, ModelResponse, Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer, type AgentServerOptions, type RunRecordStore, type ServerIdentity } from '../src/index.js';
import { createAggregateRunRecords, createSqliteStore } from '../../storage/dist/index.js';

const publicOrigin = 'https://agents.example.test';
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const identity = (overrides: Partial<ServerIdentity> = {}): ServerIdentity => ({ scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
  capabilities: ['runs:read', 'runs:submit', 'runs:cancel'], expiresAtMs: Date.now() + 60_000, ...overrides });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); vi.restoreAllMocks(); });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function agent(generate: ModelAdapter['generate']) {
  return defineAgent({ id: 'echo', version: '1', instructions: 'PRIVATE_INSTRUCTIONS', tools: [], input: schema, output: schema,
    model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate } });
}
/** A model that waits until released, and records whether its call was cancelled. */
function waiting() {
  const started = deferred<AbortSignal>(); const release = deferred<ModelResponse>();
  const generate = vi.fn<ModelAdapter['generate']>(async request => { started.resolve(request.signal); return release.promise; });
  return { generate, started, release };
}
async function sqlite() {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-run-records-')); const filename = join(directory, 'runs.sqlite');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  // Two store instances on one file stand in for two server processes sharing a database.
  const open = async () => { const store = createSqliteStore({ filename }); await store.initialize(); cleanups.push(() => store.close()); return store; };
  return { open };
}
/** Records whose calls can be made to fail, as when a replica loses its database connection or dies. */
function severable(records: RunRecordStore) {
  let severed = false;
  const wrapped = Object.fromEntries(Object.entries(records).map(([name, call]) => [name, (...values: unknown[]) =>
    severed ? Promise.reject(new Error('PRIVATE connection failure')) : (call as (...inner: unknown[]) => Promise<unknown>)(...values)])) as unknown as RunRecordStore;
  return { records: wrapped, sever: () => { severed = true; }, restore: () => { severed = false; } };
}
function replica(options: Partial<AgentServerOptions> & Pick<AgentServerOptions, 'runRecords'>, generate: ModelAdapter['generate']): AgentServer {
  const server = createAgentServer({ publicOrigin, agents: [{ agent: agent(generate), permissions: { allow: ['model:fixture'] } }], authenticate: async () => identity(),
    ...options, limits: { runLeaseMs: 30_000, runRecordPollMs: 20, ...options.limits } });
  cleanups.push(() => server.close()); return server;
}
const call = (server: AgentServer, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers); headers.set('authorization', 'Bearer TOKEN_PRIVATE');
  return server.fetch(new Request(new URL(path, publicOrigin), { ...init, headers }));
};
const submit = (server: AgentServer, key = 'request-1', input: unknown = 'INPUT') => call(server, '/v1/runs', { method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ agentId: 'echo', input }) });
async function json(response: Response): Promise<JsonObject> { return await response.json() as JsonObject; }
async function frames(response: Response): Promise<{ id: number; type: string; data: JsonObject }[]> {
  const text = await response.text();
  return [...text.matchAll(/^id: (\d+)\nevent: ([a-z.]+)\ndata: (.+)$/gm)].map(match => ({ id: Number(match[1]), type: match[2]!, data: JSON.parse(match[3]!) as JsonObject }));
}

describe('agent runs shared by server replicas through durable run records', () => {
  it('lets any replica read, stream, replay and cancel a run that executes on another', async () => {
    const database = await sqlite(); const model = waiting();
    const a = replica({ runRecords: createAggregateRunRecords(await database.open()) }, model.generate);
    const b = replica({ runRecords: createAggregateRunRecords(await database.open()) }, model.generate);
    const accepted = await submit(a); expect(accepted.status).toBe(202); const { id } = await json(accepted) as { id: string };
    const signal = await model.started.promise;
    // Replica B knows the run from its record, answers the same key with the same run, and refuses another payload.
    await vi.waitFor(async () => expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ id, status: 'running' }), { interval: 20, timeout: 5_000 });
    const replay = await submit(b); expect(replay.status).toBe(200); expect(await json(replay)).toEqual({ id, profile: 'ephemeral' });
    const conflict = await submit(b, 'request-1', 'OTHER'); expect(conflict.status).toBe(409); expect((await json(conflict))['error']).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // B's stream follows the recorded events while the run works; a cancel sent to B reaches the owner A.
    const stream = call(b, `/v1/runs/${id}/events`);
    const cancelled = await call(b, `/v1/runs/${id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(202); expect(await json(cancelled)).toEqual({ id, cancellationRequested: true });
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { interval: 20, timeout: 5_000 });
    const seen = await frames(await stream);
    expect(seen.map(frame => frame.id)).toEqual(seen.map((_, index) => index + 1));
    expect(seen[0]?.type).toBe('run.started'); expect(seen.at(-1)).toMatchObject({ type: 'run.completed', data: { metadata: { status: 'cancelled' } } });
    const onB = await json(await call(b, `/v1/runs/${id}`)); const onA = await json(await call(a, `/v1/runs/${id}`));
    expect(onB).toMatchObject({ id, status: 'cancelled', outcome: { status: 'cancelled', error: { code: 'CANCELLED' } } });
    expect(Object.keys(onB).sort()).toEqual(['budget', 'evidence', 'id', 'outcome', 'status']); expect(Object.keys(onA).sort()).toEqual(Object.keys(onB).sort());
    expect(onB['budget']).toEqual(onA['budget']);
    // Resuming a stream from a later sequence on either replica returns only the rest.
    const rest = await frames(await call(b, `/v1/runs/${id}/events?after=${seen.length - 1}`)); expect(rest.map(frame => frame.type)).toEqual(['run.completed']);
    expect(model.generate).toHaveBeenCalledOnce(); model.release.resolve({ type: 'final', output: 1, usage: { costMicros: 0 } });
  });

  it('records a finished run for every replica and keeps callers apart', async () => {
    const database = await sqlite();
    const done = vi.fn<ModelAdapter['generate']>(async () => ({ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }));
    let caller = identity();
    const a = replica({ runRecords: createAggregateRunRecords(await database.open()) }, done);
    const b = replica({ runRecords: createAggregateRunRecords(await database.open()), authenticate: async () => caller }, done);
    const { id } = await json(await submit(a)) as { id: string };
    await vi.waitFor(async () => expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ status: 'succeeded', outcome: { status: 'succeeded', output: { answer: 42 } } }),
      { interval: 20, timeout: 5_000 });
    expect((await frames(await call(b, `/v1/runs/${id}/events`))).at(-1)?.type).toBe('run.completed');
    // Another principal, or a token without this agent, sees no run at all; a token without runs:cancel may not cancel it.
    caller = identity({ scope: { principalId: 'bob', projectId: 'project' } });
    for (const path of [`/v1/runs/${id}`, `/v1/runs/${id}/events`]) expect((await json(await call(b, path)))['error']).toMatchObject({ code: 'RUN_NOT_FOUND' });
    caller = identity({ agentIds: ['other'] }); expect((await call(b, `/v1/runs/${id}`)).status).toBe(404);
    caller = identity({ capabilities: ['runs:read'] });
    expect((await json(await call(b, `/v1/runs/${id}/cancel`, { method: 'POST' })))['error']).toMatchObject({ code: 'CAPABILITY_REQUIRED', capability: 'runs:cancel' });
    expect(done).toHaveBeenCalledOnce();
  });

  it('settles a run as outcome_unknown when its replica stops renewing the lease, and the old owner then stops it', async () => {
    const database = await sqlite(); const model = waiting(); const owner = severable(createAggregateRunRecords(await database.open()));
    const limits = { runLeaseMs: 300, runRecordPollMs: 20 };
    const a = replica({ runRecords: owner.records, limits }, model.generate);
    const b = replica({ runRecords: createAggregateRunRecords(await database.open()), limits }, model.generate);
    const { id } = await json(await submit(a)) as { id: string }; const signal = await model.started.promise;
    await vi.waitFor(async () => expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ status: 'running' }), { interval: 20, timeout: 5_000 });
    // Replica A loses its database (as if it died); after the lease and the clock allowance, a reader settles the run.
    owner.sever();
    await vi.waitFor(async () => expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ status: 'outcome_unknown',
      outcome: { status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } } }), { interval: 50, timeout: 5_000 });
    const seen = await frames(await call(b, `/v1/runs/${id}/events`));
    expect(seen.at(-1)).toMatchObject({ type: 'run.completed', data: { metadata: { status: 'outcome_unknown' } } });
    expect(seen.map(frame => frame.id)).toEqual(seen.map((_, index) => index + 1));
    // When A reaches the database again it learns it lost the run, stops it, and answers from the record like B.
    owner.restore();
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { interval: 20, timeout: 5_000 });
    await vi.waitFor(async () => expect(await json(await call(a, `/v1/runs/${id}`))).toMatchObject({ status: 'outcome_unknown' }), { interval: 20, timeout: 5_000 });
    // The same key is never run twice.
    expect(await json(await submit(b))).toEqual({ id, profile: 'ephemeral' });
    model.release.resolve({ type: 'final', output: 1, usage: { costMicros: 0 } });
  });

  it('answers a key another replica is still starting with SUBMISSION_IN_PROGRESS, and a lost start with SUBMISSION_OUTCOME_UNKNOWN', async () => {
    const database = await sqlite(); const records = createAggregateRunRecords(await database.open()); const generate = vi.fn(waiting().generate);
    const server = replica({ runRecords: records, limits: { runLeaseMs: 1_000 } }, generate);
    const owner = JSON.stringify({ principalId: 'alice', projectId: 'project' });
    const digest = async (input: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
      `{"agentId":"echo","input":${JSON.stringify(input)},"version":"1"}`)))].map(value => value.toString(16).padStart(2, '0')).join('');
    await records.claim({ owner, key: 'starting', digest: await digest('INPUT'), replicaId: 'elsewhere', nowMs: Date.now() });
    const busy = await submit(server, 'starting'); expect(busy.status).toBe(409); expect(busy.headers.get('retry-after')).toBe('1');
    expect((await json(busy))['error']).toMatchObject({ code: 'SUBMISSION_IN_PROGRESS', retryAfterMs: 1_000 });
    await records.claim({ owner, key: 'lost', digest: await digest('INPUT'), replicaId: 'elsewhere', nowMs: Date.now() - 60_000 });
    expect((await json(await submit(server, 'lost')))['error']).toMatchObject({ code: 'SUBMISSION_OUTCOME_UNKNOWN' });
    expect((await json(await submit(server, 'lost', 'OTHER')))['error']).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('starts no work it cannot record, and gives back a claim whose run never started', async () => {
    const database = await sqlite(); const records = createAggregateRunRecords(await database.open());
    const model = waiting(); const failing = { ...records, start: vi.fn(async () => { throw new Error('PRIVATE disk full'); }) } as RunRecordStore;
    const server = replica({ runRecords: failing }, model.generate);
    const refused = await submit(server, 'unrecorded'); expect(refused.status).toBe(503);
    const body = await json(refused); expect(body['error']).toMatchObject({ code: 'RUN_RECORDS_UNAVAILABLE', retryAfterMs: 2_000 }); expect(JSON.stringify(body)).not.toContain('PRIVATE');
    // The run was stopped at once; the key stays claimed because the run did start.
    const started = await Promise.race([model.started.promise, new Promise<null>(resolve => setTimeout(resolve, 100, null))]);
    if (started) await vi.waitFor(() => expect(started.aborted).toBe(true), { interval: 10, timeout: 2_000 });
    const unavailable = replica({ runRecords: { ...records, claim: async () => { throw new Error('PRIVATE'); } } as RunRecordStore }, model.generate);
    expect((await json(await submit(unavailable, 'never')))['error']).toMatchObject({ code: 'RUN_RECORDS_UNAVAILABLE' });
    // A claim followed by a refusal before any run starts is released, so the key can be used again.
    const full = replica({ runRecords: records, submissionJournal: { claim: async () => { throw new Error('PRIVATE'); } } }, model.generate);
    expect((await json(await submit(full, 'released')))['error']).toMatchObject({ code: 'SUBMISSION_JOURNAL_UNAVAILABLE' });
    await vi.waitFor(async () => expect(await records.claim({ owner: JSON.stringify({ principalId: 'alice', projectId: 'project' }), key: 'released',
      digest: 'f'.repeat(64), replicaId: 'next', nowMs: 1 })).toEqual({ status: 'claimed' }), { interval: 20, timeout: 2_000 });
    // Hostile records are refused without echoing them.
    const hostile = replica({ runRecords: { ...records, read: async () => ({ runId: 'x', secret: 'PRIVATE' }) } as unknown as RunRecordStore }, model.generate);
    const answer = await call(hostile, '/v1/runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); expect(answer.status).toBe(503);
    expect(JSON.stringify(await json(answer))).not.toContain('PRIVATE');
    model.release.resolve({ type: 'final', output: 1, usage: { costMicros: 0 } });
    expect(() => createAgentServer({ publicOrigin, agents: [], authenticate: async () => null, runRecords: { claim: async () => ({ status: 'claimed' }) } as never })).toThrow();
  });

  it('records the outcome of runs a closing replica stops, so the others can still answer', async () => {
    const database = await sqlite(); const model = waiting();
    const a = replica({ runRecords: createAggregateRunRecords(await database.open()) }, model.generate);
    const b = replica({ runRecords: createAggregateRunRecords(await database.open()) }, model.generate);
    const { id } = await json(await submit(a)) as { id: string }; await model.started.promise;
    await a.close();
    expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ status: 'cancelled', outcome: { status: 'cancelled' } });
    model.release.resolve({ type: 'final', output: 1, usage: { costMicros: 0 } });
  });
});

