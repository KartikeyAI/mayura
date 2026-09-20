import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage';
import { createScheduledWorkflowRuntime, defineWorkflow } from '../dist/index.js';

// The example owns only this newly created disposable database. No provider credentials or effects.
const directory = await mkdtemp(join(tmpdir(), 'mayura-scheduled-example-'));
const filename = join(directory, 'workflow.sqlite');
let store;
let worker;
let executions = 0;
try {
  const double = defineTool({
    id: 'double', version: '1', description: 'Double a bounded integer.',
    input: z.number().int().min(0).max(1_000), output: z.number().int().min(0).max(2_000),
    effects: 'none', capabilities: [], costMicros: 1, timeoutMs: 5_000,
    execute: async value => { executions++; return value * 2; },
  });
  const definition = defineWorkflow({
    id: 'durable-double', version: '1', input: z.number().int().min(0).max(1_000), output: z.number().int(),
    nodes: [{ kind: 'tool', id: 'calculate', tool: double, input: { kind: 'input', path: [] } }],
    result: { kind: 'step', stepId: 'calculate', path: [] },
  });
  const policy = {
    scope: { principalId: 'local-example', projectId: 'example' },
    permissions: { allow: ['tool:double'] }, policyVersion: '1', maxCostMicros: 1,
  };
  store = createSqliteStore({ filename });
  await store.initialize();
  worker = createScheduledWorkflowRuntime({ store, ...policy, workerId: 'worker-a' });
  const submitted = await worker.submit(definition, { input: 21, idempotencyKey: 'example-1' });
  const result = await worker.runUntilSettled(definition, submitted.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 42);
  assert.equal(result.budget.spentMicros, 1);
  await worker.close();
  await store.close();

  // A fresh adapter and worker restore committed results without invoking the tool again.
  store = createSqliteStore({ filename });
  await store.initialize();
  worker = createScheduledWorkflowRuntime({ store, ...policy, workerId: 'worker-b' });
  const restored = await worker.runUntilSettled(definition, submitted.id);
  assert.equal(restored.status, 'succeeded');
  assert.equal(restored.output, 42);
  assert.equal(executions, 1);
  const events = await worker.events(submitted.id);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  console.log(JSON.stringify({ status: restored.status, output: restored.output, executions, spentMicros: restored.budget.spentMicros, events: events.length }));
} finally {
  await worker?.close();
  await store?.close();
  const target = resolve(directory);
  if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-scheduled-example-`)) throw new Error('Unexpected example cleanup target.');
  await rm(target, { recursive: true, force: true });
}
