// Reference deployment application for `mayura serve` and `mayura worker` on PostgreSQL.
// Configuration comes only from the environment; nothing is discovered implicitly.
import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createAggregateSubmissionJournal } from '@mayura/storage-contracts';
import { listenProductionServer } from '@mayura/server-node';
import { createWorkflowCommandJournal, createWorkflowFleetControl, createWorkflowLeadership, createWorkflowOperatorTransports, createWorkflowWorker,
  lifecycleOperatorTarget } from '@mayura/workflows';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHost, defineWorkflowLifecycle } from '@mayura/workflows/lifecycle';

const required = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; };
const any = { '~standard': { version: 1, vendor: 'deployment', validate: value => ({ value }) } };
const scope = { principalId: 'deployment', projectId: process.env.MAYURA_PROJECT ?? 'default' };
const runtimeOptions = { scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
// One example definition: a durable reminder that waits for an absolute time. Real applications register their own.
const reminder = defineWorkflowLifecycle({ id: 'deployment.reminder', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'due', fireAtMs: { kind: 'input', path: ['dueAtMs'] } }], result: { kind: 'step', stepId: 'due', path: [] } });
// Every version with runs in flight stays registered; the operator API projects each run on its pinned version.
const definitions = [reminder];

const store = createPostgresStore({ connectionString: required('DATABASE_URL') });
let initialized; const ready = () => (initialized ??= store.initialize());
const fleet = createWorkflowFleetControl({ store, scope });

export default {
  async server() {
    await ready();
    // Operator credential: a 64-hex token whose SHA-256 is provided; the token itself is never stored in configuration.
    const expected = Buffer.from(required('MAYURA_API_TOKEN_SHA256'), 'hex');
    const runtime = createWorkflowLifecycleFleetRuntime({ store, ...runtimeOptions });
    // Production operator adapters: journaled commands (a retried command id never applies twice, across replicas and
    // restarts), revision checks, multi-version views, paged index and fleet sweeps, all confined to this scope.
    const operator = createWorkflowOperatorTransports({ store, scope, journal: createWorkflowCommandJournal({ store, scope }), fleet,
      targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions })] });
    return listenProductionServer({
      agents: [], publicOrigin: required('MAYURA_PUBLIC_ORIGIN'), hostname: process.env.MAYURA_BIND ?? '0.0.0.0', port: Number(process.env.PORT ?? 8080),
      tls: { terminatedBy: 'proxy' }, submissionJournal: createAggregateSubmissionJournal(store),
      readiness: async () => { await store.read('readiness', 'probe'); return true; },
      authenticate: async ({ token }) => {
        const digest = createHash('sha256').update(token).digest();
        if (!/^[a-f0-9]{64}$/.test(token) || digest.length !== expected.length || !timingSafeEqual(digest, expected)) return null;
        return { scope, agentIds: [], capabilities: ['workflows:read', 'workflows:control', 'workflows:fleet'], expiresAtMs: Date.now() + 60_000 };
      },
      workflowIndex: operator.workflowIndex, workflowViews: operator.workflowViews, workflowControls: operator.workflowControls,
      workflowPauses: operator.workflowPauses, workflowResumes: operator.workflowResumes, workflowFleet: operator.workflowFleet,
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
  // Storage schema version 1 is the v1 baseline; later releases ship explicit, one-way, versioned migrations here.
  async migrate() { await ready(); return { schemaVersion: 1 }; },
  async shutdown() { await store.close(); },
};
