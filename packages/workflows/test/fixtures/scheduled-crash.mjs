import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createPostgresStore, createSqliteStore } from '@mayura/storage';
import { createScheduledWorkflowRuntime, defineWorkflow } from '@mayura/workflows';

// Test-only owned child. Each marker is sent only after the corresponding SQL commit.
const config = JSON.parse(process.argv[2] ?? 'null');
if (!config || !['start', 'receipt', 'complete'].includes(config.stage) || !process.send) throw new Error('Invalid scheduled crash fixture.');
const stage = config.stage;
const backend = config.backend;
if (backend.kind === 'postgres' && !/^mayura_scheduled_workflow_[a-f0-9]{32}$/.test(backend.schema)) throw new Error('Unexpected disposable schema.');
if (backend.kind === 'sqlite' && !backend.filename.includes('mayura-scheduled-workflows-')) throw new Error('Unexpected disposable database.');
const store = backend.kind === 'sqlite' ? createSqliteStore({ filename: backend.filename })
  : createPostgresStore({ connectionString: backend.connectionString, schema: backend.schema });
let effects = 0;
const notify = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const pause = async runId => {
  await notify({ kind: 'checkpoint', stage, runId, effects });
  return await new Promise(() => {});
};
const value = z.object({ value: z.number() });
const action = defineTool({
  id: 'scheduled.write', version: '1', description: 'Controlled scheduled crash effect',
  input: value, output: z.unknown(), effects: 'write', capabilities: [], costMicros: 3, timeoutMs: 120_000,
  execute: input => { effects++; return input; },
  ...(stage === 'receipt' ? { guards: { output: [{ id: 'checkpoint', check: async (_output, context) => pause(context.runId) }] } } : {}),
});
const definition = defineWorkflow({
  id: 'scheduled.workflow', version: '1', input: value, output: z.unknown(),
  nodes: [{ kind: 'tool', id: 'write', tool: action, input: { kind: 'input', path: [] }, approval: false }],
  result: { kind: 'step', stepId: 'write', path: [] },
});
const underlying = store.workflows;
const wrapped = { ...store, workflows: { ...underlying,
  start: async command => {
    const result = await underlying.start(command);
    if (stage === 'start' && result.status === 'started') await pause(command.id);
    return result;
  },
  complete: async command => {
    const result = await underlying.complete(command);
    if (stage === 'complete') await pause(command.id);
    return result;
  },
} };
const runtime = createScheduledWorkflowRuntime({
  store: wrapped, ...config.options, workerId: 'controlled-crash-worker', leaseMs: 1_000,
});
try {
  await store.initialize();
  const run = await runtime.submit(definition, { input: { value: 2 }, idempotencyKey: `process-${stage}` });
  await runtime.runUntilSettled(definition, run.id);
  throw new Error('Expected crash checkpoint was not reached.');
} catch {
  await notify({ kind: 'fixture-error' }).catch(() => {});
  await runtime.close().catch(() => {}); await store.close().catch(() => {});
  process.exitCode = 1; if (process.connected) process.disconnect();
}
