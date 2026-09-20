import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage';
import { defineTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime, defineWorkflow } from '@mayura/workflows';
import { createExecutionWorkStream } from '@mayura/workstream/executions';

// This optional SQLite example performs no provider calls and requires no credentials.
const integer = { '~standard': { version: 1, vendor: 'example', validate: value =>
  Number.isSafeInteger(value) ? { value } : { issues: [{ message: 'Expected a safe integer.' }] } } };
const increment = defineTool({ id: 'local.increment', version: '1', description: 'Increment a local integer.',
  input: integer, output: integer, effects: 'none', capabilities: [], execute: value => value + 1 });
const definition = defineWorkflow({ id: 'completion-source', version: '1', input: integer, output: integer,
  nodes: [{ kind: 'tool', id: 'increment', tool: increment, input: { kind: 'input', path: [] } }],
  result: { kind: 'step', stepId: 'increment', path: [] } });
const scope = { principalId: 'example-developer', projectId: 'example-project' };
const directory = await mkdtemp(join(tmpdir(), 'mayura-completion-example-'));
const filename = join(directory, 'completion.sqlite');
let store; let worker; let stream;
const openWorker = storage => createScheduledWorkflowRuntime({ store: storage, scope,
  permissions: { allow: ['tool:local.increment'] }, policyVersion: 'example-v1', maxCostMicros: 0, workerId: 'example-worker' });

try {
  store = createSqliteStore({ filename }); await store.initialize(); worker = openWorker(store);
  const run = await worker.submit(definition, { input: 1, idempotencyKey: 'source-one' });
  const target = await worker.reference(run.id);
  stream = createExecutionWorkStream({ store, scope, policyHash: target.policyHash, streamId: 'release-joins' });
  await stream.initialize();
  const before = await stream.register({ id: 'release', targets: [target] });
  if (before.status !== 'waiting') throw new Error('Expected the unexecuted workflow to leave its join waiting.');

  // Close every local owner; only committed workflow/wait metadata survives in SQLite.
  await stream.close(); await worker.close(); await store.close();
  store = createSqliteStore({ filename }); await store.initialize(); worker = openWorker(store);
  await worker.runUntilSettled(definition, run.id);
  stream = createExecutionWorkStream({ store, scope, policyHash: target.policyHash, streamId: 'release-joins' });
  await stream.initialize();
  // One explicit finite drain: there is no background loop or per-wait promise.
  await stream.drainReady({ limit: 16 });
  const after = await stream.inspect('release');
  if (after?.status !== 'resolved' || after.observations[0]?.outcome !== 'succeeded') throw new Error('Expected a resolved terminal observation.');
  console.log(JSON.stringify({ before: before.status, after: after.status, outcome: after.observations[0].outcome, observations: after.observations.length }));
} finally {
  await stream?.close(); await worker?.close(); await store?.close();
  const cleanup = resolve(directory);
  if (!cleanup.startsWith(`${resolve(tmpdir())}${sep}mayura-completion-example-`)) throw new Error('Unexpected example fixture path.');
  await rm(cleanup, { recursive: true, force: true });
}
