// The checks scripts/runtime-check.mjs runs on every JavaScript runtime. Offline: a scripted model and an in-memory
// store. Each check returns a deterministic detail, and the runner compares it with Node's, so a digest, cursor or
// encoding that differs between runtimes fails as surely as an exception.
import { createRuntime, defineAgent, defineTool, z } from 'mayura';
import { sha256Hex } from 'mayura/core/host';
import { createMemoryStore, hashingEmbedder } from 'mayura/memory';
import { createAgentServer } from 'mayura/server';
import { createPostgresStore } from 'mayura/storage-postgres/driver';
import { scriptedModel } from 'mayura/testing';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';

const scope = { principalId: 'principal', projectId: 'project' };

export async function probe() {
  const results = {};
  const check = async (name, run) => {
    try { results[name] = { ok: true, detail: await run() }; }
    catch (error) { results[name] = { ok: false, error: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 400)}`, stack: String(error?.stack ?? '').split('\n').slice(1, 5).map(line => line.trim()) }; }
  };

  await check('hashing', () => [sha256Hex(''), sha256Hex('Grüße, 世界 🌏'), sha256Hex(new Uint8Array([0, 1, 254, 255]))]);

  await check('agent run with a tool', async () => {
    const add = defineTool({ id: 'math.add', version: '1', description: 'Add.', input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }), effects: 'none', capabilities: [], execute: ({ a, b }) => ({ sum: a + b }) });
    const agent = defineAgent({ id: 'calc', version: '1', instructions: 'Add.', input: z.object({ q: z.string() }), output: z.object({ answer: z.number() }), tools: [add],
      model: scriptedModel([{ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'math.add', input: { a: 2, b: 40 } }], usage: { costMicros: 0 } },
        { type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]) });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
    try {
      const result = await runtime.submit(agent, { input: { q: '2+40' } }).result();
      if (result.status !== 'succeeded') throw new Error(`run ${result.status}`);
      return result.output;
    } finally { await runtime.close(); }
  });

  await check('server fetch handler', async () => {
    const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Echo.', input: z.object({ q: z.string() }), output: z.object({ answer: z.number() }), tools: [],
      model: scriptedModel([{ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]) });
    const api = createAgentServer({ publicOrigin: 'https://edge.example.test', mounted: true, agents: [{ agent, permissions: { allow: ['model:scripted'] } }],
      authenticate: async () => ({ scope, agentIds: ['echo'], capabilities: ['runs:submit', 'runs:read'], expiresAtMs: Date.now() + 60_000 }) });
    const headers = { authorization: 'Bearer probe', 'content-type': 'application/json' };
    try {
      const submitted = await api.fetch(new Request('https://edge.example.test/v1/runs', { method: 'POST', headers: { ...headers, 'idempotency-key': 'probe-1' }, body: JSON.stringify({ agentId: 'echo', input: { q: 'x' } }) }));
      if (submitted.status !== 202) throw new Error(`submit answered ${submitted.status}`);
      const { id } = await submitted.json();
      for (let attempt = 0; attempt < 100; attempt++) {
        const read = await (await api.fetch(new Request(`https://edge.example.test/v1/runs/${id}`, { headers }))).json();
        if (read.status === 'succeeded') return read.outcome.output;
        await new Promise(done => setTimeout(done, 20));
      }
      throw new Error('the run did not finish');
    } finally { await api.close(); }
  });

  await check('durable workflow with a tool step', async () => {
    const charge = defineTool({ id: 'orders.charge', version: '1', description: 'Charge.', input: z.object({ order: z.number() }), output: z.object({ charged: z.number() }),
      effects: 'write', capabilities: [], costMicros: 1, execute: ({ order }) => ({ charged: order }) });
    const flow = defineWorkflowLifecycle({ id: 'orders.flow', version: '1', input: z.object({ order: z.number() }), output: z.object({ charged: z.number() }),
      nodes: [{ kind: 'tool', id: 'charge', tool: charge, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'charge', path: [] } });
    const store = memoryStore();
    const runtime = createWorkflowLifecycleRuntime({ store, scope, permissions: { allow: ['tool:orders.charge', 'effect:write'] }, policyVersion: '1', maxCostMicros: 10 });
    try {
      const run = await runtime.submit(flow, { input: { order: 7 }, idempotencyKey: 'order-7' });
      const settled = await runtime.runUntilSettled(flow, run.id);
      if (settled.status !== 'succeeded') throw new Error(`workflow ${settled.status}`);
      return { output: settled.output, definitionHash: (await store.read(store.scopes()[0], run.id)).definitionHash };
    } finally { runtime.close(); }
  });

  await check('memory pages and embeddings', async () => {
    const memory = createMemoryStore({ store: memoryStore(), scope, permissions: { allow: ['memory:read', 'memory:write'] } });
    for (const id of ['a', 'b', 'c']) {
      await memory.add({ id, content: `Record ${id}: the project uses TypeScript.`, metadata: {},
        provenance: { sourceId: 'probe', reference: 'local:probe', revision: '1', sha256: 'a'.repeat(64), author: 'human:probe', observedAt: '2026-01-01T00:00:00.000Z', origin: 'observed', confidence: 1 } });
    }
    const first = await memory.list({ limit: 1 });
    const second = await memory.list({ limit: 1, cursor: first.nextCursor });
    const [vector] = await hashingEmbedder({ dimensions: 16 }).embed(['durable agents on the edge'], new AbortController().signal);
    return { cursor: first.nextCursor, pages: [first.records.map(record => record.id), second.records.map(record => record.id)], vector: vector.map(value => Math.round(value * 1e6)) };
  });

  await check('PostgreSQL store on a driver pool', async () => {
    const failing = { connect: async () => { throw new Error('no database in this probe'); }, query: async () => ({ rows: [] }) };
    const store = createPostgresStore({ driver: failing, schema: 'probe' });
    const error = await store.initialize().then(() => undefined, caught => caught);
    await store.close();
    return error?.code;
  });

  return results;
}

/** The smallest AggregateStore: records with versions and events, in memory. */
function memoryStore() {
  const records = new Map(); const events = new Map(); const key = (scope, id) => `${scope}\u0000${id}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  const conflict = () => Object.assign(new Error('conflict'), { name: 'StorageError', code: 'CONFLICT' });
  return {
    scopes: () => [...new Set([...records.values()].map(record => record.scope))],
    async initialize() {}, async close() {},
    async create(command) {
      const existing = [...records.values()].find(record => record.scope === command.scope && record.idempotencyKey === command.idempotencyKey);
      if (existing) return { record: clone(existing), created: false };
      const record = { scope: command.scope, id: command.id, idempotencyKey: command.idempotencyKey, definitionHash: command.definitionHash, version: 1, state: clone(command.state) };
      records.set(key(command.scope, command.id), record);
      events.set(key(command.scope, command.id), command.events.map((event, index) => ({ ...clone(event), sequence: index + 1, createdAt: '2026-01-01T00:00:00.000Z' })));
      return { record: clone(record), created: true };
    },
    async read(scope, id) { const record = records.get(key(scope, id)); return record ? clone(record) : undefined; },
    async update(command) {
      const record = records.get(key(command.scope, command.id));
      if (!record || record.version !== command.expectedVersion) throw conflict();
      record.version += 1; record.state = clone(command.state);
      const list = events.get(key(command.scope, command.id));
      for (const event of command.events) list.push({ ...clone(event), sequence: list.length + 1, createdAt: '2026-01-01T00:00:00.000Z' });
      return clone(record);
    },
    async events(scope, id, after = 0) { return clone((events.get(key(scope, id)) ?? []).filter(event => event.sequence > after)); },
  };
}
