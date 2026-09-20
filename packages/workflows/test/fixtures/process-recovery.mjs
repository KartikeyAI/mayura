import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage';
import { createWorkflowRuntime, defineWorkflow } from '@mayura/workflows';

// This fixture intentionally reaches real crash boundaries. It is never a production example.
const [scenario, action, directory, existingRunId, reviewedDigest] = process.argv.slice(2);
if (!['approval', 'dispatch', 'receipt'].includes(scenario) || !['start', 'recover'].includes(action) || !directory) {
  throw new Error('Invalid process recovery fixture arguments.');
}
const fixtureDirectory = resolve(directory);
if (!basename(fixtureDirectory).startsWith('mayura-process-recovery-')) throw new Error('Unexpected fixture directory.');
const filename = join(fixtureDirectory, 'workflow.sqlite');
const effectFile = join(fixtureDirectory, 'effects.ndjson');
if (dirname(effectFile) !== fixtureDirectory || dirname(filename) !== fixtureDirectory) throw new Error('Fixture path escaped its directory.');

/** A marker is acknowledged through IPC before the parent kills this process. */
function notify(message) {
  return new Promise((resolveMessage, reject) => {
    if (!process.send) return reject(new Error('The fixture requires an IPC parent.'));
    process.send(message, (error) => error ? reject(error) : resolveMessage());
  });
}

/** Write only the test-owned artifact and flush it before exposing a crash marker. */
function recordEffect(context) {
  const descriptor = openSync(effectFile, 'a');
  try {
    writeSync(descriptor, `${JSON.stringify({ runId: context.runId, callId: context.callId })}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

const value = z.object({ value: z.number() });
const store = createSqliteStore({ filename });
const tool = defineTool({
  id: 'process.write', version: '1', description: 'Append once to a test-owned artifact.',
  input: value, output: value, effects: 'write', capabilities: [], costMicros: 1, timeoutMs: 120_000,
  execute: async (input, context) => {
    recordEffect(context);
    if (scenario === 'dispatch') {
      await notify({ kind: 'dispatched', runId: context.runId });
      return await new Promise(() => {});
    }
    return input;
  },
  ...(scenario === 'receipt' ? {
    guards: { output: [{ id: 'pause-after-receipt', check: async (_output, context) => {
      // The broker's durable receipt hook has completed before output guards are invoked.
      await notify({ kind: 'receipt_pending', runId: context.runId });
      return await new Promise(() => {});
    } }] },
  } : {}),
});
const definition = defineWorkflow({
  id: `process.${scenario}`, version: '1', input: value, output: value,
  nodes: [{ kind: 'tool', id: 'write', tool, input: { kind: 'input', path: [] }, approval: scenario === 'approval' }],
  result: { kind: 'step', stepId: 'write', path: [] },
});
const runtime = createWorkflowRuntime({
  store, scope: { principalId: 'test-operator', projectId: 'process-recovery' },
  permissions: { allow: ['tool:process.write', 'effect:write'] },
  policyVersion: 'process-policy-1', maxCostMicros: 10,
  verifyHuman: async (credential) => {
    if (credential !== 'fixture-human-credential') throw new Error('Invalid fixture human.');
    return { id: 'verified-reviewer', projectId: 'process-recovery', canApprove: true };
  },
});

try {
  await store.initialize();
  if (action === 'start') {
    const run = await runtime.submit(definition, { input: { value: 7 }, idempotencyKey: `process-${scenario}` });
    const state = await runtime.runUntilSettled(definition, run.id);
    if (scenario !== 'approval' || state.status !== 'waiting') throw new Error('Unexpected pre-crash state.');
    await notify({ kind: 'waiting', runId: run.id, digest: state.steps.write.approval.digest, snapshot: state });
    // The SQLite worker and IPC channel keep this deliberately paused process alive.
    await new Promise(() => {});
  } else {
    if (!existingRunId) throw new Error('Recovery requires the original run identifier.');
    const before = await runtime.inspect(existingRunId);
    if (scenario === 'approval') {
      if (before.steps.write.approval?.digest !== reviewedDigest) throw new Error('The persisted review digest changed.');
      await runtime.approve({ id: existingRunId, nodeId: 'write', digest: reviewedDigest, credential: 'fixture-human-credential' });
    } else {
      // Parent has awaited the killed child's exit: worker abandonment is established externally.
      await runtime.recoverAbandoned(existingRunId);
    }
    const snapshot = await runtime.runUntilSettled(definition, existingRunId);
    const repeated = await runtime.runUntilSettled(definition, existingRunId);
    const events = await runtime.events(existingRunId);
    await notify({ kind: 'completed', runId: existingRunId, before, snapshot, repeated, events });
    runtime.close();
    await store.close();
    process.disconnect();
  }
} catch (error) {
  // Only a generic diagnostic leaves the fixture, matching the production error boundary.
  await notify({ kind: 'fixture_error', code: error?.code ?? 'FIXTURE_FAILED' }).catch(() => {});
  runtime.close();
  await store.close().catch(() => {});
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
