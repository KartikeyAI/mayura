import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StorageError } from '@mayura/storage-contracts';

const profile = process.env.MAYURA_STORAGE_PROFILE;
let stage = 'imports';
assert(['sqlite', 'postgres', 'compat'].includes(profile));
const selected = await import(`@mayura/${profile === 'compat' ? 'storage' : `storage-${profile}`}`);
await import('@mayura/storage-sql/host');
for (const specifier of ['@mayura/storage-sql/src/scheduler-database.js', '@mayura/storage-sql/dist/scheduler-database.js',
  `@mayura/${profile === 'compat' ? 'storage' : `storage-${profile}`}/src/index.js`]) {
  await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
for (const specifier of ['pg-native', '@mayura/sdk', '@mayura/runtime', '@mayura/tools', '@mayura/workflows', '@mayura/server-node']) {
  await assert.rejects(import(specifier), { code: 'ERR_MODULE_NOT_FOUND' });
}
if (profile === 'sqlite') {
  for (const name of ['pg', 'pg-cloudflare', '@mayura/storage-postgres', '@mayura/storage']) await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
if (profile === 'postgres') {
  for (const name of ['better-sqlite3', 'node-addon-api', '@mayura/storage-sqlite', '@mayura/storage']) await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
if (profile === 'compat') assert.equal(selected.StorageError, StorageError);

/** Exercise real transactions/capabilities without a model, tool effect or external application data. */
async function exercise(create, reopen) {
  const original = { scope: 'packed.aggregate', id: 'document', idempotencyKey: 'document', definitionHash: 'definition', state: { count: 1 }, events: [{ type: 'created', data: {} }] };
  let store = create();
  try {
    stage = 'initialization';
    await store.initialize(); await store.scheduler.initialize(); await store.workflows.initialize(); await store.workflowGraphs.initialize(); await store.executionWaits.initialize();
    stage = 'aggregate-transactions';
    const first = await store.create(original); assert.equal(first.created, true);
    const updated = await store.update({ scope: original.scope, id: original.id, expectedVersion: 1, state: { count: 2 }, events: [{ type: 'updated', data: {} }] });
    assert.equal(updated.version, 2);
    await assert.rejects(store.update({ scope: original.scope, id: original.id, expectedVersion: 1, state: {}, events: [] }), error => error instanceof StorageError && error.code === 'CONFLICT');
    assert.equal((await store.create(original)).record.version, 2); assert.equal((await store.events(original.scope, original.id)).length, 2);

    stage = 'scheduler-transactions';
    const job = { scope: 'packed.scheduler', jobId: 'job', reservationKey: 'reserve', runId: 'run', nodeId: 'node', invocationId: 'invocation',
      definitionHash: 'd'.repeat(64), candidateHash: 'a'.repeat(64), intent: { toolId: 'packed.tool', callId: 'packed.call' }, resourceKeys: [], delayMs: 0 };
    assert.equal((await store.scheduler.reserve(job)).created, true);
    const claim = (await store.scheduler.claim({ scope: job.scope, workerId: 'packed.worker', limit: 1, leaseMs: 30_000 }))[0].claim;
    assert.equal((await store.scheduler.start({ claim, candidateHash: job.candidateHash })).status, 'started');
    assert.equal((await store.scheduler.start({ claim, candidateHash: job.candidateHash })).status, 'already_started');
    await store.scheduler.recordReceipt({ scope: job.scope, jobId: job.jobId, fence: claim.fence, evidenceId: 'evidence',
      receipt: { callId: 'packed.call', toolId: 'packed.tool', execution: 'succeeded', disclosure: 'withheld' } });
    assert.equal((await store.scheduler.complete({ claim, commandId: 'complete', evidenceId: 'evidence', outcome: 'succeeded', output: { admitted: true } })).state, 'succeeded');

    stage = 'workflow-and-completion-wait';
    const manifest = { id: 'packed.workflow', version: '1', graph: [{ id: 'join', kind: 'join', dependsOn: [] }], result: { kind: 'step', stepId: 'join', path: [] } };
    const policy = { scope: { principalId: 'packed', projectId: 'consumer' }, permissions: [], policyVersion: '1', maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 60_000 };
    const submitted = (await store.workflows.submit({ manifest, policy, resources: {}, input: null, idempotencyKey: 'workflow' })).snapshot;
    const access = { scope: submitted.record.scope, id: submitted.record.id, policyHash: submitted.policyHash };
    const target = { kind: 'scheduled-workflow', runId: access.id, definitionHash: submitted.manifestHash, policyHash: access.policyHash };
    const stream = { scope: access.scope, streamId: 'joins', policyHash: access.policyHash };
    await store.executionWaits.open(stream);
    assert.equal((await store.executionWaits.register({ ...stream, id: 'release', targets: [target] })).status, 'waiting');
    const graphManifest = { format: 3, id: 'packed.graph', version: '1', graph: [
      { id: 'observe', kind: 'wait', dependsOn: [], targets: { kind: 'input', path: [] } },
    ], result: { kind: 'step', stepId: 'observe', path: [] } };
    const graph = (await store.workflowGraphs.submit({ manifest: graphManifest, policy, resources: {}, input: [target], idempotencyKey: 'graph' })).snapshot;
    const graphAccess = { scope: graph.record.scope, id: graph.record.id, policyHash: graph.policyHash };
    const waitingGraph = await store.workflowGraphs.advance({ ...graphAccess, expectedVersion: graph.record.version, commandId: 'graph-wait' });
    assert.equal(waitingGraph.profile, 'scheduled-v2'); assert.equal(waitingGraph.record.state.format, 3);
    assert.equal(waitingGraph.record.state.status, 'waiting'); assert.equal(waitingGraph.jobs.length, 0);
    assert.equal(waitingGraph.record.state.reservedMicros, 0);
    const advanced = await store.workflows.advance({ ...access, expectedVersion: submitted.record.version, commandId: 'advance' });
    await store.workflows.finalize({ ...access, expectedVersion: advanced.record.version, commandId: 'finalize', validation: 'passed', output: [] });
    const resolved = (await store.executionWaits.drainReady({ ...stream, limit: 1 }))[0];
    assert.equal(resolved.status, 'resolved'); assert.equal(resolved.version, 2); assert.equal(resolved.observations[0].outcome, 'succeeded');
    assert(!Object.hasOwn(resolved.observations[0], 'output')); assert(Object.isFrozen(resolved.observations[0]));
    stage = 'direct-reopen';
    await store.close(); store = reopen();
    await store.initialize(); await store.scheduler.initialize(); await store.workflows.initialize(); await store.workflowGraphs.initialize(); await store.executionWaits.initialize();
    assert.deepEqual((await store.read(original.scope, original.id)).state, { count: 2 });
    assert.equal((await store.scheduler.read({ scope: job.scope, jobId: job.jobId })).state, 'succeeded');
    assert.deepEqual(await store.executionWaits.inspect({ ...stream, id: 'release' }), resolved);
    assert.deepEqual(await store.executionWaits.drainReady({ ...stream, limit: 1 }), []);
    assert.equal((await store.executionWaits.events({ ...stream, after: 0 })).length, 3);
    assert.deepEqual(await store.workflowGraphs.inspect(graphAccess), waitingGraph);
    await assert.rejects(store.workflows.inspect(graphAccess), error => error instanceof StorageError);
    const resumed = await store.workflowGraphs.advance({ ...graphAccess, expectedVersion: waitingGraph.record.version, commandId: 'graph-resume' });
    assert.deepEqual(resumed.record.state.steps.observe.output, resolved.observations);
    const finishedGraph = await store.workflowGraphs.finalize({ ...graphAccess, expectedVersion: resumed.record.version, commandId: 'graph-finalize', validation: 'passed', output: resumed.record.state.steps.observe.output });
    assert.equal(finishedGraph.record.state.status, 'succeeded'); assert.equal(finishedGraph.jobs.length, 0);
    const graphTarget = { kind: 'scheduled-workflow', runId: graphAccess.id, definitionHash: graph.manifestHash, policyHash: graphAccess.policyHash };
    assert.equal((await store.executionWaits.register({ ...stream, id: 'graph-release', targets: [graphTarget] })).observations[0].outcome, 'succeeded');
    await store.update({ scope: original.scope, id: original.id, expectedVersion: 2, state: { count: 3 }, events: [{ type: 'reopened', data: {} }] });
    stage = 'reverse-reopen';
    await store.close(); store = create(); await store.initialize();
    assert.deepEqual((await store.read(original.scope, original.id)).state, { count: 3 });
    await store.workflowGraphs.initialize();
    assert.deepEqual((await store.workflowGraphs.inspect(graphAccess)).record, finishedGraph.record);
    return { status: 'passed', aggregateVersion: 3, scheduler: 'succeeded', workflow: 'succeeded', waitVersion: 2, graphReopenedFromWaiting: true, graphJobs: 0, reopenDirections: 2 };
  } finally { await store.close(); }
}

try {
  let sqlite = { status: 'not-selected' }; let postgres = { status: profile === 'sqlite' ? 'not-selected' : 'skipped', reason: 'No explicit disposable database URL supplied.' };
  if (profile !== 'postgres') {
    stage = 'sqlite-factory';
    const direct = await import('@mayura/storage-sqlite');
    if (profile === 'compat') assert.equal(selected.createSqliteStore, direct.createSqliteStore);
    assert.throws(() => direct.createSqliteStore({ filename: '' }), error => error instanceof StorageError && error.code === 'INVALID_INPUT');
    const options = { filename: join(process.cwd(), 'packed-storage.sqlite') };
    sqlite = await exercise(() => selected.createSqliteStore(options), () => direct.createSqliteStore(options));
  }
  if (profile !== 'sqlite') {
    stage = 'postgres-factory';
    const direct = await import('@mayura/storage-postgres');
    if (profile === 'compat') assert.equal(selected.createPostgresStore, direct.createPostgresStore);
    assert.throws(() => direct.createPostgresStore({ connectionString: 'postgresql://unused', schema: 'bad schema' }), error => error instanceof StorageError && error.code === 'INVALID_INPUT');
    if (process.env.MAYURA_TEST_POSTGRES_URL) {
      const { Pool } = await import('pg');
      const schema = `mayura_packed_${randomUUID().replaceAll('-', '')}`;
      assert(/^mayura_packed_[a-f0-9]{32}$/.test(schema));
      const options = { connectionString: process.env.MAYURA_TEST_POSTGRES_URL, schema };
      const cleanup = new Pool({ connectionString: options.connectionString, max: 1, connectionTimeoutMillis: 5_000 });
      cleanup.on('error', () => {});
      try { postgres = await exercise(() => selected.createPostgresStore(options), () => direct.createPostgresStore(options)); }
      finally {
        // Only this generated, validated disposable schema is removed. Never log the connection URL.
        try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); }
      }
    }
  }
  console.log(JSON.stringify({ status: 'passed', profile, sqlite, postgres, driverTypesInstalled: false, privateExportsDenied: true }));
} catch {
  // Only a fixture-owned stage label is public; exception and connection details stay private.
  process.stderr.write(`Packed storage consumer failed at ${stage}; database and driver diagnostics withheld.\n`); process.exitCode = 1;
}
