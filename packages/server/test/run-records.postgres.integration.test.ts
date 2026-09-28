import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, ModelAdapter, ModelResponse, Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer } from '../src/index.js';
import { createAggregateRunRecords, createPostgresStore } from '../../storage/dist/index.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const publicOrigin = 'https://agents.example.test';
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

describe.skipIf(!connectionString)('PostgreSQL run records', () => {
  it('shares runs between two server replicas on one PostgreSQL schema', async () => {
    const name = `mayura_test_${randomUUID().replaceAll('-', '')}`;
    cleanups.push(async () => {
      // Only this test's generated, validated schema is ever removed.
      if (!/^mayura_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unexpected fixture schema.');
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); } finally { await pool.end(); }
    });
    let begin!: (signal: AbortSignal) => void; let finish!: (response: ModelResponse) => void;
    const started = new Promise<AbortSignal>(resolve => { begin = resolve; }); const released = new Promise<ModelResponse>(resolve => { finish = resolve; });
    const generate = vi.fn<ModelAdapter['generate']>(async request => { begin(request.signal); return released; });
    const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
      model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate } });
    const replica = async (): Promise<AgentServer> => {
      const store = createPostgresStore({ connectionString: connectionString!, schema: name }); await store.initialize(); cleanups.push(() => store.close());
      const server = createAgentServer({ publicOrigin, agents: [{ agent, permissions: { allow: ['model:fixture'] } }], runRecords: createAggregateRunRecords(store),
        limits: { runRecordPollMs: 20 }, authenticate: async () => ({ scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
          capabilities: ['runs:read', 'runs:submit', 'runs:cancel'], expiresAtMs: Date.now() + 60_000 }) });
      cleanups.push(() => server.close()); return server;
    };
    const a = await replica(); const b = await replica();
    const call = (server: AgentServer, path: string, init: RequestInit = {}) =>
      server.fetch(new Request(new URL(path, publicOrigin), { ...init, headers: { authorization: 'Bearer TOKEN', ...init.headers as Record<string, string> } }));
    const json = async (response: Response) => await response.json() as JsonObject;
    const accepted = await call(a, '/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'pg-1' },
      body: JSON.stringify({ agentId: 'echo', input: 1 }) });
    expect(accepted.status).toBe(202); const { id } = await json(accepted) as { id: string }; const signal = await started;
    await vi.waitFor(async () => expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ status: 'running' }), { interval: 20, timeout: 10_000 });
    expect((await call(b, `/v1/runs/${id}/cancel`, { method: 'POST' })).status).toBe(202);
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { interval: 20, timeout: 10_000 });
    await vi.waitFor(async () => expect(await json(await call(b, `/v1/runs/${id}`))).toMatchObject({ status: 'cancelled', outcome: { status: 'cancelled' } }),
      { interval: 20, timeout: 10_000 });
    const text = await (await call(b, `/v1/runs/${id}/events`)).text(); expect(text).toContain('event: run.completed');
    finish({ type: 'final', output: 1, usage: { costMicros: 0 } });
  });
});
