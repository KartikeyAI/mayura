import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineWorkflowGraph, createWorkflowGraphRuntime, createWorkflowGraphDiscovery, createWorkflowGraphCoordinator } from '@mayura/workflows/graphs';
import { defineWorkflow, createScheduledWorkflowRuntime } from '@mayura/workflows';
import { workflowHashMaterial, workflowPolicy, initialWorkflowGraphState } from '@mayura/storage-contracts';

for (const name of ['@mayura/storage', '@mayura/storage-sql', '@mayura/storage-sqlite', '@mayura/storage-postgres', 'better-sqlite3', 'pg']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/workflows/src/graph-definition.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/workflows/src/graph-discovery.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/workflows/src/graph-coordinator.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const digest = (domain, value) => createHash('sha256').update(workflowHashMaterial(domain, value)).digest('hex');
const schema = { '~standard': { version: 1, vendor: 'consumer', validate: value => ({ value }) } };
const input = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'string' ? { value: JSON.parse(value) } : { issues: [] } } };
const scope = { principalId: 'consumer', projectId: 'app' };
const policy = workflowPolicy({ scope, permissions: [], policyVersion: '1', maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 3_600_000 });
const scopeKey = digest('mayura:scope:v1', scope); const policyHash = digest('mayura:policy:v1', policy);
const target = { kind: 'scheduled-workflow', runId: 'a'.repeat(64), definitionHash: 'b'.repeat(64), policyHash };
const definition = defineWorkflowGraph({ id: 'consumer.wait', version: '1', input, output: schema,
  nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'observe', path: [] } });
let current; let ready = false; let storageClosed = false; let claims = 0; let inspections = 0; let failInspection = false;
const unexpected = async () => { throw new Error('Unexpected effect or storage operation.'); };
const observation = { reference: target, outcome: 'outcome_unknown', sourceVersion: 4, sourceEventSequence: 8 };
const snapshot = () => structuredClone(current);
// This deliberately minimal custom adapter verifies packed facade behavior, not SQL durability.
const workflowGraphs = {
  initialize: async () => {},
  submit: async command => {
    const id = digest('mayura:run-id:v1', { scope: scopeKey, submissionKey: command.idempotencyKey });
    assert.deepEqual(command.input, [target]);
    const state = initialWorkflowGraphState(command.manifest, command.input, definition.digest, policyHash, 0);
    current = { profile: 'scheduled-v2', manifestHash: definition.digest, policyHash, resourceHash: digest('mayura:workflow-resources:v1', {}), jobs: [],
      record: { scope: scopeKey, id, definitionHash: definition.digest, idempotencyKey: command.idempotencyKey, version: 1, state } };
    return { snapshot: snapshot(), created: true };
  },
  inspect: async () => { inspections++; if (failInspection) throw new Error('PRIVATE fixture adapter detail'); return snapshot(); },
  recover: async () => snapshot(),
  advance: async () => {
    const step = current.record.state.steps.observe;
    if (ready && step.status !== 'succeeded') { step.status = 'succeeded'; step.output = [observation]; current.record.state.status = 'running'; current.record.version++; }
    else if (!ready && step.status === 'pending') { step.status = 'waiting'; current.record.state.status = 'waiting'; current.record.version++; }
    return snapshot();
  },
  claim: async () => { claims++; return []; },
  finalize: async command => { current.record.state.status = 'succeeded'; current.record.state.output = command.output; current.record.version++; return snapshot(); },
  requestApproval: unexpected, approve: unexpected, prepare: unexpected, renew: unexpected, start: unexpected,
  recordReceipt: unexpected, complete: unexpected, abandon: unexpected, failNode: unexpected, cancel: unexpected,
};
const store = { workflowGraphs, initialize: async () => {}, read: async () => current?.record, events: async () => [], close: async () => { storageClosed = true; } };
const options = { store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, workerId: 'consumer', maxConcurrentRuns: 1, maxConcurrentJobs: 1 };
const discoveryOptions = { store, scope, permissions: options.permissions, policyVersion: '1', maxCostMicros: 0 };
assert.throws(() => createWorkflowGraphDiscovery(discoveryOptions), { code: 'UNSUPPORTED_PROFILE' });
const discoveryStore = { ...store, workflowGraphDiscovery: {
  initialize: async () => {},
  scan: async command => {
    assert.equal(command.scope, scopeKey); assert.equal(command.policyHash, policyHash); assert.equal(command.limit, 1);
    if (command.cursor) return { candidates: [], examined: 0, nextCursor: null };
    const reference = { kind: 'scheduled-workflow', runId: current.record.id, definitionHash: definition.digest, policyHash };
    return { candidates: current.record.state.status === 'waiting' ? [{ reference, version: current.record.version, status: 'waiting' }] : [],
      examined: 1, nextCursor: { format: 1, scope: scopeKey, policyHash, afterId: current.record.id } };
  },
} };
const discovery = createWorkflowGraphDiscovery({ ...discoveryOptions, store: discoveryStore });
const coordinatorOptions = { ...discoveryOptions, store: discoveryStore, workerId: 'coordinator', maxConcurrentJobs: 1 };
const coordinator = createWorkflowGraphCoordinator({ ...coordinatorOptions, definitions: [{ definition }] });
const unknown = defineWorkflowGraph({ id: 'consumer.unregistered', version: '1', input: schema, output: schema,
  nodes: [{ kind: 'join', id: 'joined', dependsOn: [] }], result: { kind: 'literal', value: null } });
const unknownCoordinator = createWorkflowGraphCoordinator({ ...coordinatorOptions, definitions: [{ definition: unknown }] });
let runtime = createWorkflowGraphRuntime(options);
assert.equal(runtime.profile, 'scheduled-v2'); assert.equal('attach' in runtime, false);
assert.throws(() => createScheduledWorkflowRuntime(options), { code: 'UNSUPPORTED_PROFILE' });
const legacy = defineWorkflow({ id: 'legacy', version: '1', input: schema, output: schema, nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'input', path: [] } });
assert.throws(() => runtime.runUntilSettled(legacy, 'a'.repeat(64)), { code: 'INVALID_CONFIG' });
try {
  const run = await runtime.submit(definition, { input: JSON.stringify([target]), idempotencyKey: 'one' });
  const waiting = await runtime.runUntilSettled(definition, run.id); assert.equal(waiting.status, 'waiting');
  const discovered = await discovery.scan({ limit: 1 }); assert.equal(discovered.candidates[0].reference.runId, run.id); assert.equal(discovered.examined, 1);
  assert(Object.isFrozen(discovered.candidates[0].reference));
  assert.deepEqual(await discovery.scan({ limit: 1, cursor: discovered.nextCursor }), { candidates: [], examined: 0, nextCursor: null });
  const beforeUnknown = inspections;
  const skipped = await unknownCoordinator.runPage({ limit: 1 });
  assert.equal(skipped.status, 'completed'); assert.equal(skipped.outcomes[0].kind, 'skipped');
  assert.equal(skipped.outcomes[0].reason, 'unregistered_definition'); assert.equal(inspections, beforeUnknown);
  const coordinated = await coordinator.runPage({ limit: 1 });
  assert.equal(coordinated.status, 'completed'); assert.equal(coordinated.examined, 1);
  assert.deepEqual(coordinated.outcomes, [{ kind: 'observed', reference: discovered.candidates[0].reference, version: waiting.version, status: 'waiting' }]);
  assert(Object.isFrozen(coordinated.outcomes[0].reference)); assert(!('output' in coordinated.outcomes[0]));
  const exhausted = await coordinator.runPage({ cursor: coordinated.nextCursor, limit: 1 });
  assert.equal(exhausted.status, 'completed'); assert.equal(exhausted.examined, 0); assert.equal(exhausted.nextCursor, null);
  failInspection = true;
  const interrupted = await coordinator.runPage({ limit: 1 });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.code, 'STORAGE_UNAVAILABLE');
  assert.equal(interrupted.retryCursor, null); assert(!('nextCursor' in interrupted));
  assert.equal(interrupted.outcomes[0].kind, 'failed'); assert(!JSON.stringify(interrupted).includes('PRIVATE'));
  failInspection = false;
  assert.equal((await coordinator.runPage({ cursor: interrupted.retryCursor, limit: 1 })).status, 'completed');
  assert.equal((await runtime.runUntilSettled(definition, run.id)).version, waiting.version);
  await runtime.close(); assert.equal(storageClosed, false); ready = true;
  runtime = createWorkflowGraphRuntime(options);
  const complete = await runtime.runUntilSettled(definition, run.id); assert.equal(complete.status, 'succeeded');
  assert.deepEqual(complete.output, [observation]); assert.equal(complete.budget.spentMicros, 0); assert.equal(current.jobs.length, 0);
  assert.equal((await runtime.reference(run.id)).definitionHash, definition.digest); assert(claims > 0);
  const terminal = await discovery.scan({ limit: 1 }); assert.deepEqual(terminal.candidates, []); assert(terminal.nextCursor);
  const terminalReport = await coordinator.runPage({ limit: 1 });
  assert.equal(terminalReport.status, 'completed'); assert.equal(terminalReport.examined, 1);
  assert.deepEqual(terminalReport.outcomes, []); assert(terminalReport.nextCursor);
} finally { await unknownCoordinator.close(); await coordinator.close(); await discovery.close(); await runtime.close(); }
await assert.rejects(discovery.scan(), { code: 'CANCELLED' });
await assert.rejects(coordinator.runPage(), { code: 'CANCELLED' }); assert.equal(storageClosed, false);
console.log(JSON.stringify({ status: 'passed', driverFree: true, transformedInput: true, graphWaitResumed: true, finiteDiscovery: true,
  finiteCoordinator: true, unknownDefinitionSkipped: true, interruptedRetryCursor: true, terminalCursorProgress: true, unknownPreserved: true, closesCallerStorage: storageClosed }));
