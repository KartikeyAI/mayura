import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { defineWorkflow, createScheduledWorkflowRuntime } from 'mayura/workflows';
import { defineWorkflowGraph, createWorkflowGraphRuntime, createWorkflowGraphDiscovery } from 'mayura/workflows/graphs';

// Credential-free restart recovery. The application, not discovery, owns this finite loop.
const json = { '~standard': { version: 1, vendor: 'example', validate: value => ({ value }) } };
const source = defineWorkflow({ id: 'discovery.source', version: '1', input: json, output: json,
  nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'step', stepId: 'done', path: [] } });
const graph = defineWorkflowGraph({ id: 'discovery.release', version: '1', input: json, output: json,
  nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'observe', path: [] } });
const policy = { scope: { principalId: 'example', projectId: 'graph-discovery' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
const definitions = new Map([[graph.digest, graph]]);
const directory = await mkdtemp(join(tmpdir(), 'mayura-discovery-example-'));
const filename = join(directory, 'workflow.sqlite');
let store; let sourceWorker; let graphWorker; let discovery;
try {
  store = createSqliteStore({ filename }); await store.initialize();
  sourceWorker = createScheduledWorkflowRuntime({ ...policy, store, workerId: 'source' });
  graphWorker = createWorkflowGraphRuntime({ ...policy, store, workerId: 'graph' });
  const sourceRun = await sourceWorker.submit(source, { input: null, idempotencyKey: 'source' });
  const reference = await sourceWorker.reference(sourceRun.id);
  for (const key of ['continue-after-restart', 'already-cancelled']) {
    const run = await graphWorker.submit(graph, { input: [reference], idempotencyKey: key });
    await graphWorker.runUntilSettled(graph, run.id);
    if (key === 'already-cancelled') await graphWorker.cancel(run.id);
  }
  await graphWorker.close(); await sourceWorker.close(); await store.close();

  store = createSqliteStore({ filename }); await store.initialize();
  sourceWorker = createScheduledWorkflowRuntime({ ...policy, store, workerId: 'source-reopened' });
  graphWorker = createWorkflowGraphRuntime({ ...policy, store, workerId: 'graph-reopened' });
  discovery = createWorkflowGraphDiscovery({ ...policy, store });
  await sourceWorker.runUntilSettled(source, sourceRun.id);
  let cursor = null; let pages = 0; let examined = 0; let resumed = 0; let exhausted = false;
  for (; pages < 4;) {
    const page = await discovery.scan({ cursor, limit: 1 }); pages++; examined += page.examined;
    for (const candidate of page.candidates) {
      const registered = definitions.get(candidate.reference.definitionHash);
      if (!registered) throw new Error('A discovered definition requires explicit application registration.');
      const result = await graphWorker.runUntilSettled(registered, candidate.reference.runId);
      if (result.status !== 'succeeded') throw new Error('Expected the completed source to permit continuation.');
      resumed++;
    }
    cursor = page.nextCursor;
    if (cursor === null) { exhausted = true; break; }
    // Empty candidate pages still have a cursor when terminal owners were examined.
  }
  if (!exhausted || examined !== 2 || resumed !== 1) throw new Error('Unexpected finite discovery example result.');
  console.log(JSON.stringify({ pages, examined, resumed, exhausted, automaticPolling: false }));
} finally {
  await discovery?.close(); await graphWorker?.close(); await sourceWorker?.close(); await store?.close();
  const cleanup = resolve(directory);
  if (!cleanup.startsWith(`${resolve(tmpdir())}${sep}mayura-discovery-example-`)) throw new Error('Unexpected example fixture path.');
  await rm(cleanup, { recursive: true, force: true });
}
