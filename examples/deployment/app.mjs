// Reference deployment application for `mayura serve` and `mayura worker` on PostgreSQL.
// Configuration comes only from the environment; nothing is discovered implicitly.
import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { MayuraError } from '@mayura/core';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createAggregateSubmissionJournal } from '@mayura/storage-contracts';
import { listenProductionServer } from '@mayura/server-node';
import { createWorkflowFleetControl, createWorkflowLeadership, createWorkflowWorker, lifecycleFleetTarget } from '@mayura/workflows';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHost, defineWorkflowLifecycle } from '@mayura/workflows/lifecycle';

const required = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; };
const any = { '~standard': { version: 1, vendor: 'deployment', validate: value => ({ value }) } };
const scope = { principalId: 'deployment', projectId: process.env.MAYURA_PROJECT ?? 'default' };
const runtimeOptions = { scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
// One example definition: a durable reminder that waits for an absolute time. Real applications register their own.
const reminder = defineWorkflowLifecycle({ id: 'deployment.reminder', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'due', fireAtMs: { kind: 'input', path: ['dueAtMs'] } }], result: { kind: 'step', stepId: 'due', path: [] } });
const definitions = new Map([[reminder.digest, reminder]]);

const store = createPostgresStore({ connectionString: required('DATABASE_URL') });
let initialized; const ready = () => (initialized ??= store.initialize());
const fleet = createWorkflowFleetControl({ store, scope });

const view = snapshot => {
  const definition = [...definitions.values()][0];
  return { format: 5, definitionId: definition.id, definitionVersion: definition.version, runId: snapshot.id, revision: snapshot.version, status: snapshot.status,
    nodes: definition.nodes.map(node => ({ id: node.id, kind: node.kind, dependsOn: [...(node.dependsOn ?? [])] })),
    steps: definition.nodes.map(node => ({ id: node.id, kind: node.kind, status: snapshot.steps[node.id].status })) };
};

export default {
  async server() {
    await ready();
    // Operator credential: a 64-hex token whose SHA-256 is provided; the token itself is never stored in configuration.
    const expected = Buffer.from(required('MAYURA_API_TOKEN_SHA256'), 'hex');
    const runtime = createWorkflowLifecycleFleetRuntime({ store, ...runtimeOptions });
    const command = operate => async input => {
      try { const current = await runtime.inspect(input.runId); if (current.version !== input.revision) return { status: 'conflict' };
        return { status: 'applied', workflow: view(await operate(input.runId, current)) }; }
      catch (error) { if (error instanceof MayuraError && error.code === 'NOT_FOUND') return { status: 'not_found' };
        if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'conflict' }; throw error; }
    };
    return listenProductionServer({
      agents: [], publicOrigin: required('MAYURA_PUBLIC_ORIGIN'), hostname: process.env.MAYURA_BIND ?? '0.0.0.0', port: Number(process.env.PORT ?? 8080),
      tls: { terminatedBy: 'proxy' }, submissionJournal: createAggregateSubmissionJournal(store),
      readiness: async () => { await store.read('readiness', 'probe'); return true; },
      authenticate: async ({ token }) => {
        const digest = createHash('sha256').update(token).digest();
        if (!/^[a-f0-9]{64}$/.test(token) || digest.length !== expected.length || !timingSafeEqual(digest, expected)) return null;
        return { scope, agentIds: [], capabilities: ['workflows:read', 'workflows:control', 'workflows:fleet'], expiresAtMs: Date.now() + 60_000 };
      },
      workflowIndex: { list: async ({ limit }) => {
        const items = []; let cursor = null;
        do { const page = await runtime.scan({ cursor, maxShardReads: 64 });
          for (const candidate of page.candidates) if (items.length < limit) items.push({ format: 5, definitionId: reminder.id, definitionVersion: reminder.version,
            runId: candidate.runId, revision: candidate.version, status: candidate.status });
          cursor = page.nextCursor; } while (cursor && items.length < limit);
        return { items, next: null };
      } },
      workflowViews: { inspect: async ({ runId }) => { try { return view(await runtime.inspect(runId)); } catch { return null; } } },
      workflowPauses: { pause: command(id => runtime.pause(id)) },
      workflowResumes: { resume: command((id, current) => current.status === 'paused' ? runtime.resume(id) : current) },
      workflowFleet: { inspect: () => fleet.inspect(), hold: () => fleet.hold(), release: () => fleet.release(),
        sweep: async ({ phase, cursor, limit }) => {
          const targets = [lifecycleFleetTarget(runtime)];
          try { return { status: 'applied', sweep: phase === 'pause' ? await fleet.sweepPause(targets, { cursor, limit }) : await fleet.sweepResume(targets, { cursor, limit }) }; }
          catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'conflict' }; throw error; }
        } },
    });
  },
  async worker() {
    await ready();
    const host = createWorkflowLifecycleHost({ store, ...runtimeOptions, definitions: [reminder], hold: fleet });
    // Optionally seed one demonstration run. Every replica must submit an identical request under the shared key,
    // so the due time comes from configuration rather than each replica's clock.
    if (process.env.MAYURA_SEED_DUE_AT_MS) await host.runtime.submit(reminder, { input: { dueAtMs: Number(process.env.MAYURA_SEED_DUE_AT_MS) }, idempotencyKey: 'seed-reminder' });
    return createWorkflowWorker({ units: [host], leadership: createWorkflowLeadership({ store, scope, role: 'lifecycle-host', holderId: process.env.MAYURA_WORKER_ID ?? hostname() }) });
  },
  async shutdown() { await store.close(); },
};
