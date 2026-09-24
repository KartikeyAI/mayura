import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { createQuickJsSandboxAdapter } from '@mayura/adapter-code-quickjs';
import { createCodeMode, defineCodeProgram } from '@mayura/code-mode';
import { createDurableCodeAudit, defineDurableCodeWorkflow } from '@mayura/code-mode-workflows';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { invokeTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime } from '@mayura/workflows';

type Value = { readonly value: number };
const schema: Schema<Value, Value> = { '~standard': { version: 1, vendor: 'starter', validate: value => value && typeof value === 'object'
  && typeof (value as Value).value === 'number' ? { value: value as Value } : { issues: [{ message: 'Expected value.' }] } } };
const program = defineCodeProgram({ id: 'starter.code-phase', version: '1.0.0', intent: 'Perform an isolated deterministic calculation.', language: 'javascript',
  source: 'input => ({ value: input.value + 1 })', input: schema, output: schema, inputSchemaId: 'value.v1', outputSchemaId: 'value.v1',
  limits: { cpuMillis: 100, wallTimeMillis: 2_000, memoryBytes: 16_777_216, scratchBytes: 1_024, maxInputBytes: 1_024,
    maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 1, maxToolConcurrency: 1 } });
const budget = new Budget(0, 1);
const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), allowTestAdapter: true, invokeTool: (tool, input, context) => invokeTool(tool, input, {
  runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal, permissions: { allow: [`tool:${tool.id}`] }, budget,
}) as Promise<Outcome<JsonValue>> });
const storage = createSqliteStore({ filename: ':memory:' }); await storage.initialize();
const audit = createDurableCodeAudit({ store: storage, scope: { principalId: 'local', projectId: 'starter' } });
const workflow = defineDurableCodeWorkflow({ id: 'starter.code-mode-workflow', version: '1.0.0', input: schema, output: schema, codeMode: mode, audit,
  phases: [{ id: 'calculate', program, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'calculate', path: [] } });
const node = workflow.nodes[0]!; if (node.kind !== 'tool') throw new Error('Expected Code Mode tool phase.');
const runtime = createScheduledWorkflowRuntime({ store: storage, workerId: 'starter-worker', scope: { principalId: 'local', projectId: 'starter' },
  permissions: { allow: [`tool:${node.tool.id}`, ...node.tool.capabilities] }, policyVersion: '1', maxCostMicros: node.tool.costMicros,
  verifyHuman: async credential => { if (credential !== 'local-review') throw new Error('Denied.'); return { id: 'reviewer', projectId: 'starter', canApprove: true }; } });
try {
  const submitted = await runtime.submit(workflow, { input: { value: 41 }, idempotencyKey: 'starter-code' });
  const waiting = await runtime.runUntilSettled(workflow, submitted.id); const approval = waiting.steps['calculate']?.approval;
  if (!approval || typeof approval !== 'object' || Array.isArray(approval) || typeof approval.digest !== 'string') throw new Error('Expected Code Mode approval.');
  await runtime.approve({ id: waiting.id, nodeId: 'calculate', digest: approval.digest, credential: 'local-review' });
  console.log(JSON.stringify(await runtime.runUntilSettled(workflow, waiting.id)));
} finally { await runtime.close(); await storage.close(); }
