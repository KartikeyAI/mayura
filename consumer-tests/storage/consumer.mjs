import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StorageError } from '@mayura/storage-contracts';

const profile = process.env.MAYURA_STORAGE_PROFILE;
let stage = 'imports';
assert(['sqlite', 'postgres', 'compat','tree-sqlite'].includes(profile));
const selectedPackage=profile==='compat'?'storage':profile==='tree-sqlite'?'storage-sqlite':`storage-${profile}`;
const selected = await import(`@mayura/${selectedPackage}`);
await import('@mayura/storage-sql/host');
for (const specifier of ['@mayura/storage-sql/src/scheduler-database.js', '@mayura/storage-sql/dist/scheduler-database.js',
  `@mayura/${selectedPackage}/src/index.js`]) {
  await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
for (const specifier of ['pg-native', '@mayura/sdk', ...(profile==='tree-sqlite'?[]:['@mayura/runtime','@mayura/tools','@mayura/workflows']), '@mayura/server-node']) {
  await assert.rejects(import(specifier), { code: 'ERR_MODULE_NOT_FOUND' });
}
if (profile === 'sqlite'||profile==='tree-sqlite') {
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
    stage = 'durable-budget-admission';
    await store.durableBudgets.initialize();
    const budgetKey = { scope: 'packed.financial', id: 'ledger', policyHash: 'e'.repeat(64) };
    const budgetConfiguration = { ...budgetKey, maxCostMicros: 10, maxCalls: 4 };
    await assert.rejects(store.durableBudgets.create({ ...budgetConfiguration, id: '\ud800' }),
      error => error instanceof StorageError && error.code === 'INVALID_INPUT');
    assert.equal((await store.durableBudgets.create(budgetConfiguration)).created, true);
    await store.durableBudgets.fork({ ...budgetKey, parentId: 'root', accountId: 'child', maxCostMicros: 4, maxCalls: 2 });
    const budgetBundle = { ...budgetKey, accountId: 'child', bundleId: 'protected-pair',
      operations: [{ id: 'primary', maxCostMicros: 3 }, { id: 'check', maxCostMicros: 1 }] };
    await store.durableBudgets.reserveBundle(budgetBundle);
    const reservation = { ...budgetKey, accountId: 'child', reservationId: 'primary' };
    assert.equal((await store.durableBudgets.start(reservation)).status, 'started');
    assert.equal((await store.durableBudgets.start(reservation)).status, 'already_started');
    await store.durableBudgets.markUnknown(reservation);
    const closedBudget = await store.durableBudgets.closeSubtree({ ...budgetKey, accountId: 'child' });
    assert.equal(closedBudget.accounts.find(account => account.id === 'root').reservedMicros, 3);
    assert.equal(closedBudget.accounts.find(account => account.id === 'root').calls, 1);
    assert.equal(closedBudget.reservations.find(item => item.id === 'check').status, 'cancelled');
    assert(Object.isFrozen(closedBudget.accounts[0]));
    stage = 'aggregate-transactions';
    await assert.rejects(store.create({ ...original, id: '\ud800' }), error => error instanceof StorageError && error.code === 'INVALID_INPUT');
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
    let treeFixture;
    if(profile==='tree-sqlite'){
      stage='workflow-tree-submit';
      const {defineTool}=await import('@mayura/tools');const {defineWorkflow}=await import('@mayura/workflows');const {createWorkflowTreeRuntime,defineWorkflowTree}=await import('@mayura/workflows/children');
      const numberSchema=Object.freeze({'~standard':Object.freeze({version:1,vendor:'packed',validate:value=>typeof value==='number'?{value}:{issues:[{message:'number'}]}})});
      let executions=0;const tool=defineTool({id:'packed.increment',version:'1',description:'Increment.',input:numberSchema,output:numberSchema,effects:'none',capabilities:[],costMicros:2,execute:async value=>{executions++;return value+1;}});
      const leaf=defineWorkflow({id:'packed.leaf',version:'1',input:numberSchema,output:numberSchema,nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]},approval:true}],result:{kind:'step',stepId:'work',path:[]}});
      const tree=defineWorkflowTree({id:'packed.tree',version:'1',input:numberSchema,output:numberSchema,nodes:[{kind:'tool',id:'rootWork',tool,input:{kind:'input',path:[]},approval:true},{kind:'child',id:'child',dependsOn:['rootWork'],workflow:leaf,input:{kind:'step',stepId:'rootWork',path:[]},policy:{permissions:['tool:packed.increment'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:[]}}],result:{kind:'step',stepId:'child',path:[]}});
      const options={scope:{principalId:'packed',projectId:'consumer'},permissions:{allow:['tool:packed.increment']},policyVersion:'1',maxCostMicros:4,maxCalls:2,maxOutputBytes:1_024,workerId:'packed-worker',verifyHuman:async credential=>{assert.equal(credential,'packed-review');return{id:'packed-reviewer',projectId:'consumer',canApprove:true};}};
      const runtime=createWorkflowTreeRuntime({store,...options});const submitted=await runtime.submit(tree,{input:1,idempotencyKey:'packed-tree'});await runtime.close();treeFixture={tree,options,id:submitted.id,executions,createRuntime:createWorkflowTreeRuntime,getExecutions:()=>executions};
    }
    stage = 'direct-reopen';
    await store.close(); store = reopen();
    await store.initialize(); await store.scheduler.initialize(); await store.workflows.initialize(); await store.workflowGraphs.initialize(); await store.executionWaits.initialize();
    stage = 'durable-budget-reopen-and-settlement';
    await store.durableBudgets.initialize();
    if(treeFixture){stage='workflow-tree-reopen';const runtime=treeFixture.createRuntime({store,...treeFixture.options});const rootWaiting=await runtime.runUntilSettled(treeFixture.tree,treeFixture.id);assert.equal(rootWaiting.status,'waiting');assert.equal(treeFixture.getExecutions(),0);const rootReview=rootWaiting.steps.rootWork.approval;assert(rootReview&&typeof rootReview.digest==='string'&&rootReview.humanId===null);await runtime.approve({id:rootWaiting.id,nodeId:'rootWork',digest:rootReview.digest,credential:'packed-review'});const childWaiting=await runtime.runUntilSettled(treeFixture.tree,treeFixture.id);assert.equal(childWaiting.status,'waiting');assert.equal(treeFixture.getExecutions(),1);const link=childWaiting.steps.child.child;assert(link);const child=await runtime.inspectChild(childWaiting.id,link.runId);const review=child.steps.work.approval;assert(review&&typeof review.digest==='string'&&review.humanId===null);await runtime.approve({id:childWaiting.id,childId:link.runId,nodeId:'work',digest:review.digest,credential:'packed-review'});const finished=await runtime.runUntilSettled(treeFixture.tree,treeFixture.id);assert.equal(finished.status,'succeeded');assert.equal(finished.output,3);assert.equal(treeFixture.getExecutions(),2);await runtime.close();}
    assert.deepEqual(await store.durableBudgets.inspect(budgetKey), closedBudget);
    assert.deepEqual(await store.durableBudgets.reserveBundle(budgetBundle), closedBudget);
    const settledBudget = await store.durableBudgets.settle({ ...reservation, actualMicros: 2 });
    assert.equal(settledBudget.overrun, false);
    assert.equal(settledBudget.snapshot.accounts.find(account => account.id === 'root').spentMicros, 2);
    assert.equal(settledBudget.snapshot.accounts.find(account => account.id === 'root').reservedMicros, 0);
    await store.durableBudgets.reserveBundle({ ...budgetKey, accountId: 'root', bundleId: 'overrun-bundle', operations: [{ id: 'overrun', maxCostMicros: 1 }] });
    const overrunReservation = { ...budgetKey, accountId: 'root', reservationId: 'overrun' };
    await store.durableBudgets.start(overrunReservation);
    const overrun = await store.durableBudgets.settle({ ...overrunReservation, actualMicros: 2 });
    assert.equal(overrun.overrun, true); assert.equal(overrun.snapshot.blocked, true);
    assert.equal(overrun.snapshot.accounts.find(account => account.id === 'root').spentMicros, 4);
    await assert.rejects(store.durableBudgets.reserveBundle({ ...budgetKey, accountId: 'root', bundleId: 'denied', operations: [{ id: 'denied', maxCostMicros: 0 }] }),
      error => error instanceof StorageError && error.code === 'CONFLICT');
    stage = 'direct-reopen-checks';
    assert.deepEqual((await store.read(original.scope, original.id)).state, { count: 2 });
    assert.equal((await store.scheduler.read({ scope: job.scope, jobId: job.jobId })).state, 'succeeded');
    assert.deepEqual(await store.executionWaits.inspect({ ...stream, id: 'release' }), resolved);
    assert.deepEqual(await store.executionWaits.drainReady({ ...stream, limit: 1 }), []);
    assert.equal((await store.executionWaits.events({ ...stream, after: 0 })).length, 3);
    assert.deepEqual(await store.workflowGraphs.inspect(graphAccess), waitingGraph);
    // Existing parents predate discovery initialization; no backfill or new projection is needed.
    await store.workflowGraphDiscovery.initialize();
    const scan = { scope: graphAccess.scope, policyHash: graphAccess.policyHash, cursor: null, limit: 1 };
    const discovered = await store.workflowGraphDiscovery.scan(scan);
    assert.equal(discovered.examined, 1); assert.equal(discovered.candidates.length, 1);
    assert.equal(discovered.candidates[0].reference.runId, graphAccess.id); assert.equal(discovered.candidates[0].status, 'waiting');
    assert.equal(discovered.nextCursor.afterId, graphAccess.id);
    assert.deepEqual(await store.workflowGraphDiscovery.scan({ ...scan, cursor: discovered.nextCursor }), { candidates: [], examined: 0, nextCursor: null });
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
    await store.durableBudgets.initialize();
    assert.deepEqual(await store.durableBudgets.inspect(budgetKey), overrun.snapshot);
    const retriedBudget = await store.durableBudgets.create(budgetConfiguration);
    assert.equal(retriedBudget.created, false); assert.equal(retriedBudget.snapshot.blocked, true);
    assert.equal((await store.durableBudgets.events({ ...budgetKey, after: 0 })).length, 10);
    assert.deepEqual((await store.read(original.scope, original.id)).state, { count: 3 });
    await store.workflowGraphs.initialize();
    assert.deepEqual((await store.workflowGraphs.inspect(graphAccess)).record, finishedGraph.record);
    await store.workflowGraphDiscovery.initialize();
    const terminalPage = await store.workflowGraphDiscovery.scan(scan);
    assert.deepEqual(terminalPage.candidates, []); assert.equal(terminalPage.examined, 1); assert.equal(terminalPage.nextCursor.afterId, graphAccess.id);
    return { status: 'passed', aggregateVersion: 3, scheduler: 'succeeded', workflow: 'succeeded', waitVersion: 2, graphReopenedFromWaiting: true, graphJobs: 0, finiteGraphDiscovery: true, terminalCursorProgress: true,
      durableBudgetReopened: true, unknownHoldPreserved: true, overrunCommitted: true, packedWorkflowTree:treeFixture?true:'not-selected', packedWorkflowTreeApproval:treeFixture?true:'not-selected', reopenDirections: 2 };
  } finally { await store.close(); }
}

try {
  let sqlite = { status: 'not-selected' }; let postgres = { status: ['sqlite','tree-sqlite'].includes(profile) ? 'not-selected' : 'skipped', reason: 'No explicit disposable database URL supplied.' };
  if (profile !== 'postgres') {
    stage = 'sqlite-factory';
    const direct = await import('@mayura/storage-sqlite');
    if (profile === 'compat') assert.equal(selected.createSqliteStore, direct.createSqliteStore);
    assert.throws(() => direct.createSqliteStore({ filename: '' }), error => error instanceof StorageError && error.code === 'INVALID_INPUT');
    const options = { filename: join(process.cwd(), 'packed-storage.sqlite') };
    sqlite = await exercise(() => selected.createSqliteStore(options), () => direct.createSqliteStore(options));
  }
  if (!['sqlite','tree-sqlite'].includes(profile)) {
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
