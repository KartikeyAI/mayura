import { Budget } from '@mayura/core';
import { createCodeMode, defineCodeProgram, defineSandboxAdapter } from '@mayura/code-mode';
import { createDurableCodeAudit, defineDurableCodeWorkflow } from '@mayura/code-mode-workflows';
import { defineTool, invokeTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime } from '@mayura/workflows';
import { createPostgresStore, createSqliteStore } from '@mayura/storage';

const config = JSON.parse(process.argv[2] ?? 'null');
const sqlite = config?.adapter === 'sqlite' && typeof config.filename === 'string' && config.filename.includes('mayura-code-phase-crash-');
const postgres = config?.adapter === 'postgres' && typeof config.schema === 'string'
  && /^mayura_code_phase_crash_[a-f0-9]{32}$/.test(config.schema) && typeof process.env.MAYURA_TEST_POSTGRES_URL === 'string';
if ((!sqlite && !postgres) || !['effect', 'receipt', 'completion'].includes(config.scenario) || !process.send) throw new Error('Invalid fixture.');
const notify = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const schema = { '~standard': { version: 1, vendor: 'crash-fixture', validate: value => value && typeof value === 'object'
  && typeof value.value === 'number' ? { value } : { issues: [{ message: 'invalid' }] } } };
const limits = { cpuMillis: 100, wallTimeMillis: 120_000, memoryBytes: 16 * 1_024 * 1_024, scratchBytes: 1_024,
  maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 2, maxToolConcurrency: 1 };
let effects = 0;
const nested = defineTool({ id: 'external.crash-write', version: '1', description: 'Controlled crash write.', input: schema, output: schema,
  effects: 'write', capabilities: [], costMicros: 3, execute: input => { effects++; return input; } });
const program = defineCodeProgram({ id: 'crash.phase', version: '1', intent: 'Durable crash phase.', language: 'javascript',
  source: 'async (input, tools) => (await tools.call("external.crash-write", input)).output', input: schema, output: schema,
  inputSchemaId: 'crash.in', outputSchemaId: 'crash.out', tools: [nested], limits });
const adapter = defineSandboxAdapter({ id: 'test.crash-phase', version: '1', qualification: 'test', isAvailable: () => true,
  execute: async request => {
    const result = await request.tools.call('external.crash-write', request.input);
    if (config.scenario === 'effect') { await notify({ kind: 'checkpoint', scenario: config.scenario, effects }); return new Promise(() => {}); }
    return result.status === 'succeeded' ? { status: 'succeeded', output: result.output } : { status: 'failed' };
  } });
const budget = new Budget(3, 1);
const mode = createCodeMode({ adapter, allowTestAdapter: true, invokeTool: (tool, input, context) => invokeTool(tool, input, {
  runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
  permissions: { allow: [`tool:${tool.id}`, 'effect:write'] }, budget,
}) });
const store = sqlite ? createSqliteStore({ filename: config.filename })
  : createPostgresStore({ connectionString: process.env.MAYURA_TEST_POSTGRES_URL, schema: config.schema });
const audit = createDurableCodeAudit({ store, scope: { principalId: 'crash-user', projectId: 'project' } });
const definition = defineDurableCodeWorkflow({ id: 'crash.code', version: '1', input: schema, output: schema, codeMode: mode, audit,
  phases: [{ id: 'execute', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'execute', path: [] } });
const phase = definition.nodes[0]; if (!phase || phase.kind !== 'tool') throw new Error('Invalid fixture phase.');
let checkpointed = false;
const workflows = Object.freeze({
  ...store.workflows,
  async recordReceipt(command) {
    const result = await store.workflows.recordReceipt(command);
    if (config.scenario === 'receipt' && !checkpointed) {
      checkpointed = true; await notify({ kind: 'checkpoint', scenario: config.scenario, effects }); return new Promise(() => {});
    }
    return result;
  },
  async complete(command) {
    const result = await store.workflows.complete(command);
    if (config.scenario === 'completion' && !checkpointed) {
      checkpointed = true; await notify({ kind: 'checkpoint', scenario: config.scenario, effects }); return new Promise(() => {});
    }
    return result;
  },
});
const instrumentedStore = Object.freeze({ ...store, workflows });
const runtime = createScheduledWorkflowRuntime({ store: instrumentedStore, scope: { principalId: 'crash-user', projectId: 'project' },
  permissions: { allow: [`tool:${phase.tool.id}`, 'effect:write', ...phase.tool.capabilities] },
  policyVersion: '1', maxCostMicros: 6, maxOutputBytes: 1_024, workerId: 'crash-child', leaseMs: 1_000,
  verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: true }) });
try {
  await store.initialize();
  const submitted = await runtime.submit(definition, { input: { value: 1 }, idempotencyKey: 'crash' });
  const waiting = await runtime.runUntilSettled(definition, submitted.id);
  await runtime.approve({ id: submitted.id, nodeId: 'execute', digest: waiting.steps.execute.approval.digest, credential: 'trusted' });
  await notify({ kind: 'run', runId: submitted.id });
  await runtime.runUntilSettled(definition, submitted.id);
  throw new Error('Expected process checkpoint was not reached.');
} catch {
  await notify({ kind: 'fixture-error' }).catch(() => {});
  await runtime.close().catch(() => {}); await store.close().catch(() => {});
  process.exitCode = 1; if (process.connected) process.disconnect();
}
