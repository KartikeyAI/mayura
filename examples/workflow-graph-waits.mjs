import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { defineWorkflow, createScheduledWorkflowRuntime } from '@mayura/workflows';
import { defineWorkflowGraph, createWorkflowGraphRuntime } from '@mayura/workflows/graphs';

// No model, provider credentials, network calls or external effects are needed.
const json = { '~standard': { version: 1, vendor: 'example', validate: value => ({ value }) } };
const source = defineWorkflow({ id: 'local.source', version: '1', input: json, output: json,
  nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'step', stepId: 'done', path: [] } });
const graph = defineWorkflowGraph({ id: 'local.release', version: '1', input: json, output: json,
  nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'input', path: ['references'] } }],
  result: { kind: 'step', stepId: 'observe', path: [] } });
const directory = await mkdtemp(join(tmpdir(), 'mayura-graph-example-'));
const filename = join(directory, 'workflow.sqlite');
const scope = { principalId: 'example', projectId: 'graph-waits' };
const options = store => ({ store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, workerId: 'example', maxConcurrentJobs: 1 });
let store; let sourceWorker; let graphWorker;
try {
  store = createSqliteStore({ filename }); await store.initialize();
  sourceWorker = createScheduledWorkflowRuntime(options(store)); graphWorker = createWorkflowGraphRuntime(options(store));
  const targetRun = await sourceWorker.submit(source, { input: null, idempotencyKey: 'source' });
  const target = await sourceWorker.reference(targetRun.id);
  const run = await graphWorker.submit(graph, { input: { references: [target] }, idempotencyKey: 'release' });
  const before = await graphWorker.runUntilSettled(graph, run.id);
  if (before.status !== 'waiting' || before.budget.reservedMicros !== 0) throw new Error('Expected a durable wait without an execution reservation.');

  // No Promise or execution worker remains held for the target. Only committed state survives.
  await graphWorker.close(); await sourceWorker.close(); await store.close();
  store = createSqliteStore({ filename }); await store.initialize();
  sourceWorker = createScheduledWorkflowRuntime(options(store)); graphWorker = createWorkflowGraphRuntime(options(store));
  await sourceWorker.runUntilSettled(source, targetRun.id);
  const after = await graphWorker.runUntilSettled(graph, run.id);
  if (after.status !== 'succeeded' || after.output[0]?.outcome !== 'succeeded') throw new Error('Expected the reopened graph to observe the completed source.');
  console.log(JSON.stringify({ before: before.status, after: after.status, targetOutcome: after.output[0].outcome, spentMicros: after.budget.spentMicros }));
} finally {
  await graphWorker?.close(); await sourceWorker?.close(); await store?.close();
  const cleanup = resolve(directory);
  if (!cleanup.startsWith(`${resolve(tmpdir())}${sep}mayura-graph-example-`)) throw new Error('Unexpected example fixture path.');
  await rm(cleanup, { recursive: true, force: true });
}
