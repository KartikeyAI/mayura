import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { defineWorkflow, createScheduledWorkflowRuntime } from 'mayura/workflows';
import { defineWorkflowGraph, createWorkflowGraphRuntime, createWorkflowGraphCoordinator } from 'mayura/workflows/graphs';

// No model, credentials or external effects. The application owns each finite sweep.
const json = { '~standard': { version: 1, vendor: 'example', validate: value => ({ value }) } };
const joinDefinition = id => ({ id, version: '1', input: json, output: json,
  nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'step', stepId: 'done', path: [] } });
const source = defineWorkflow(joinDefinition('coordinator.source'));
const ready = defineWorkflowGraph(joinDefinition('coordinator.ready'));
const unregistered = defineWorkflowGraph(joinDefinition('coordinator.unregistered'));
const waiting = defineWorkflowGraph({ id: 'coordinator.waiting', version: '1', input: json, output: json,
  nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'input', path: [] } }],
  result: { kind: 'step', stepId: 'observe', path: [] } });
const policy = { scope: { principalId: 'example', projectId: 'graph-coordinator' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
const definitions = [{ definition: waiting }, { definition: ready }];
const directory = await mkdtemp(join(tmpdir(), 'mayura-coordinator-example-'));
const filename = join(directory, 'workflow.sqlite');
let store; let sourceWorker; let submitter; let coordinator;

/** A page budget is application policy; reaching a limit is not an exhausted sweep. */
async function sweep() {
  let cursor = null; let examined = 0; const outcomes = [];
  for (let pages = 0; pages < 4; pages++) {
    const report = await coordinator.runPage({ cursor, limit: 2 });
    if (report.status === 'interrupted') {
      // A real application retains report.retryCursor, not a cursor past unfinished work.
      throw new Error(`Explicit retry/reconciliation is required: ${report.code}`);
    }
    examined += report.examined; outcomes.push(...report.outcomes); cursor = report.nextCursor;
    if (cursor === null) return { examined, outcomes };
  }
  throw new Error('Application page budget exhausted; retain the last cursor for a later call.');
}

try {
  store = createSqliteStore({ filename }); await store.initialize();
  sourceWorker = createScheduledWorkflowRuntime({ ...policy, store, workerId: 'source' });
  submitter = createWorkflowGraphRuntime({ ...policy, store, workerId: 'submitter' });
  const sourceRun = await sourceWorker.submit(source, { input: null, idempotencyKey: 'source' });
  const target = await sourceWorker.reference(sourceRun.id);
  await submitter.submit(waiting, { input: [target], idempotencyKey: 'waiting' });
  await submitter.submit(ready, { input: null, idempotencyKey: 'ready' });
  await submitter.submit(unregistered, { input: null, idempotencyKey: 'unregistered' });
  await submitter.close(); await sourceWorker.close(); await store.close();

  // Reopen without a parent run list. One coordinator shares one driver across definitions.
  store = createSqliteStore({ filename }); await store.initialize();
  coordinator = createWorkflowGraphCoordinator({ ...policy, store, workerId: 'continuation', definitions, maxConcurrentJobs: 1 });
  const first = await sweep();
  const observed = first.outcomes.filter(item => item.kind === 'observed');
  if (first.examined !== 3 || observed.length !== 2 || !observed.some(item => item.status === 'waiting')
    || !observed.some(item => item.status === 'succeeded') || first.outcomes.filter(item => item.kind === 'skipped').length !== 1) {
    throw new Error('Expected one waiting, one completed and one unregistered graph.');
  }
  sourceWorker = createScheduledWorkflowRuntime({ ...policy, store, workerId: 'source-reopened' });
  await sourceWorker.runUntilSettled(source, sourceRun.id);
  // A fresh caller-started sweep revisits waiting/unknown runs passed by an earlier cursor.
  const second = await sweep();
  if (second.outcomes.filter(item => item.kind === 'observed' && item.status === 'succeeded').length !== 1
    || second.outcomes.filter(item => item.kind === 'skipped').length !== 1) throw new Error('Expected explicit continuation after source completion.');
  console.log(JSON.stringify({ first: observed.map(item => item.status).sort(), resumed: 1, unregisteredSkipped: true, automaticPolling: false }));
} finally {
  await coordinator?.close(); await submitter?.close(); await sourceWorker?.close(); await store?.close();
  const cleanup = resolve(directory);
  if (!cleanup.startsWith(`${resolve(tmpdir())}${sep}mayura-coordinator-example-`)) throw new Error('Unexpected example fixture path.');
  await rm(cleanup, { recursive: true, force: true });
}
