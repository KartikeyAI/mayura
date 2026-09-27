// Local operator console demo: serves the console on loopback next to a real SQLite lifecycle fleet with fleet
// control and a reviewed v1 -> v2 migration, and keeps serving until Ctrl+C. Open the printed URL and paste the
// printed one-time token.
//   node examples/inspector.mjs [--port 4318] [--seconds 600]
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MayuraError } from '@mayura/core';
import { defineAgent } from '@mayura/sdk';
import { createSqliteStore } from '@mayura/storage';
import { scriptedModel } from '@mayura/testing';
import { defineTool } from '@mayura/tools';
import { listenAgentServer } from '@mayura/server-node';
import { createClient } from '@mayura/client';
import { createWorkflowFleetControl, createWorkflowMigrationCatalog, createWorkflowMigrationService, lifecycleFleetTarget, pinnedDefinitionHash } from '@mayura/workflows';
import { createWorkflowLifecycleHost, defineWorkflowLifecycle, defineWorkflowMigration } from '@mayura/workflows/lifecycle';

const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : Number(process.argv[index + 1]); };
const any = { '~standard': { version: 1, vendor: 'example', validate: value => ({ value }) } };
const scope = { principalId: 'demo-user', projectId: 'inspector-demo' };
const agent = defineAgent({ id: 'inspector.demo', version: '1', instructions: 'Demonstrate the inspector.', input: any, output: any, tools: [],
  model: scriptedModel([{ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]) });

// v1 drafts a release note and waits for its publish time. v2 also announces it once published.
const tool = id => defineTool({ id: `demo/${id}`, version: '1', description: id, input: any, output: any, effects: 'none', capabilities: [], costMicros: 0,
  execute: input => ({ [id]: input.title }) });
const draft = tool('draft'); const announce = tool('announce');
const release = (version, extra) => defineWorkflowLifecycle({ id: 'demo.release', version, input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: [] } },
  { kind: 'timer', id: 'publishAt', dependsOn: ['draft'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
  ...(extra ? [{ kind: 'tool', id: 'announce', dependsOn: ['publishAt'], tool: announce, input: { kind: 'input', path: [] } }] : []),
], result: { kind: 'step', stepId: 'draft', path: [] } });
const v1 = release('1', false); const v2 = release('2', true);
const definitions = new Map([[v1.digest, v1], [v2.digest, v2]]);

const directory = await mkdtemp(join(tmpdir(), 'mayura-inspector-demo-'));
const store = createSqliteStore({ filename: join(directory, 'demo.sqlite') }); await store.initialize();
const fleet = createWorkflowFleetControl({ store, scope });
const host = createWorkflowLifecycleHost({ store, scope, definitions: [v1, v2], permissions: { allow: ['tool:demo/draft', 'tool:demo/announce'] },
  policyVersion: '1', maxCostMicros: 0, intervalMs: 500, maxBackoffMs: 5_000, hold: fleet });
const runtime = host.runtime; const targets = [lifecycleFleetTarget(runtime)]; const runs = [];
for (const [index, delayMs] of [120_000, 600_000, 3_600_000].entries()) {
  runs.push((await runtime.submit(v1, { input: { title: `Release note ${index + 1}`, publishAt: Date.now() + delayMs }, idempotencyKey: `demo-${index}` })).id);
}
const migrations = createWorkflowMigrationService({
  catalog: createWorkflowMigrationCatalog([defineWorkflowMigration({ id: 'release-1-to-2', from: v1, to: v2, description: 'Announce each release note once it is published.' })]),
  pinned: id => runs.includes(id) ? pinnedDefinitionHash(store, scope, id) : Promise.resolve(undefined),
  inspect: id => runtime.inspect(id), migrate: (migration, command) => runtime.migrate(migration, command) });

const view = async id => {
  const snapshot = await runtime.inspect(id); const definition = definitions.get(await pinnedDefinitionHash(store, scope, id));
  return { format: 5, definitionId: definition.id, definitionVersion: definition.version, runId: id, revision: snapshot.version, status: snapshot.status,
    nodes: definition.nodes.map(node => ({ id: node.id, kind: node.kind, dependsOn: [...(node.dependsOn ?? [])] })),
    steps: definition.nodes.map(node => ({ id: node.id, kind: node.kind, status: snapshot.steps[node.id].status })) };
};
// Demo journal only: a production adapter must journal command IDs durably with the mutation.
const journal = new Map();
const command = async (input, action, operate) => {
  const key = `${action}:${input.commandId}`; if (journal.has(key)) return journal.get(key);
  if (!runs.includes(input.runId)) return { status: 'not_found' };
  const current = await runtime.inspect(input.runId);
  if (current.version !== input.revision) return { status: 'conflict' };
  let result;
  try { await operate(input.runId, current); result = { status: 'applied', workflow: await view(input.runId) }; }
  catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') result = { status: 'conflict' }; else throw error; }
  journal.set(key, result); return result;
};

// Demo only: a fresh loopback credential printed once for the operator. Production must verify real identities.
const secret = randomBytes(32); const token = secret.toString('hex'); const expiresAtMs = Date.now() + option('--seconds', 600) * 1_000;
const server = await listenAgentServer({
  inspector: true, port: option('--port', 0),
  agents: [{ agent, permissions: { allow: ['model:scripted'] } }],
  authenticate: async ({ token: supplied }) => expiresAtMs > Date.now() && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied, 'hex'), secret)
    ? { scope, agentIds: ['inspector.demo'], expiresAtMs,
      capabilities: ['runs:read', 'runs:submit', 'runs:cancel', 'operations:read', 'workflows:read', 'workflows:control', 'workflows:fleet', 'workflows:migrate'] }
    : null,
  workflowIndex: { list: async ({ after, limit }) => {
    const sorted = [...runs].sort(); const ids = sorted.filter(id => after === null || id > after).slice(0, limit);
    const items = await Promise.all(ids.map(async id => { const { nodes, steps, ...item } = await view(id); return item; }));
    return { items, next: ids.length === limit && ids.at(-1) !== sorted.at(-1) ? ids.at(-1) : null };
  } },
  workflowViews: { inspect: async ({ runId }) => runs.includes(runId) ? view(runId) : null },
  workflowControls: { cancel: input => command(input, 'cancel', id => runtime.cancel(id)), approve: async () => ({ status: 'conflict' }) },
  workflowPauses: { pause: input => command(input, 'pause', id => runtime.pause(id)) },
  workflowResumes: { resume: input => command(input, 'resume', (id, current) => current.status === 'paused' ? runtime.resume(id) : current) },
  workflowFleet: {
    inspect: () => fleet.inspect(), hold: () => fleet.hold(), release: () => fleet.release(),
    sweep: async ({ phase, cursor, limit }) => {
      try { return { status: 'applied', sweep: phase === 'pause' ? await fleet.sweepPause(targets, { cursor, limit }) : await fleet.sweepResume(targets, { cursor, limit }) }; }
      catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'conflict' }; throw error; }
    },
  },
  workflowMigrations: {
    list: ({ runId }) => migrations.list(runId), plan: ({ runId, migrationId }) => migrations.plan(runId, migrationId),
    apply: async ({ runId, migrationId, revision, actorId, commandId }) => {
      const key = `migrate:${commandId}`; if (journal.has(key)) return journal.get(key);
      const result = await migrations.apply(runId, migrationId, { revision, actorId, commandId });
      const reply = result.status === 'applied' ? { status: 'applied', plan: result.plan, workflow: await view(runId) } : result;
      if (reply.status === 'applied') journal.set(key, reply); return reply;
    },
  },
  limits: { maxRequests: 64, maxWorkflowOperations: 16, requestTimeoutMs: 10_000 },
});
host.start();
const client = createClient({ baseUrl: server.origin, token: () => token });
const run = await client.submit('inspector.demo', { question: 'demo' }, { idempotencyKey: `demo-${Date.now()}` });
console.log(JSON.stringify({ inspector: `${server.origin}/inspector`, token, runId: run.id, workflowRuns: runs, expiresAt: new Date(expiresAtMs).toISOString() }));
const stop = async () => {
  await host.drain({ timeoutMs: 5_000 }); await server.close(); await store.close(); await rm(directory, { recursive: true, force: true }); process.exit(0);
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
setTimeout(stop, Math.max(0, expiresAtMs - Date.now())).unref?.();
await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAtMs - Date.now())));
