import { createSqliteStore } from 'mayura/storage-sqlite';
import { defineTool } from 'mayura/tools';
import { createScheduledWorkflowRuntime, defineWorkflow } from 'mayura/workflows';
import { z } from 'zod';

let executions = 0; const schema = z.number().int().min(0).max(1_000);
const tool = defineTool({ id: 'records.approved-write', version: '1.0.0', description: 'Approval-gated local write fixture.',
  input: schema, output: schema, effects: 'write', capabilities: ['records:write'], costMicros: 1,
  execute: value => { executions++; return value + 1; } });
const workflow = defineWorkflow({ id: 'starter.durable-approval', version: '1.0.0', input: schema, output: schema,
  nodes: [{ kind: 'tool', id: 'approvedWrite', tool, input: { kind: 'input', path: [] }, approval: true }],
  result: { kind: 'step', stepId: 'approvedWrite', path: [] } });
const storage = createSqliteStore({ filename: ':memory:' }); await storage.initialize();
const runtime = createScheduledWorkflowRuntime({ store: storage, workerId: 'starter-worker', scope: { principalId: 'local', projectId: 'starter' },
  permissions: { allow: ['tool:records.approved-write', 'records:write', 'effect:write'] }, policyVersion: '1', maxCostMicros: 1,
  verifyHuman: async credential => { if (credential !== 'local-review') throw new Error('Denied.'); return { id: 'reviewer', projectId: 'starter', canApprove: true }; } });
try {
  const submitted = await runtime.submit(workflow, { input: 41, idempotencyKey: 'starter-run' });
  const waiting = await runtime.runUntilSettled(workflow, submitted.id); const approval = waiting.steps['approvedWrite']?.approval;
  if (!approval || typeof approval !== 'object' || Array.isArray(approval) || typeof approval.digest !== 'string' || executions !== 0) {
    throw new Error(`Expected exact approval wait: ${JSON.stringify({ waiting, executions })}`);
  }
  await runtime.approve({ id: waiting.id, nodeId: 'approvedWrite', digest: approval.digest, credential: 'local-review' });
  const result = await runtime.runUntilSettled(workflow, waiting.id); console.log(JSON.stringify({ status: result.status, output: result.output, executions }));
} finally { await runtime.close(); await storage.close(); }
