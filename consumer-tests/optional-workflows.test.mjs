import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { composeExternalEffectVerifiers, defineExternalEffectVerifier, defineWorkflow } from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHumanTransport, defineWorkflowLifecycle, lifecycleManifest } from '@mayura/workflows/lifecycle';
import { StorageError } from '@mayura/storage-contracts';

const root = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/tools', '@mayura/runtime', '@mayura/workflows', '@mayura/workflows/ephemeral', '@mayura/workflows/lifecycle', '@mayura/storage-contracts']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Workflow consumer escaped its archive installation.');
}
// Check from the isolated consumer's own resolution boundary, not an ancestor workspace.
for (const name of ['@mayura/storage', 'better-sqlite3', 'pg', 'hono', '@hono/node-server']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@mayura/workflows/src/definition.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(new StorageError('CONFLICT', 'Safe fixture.').code, 'CONFLICT');

const number = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };
const input = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'string' ? { value: value.length } : { issues: [] } } };
const output = { '~standard': { version: 1, vendor: 'consumer', validate: value => Array.isArray(value) && value.every(item => typeof item === 'number') ? { value: { values: value } } : { issues: [] } } };
const lifecycleOutput = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value: { answer: value } } : { issues: [] } } };
let effects = 0;
const left = defineTool({ id: 'consumer.left', version: '1', description: 'Double a number.', input: number, output: number, effects: 'none', capabilities: [], execute: value => { effects++; return value * 2; } });
const right = defineTool({ id: 'consumer.right', version: '1', description: 'Increment a number.', input: number, output: number, effects: 'none', capabilities: [], execute: value => { effects++; return value + 1; } });
const definition = defineWorkflow({ id: 'consumer.graph', version: '1', input, output, nodes: [
  { id: 'left', kind: 'tool', tool: left, input: { kind: 'input', path: [] } },
  { id: 'right', kind: 'tool', tool: right, input: { kind: 'input', path: [] } },
  { id: 'joined', kind: 'join', dependsOn: ['left', 'right'] },
], result: { kind: 'step', stepId: 'joined', path: [] } });
const lifecycle = defineWorkflowLifecycle({ id: 'consumer.lifecycle', version: '1', input, output: lifecycleOutput, nodes: [
  { kind: 'human', id: 'review', request: { kind: 'information', schemaId: 'consumer/response',
    schemaDigest: 'a'.repeat(64), prompt: 'Review.', response: number } },
], result: { kind: 'step', stepId: 'review', path: [] } });
assert.equal(lifecycle.format, 5); assert.equal(lifecycleManifest(lifecycle).graph[0].kind, 'human');
assert(!JSON.stringify(lifecycleManifest(lifecycle)).includes('validate'));
const records = new Map();
const lifecycleStore = {
  async initialize() {},
  async create(command) {
    const key = `${command.scope}/${command.id}`; const found = records.get(key);
    if (found) return { record: structuredClone(found), created: false };
    const record = { scope: command.scope, id: command.id, idempotencyKey: command.idempotencyKey,
      definitionHash: command.definitionHash, version: 1, state: structuredClone(command.state) };
    records.set(key, record); return { record: structuredClone(record), created: true };
  },
  async read(scope, id) { const found = records.get(`${scope}/${id}`); return found ? structuredClone(found) : undefined; },
  async update(command) {
    const key = `${command.scope}/${command.id}`; const found = records.get(key);
    assert(found && found.version === command.expectedVersion); const next = { ...found, version: found.version + 1, state: structuredClone(command.state) };
    records.set(key, next); return structuredClone(next);
  },
  async events() { return []; }, async close() {},
};
const lifecycleRuntime = createWorkflowLifecycleFleetRuntime({ store: lifecycleStore, scope: { principalId: 'consumer', projectId: 'project' },
  permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0,
  verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: false }) });
const lifecycleRun = await lifecycleRuntime.submit(lifecycle, { input: 'abc', idempotencyKey: 'lifecycle' });
const lifecycleWaiting = await lifecycleRuntime.runUntilSettled(lifecycle, lifecycleRun.id);
const lifecycleRequest = lifecycleWaiting.steps.review.requestDigest;
let lifecycleCursor = null; let lifecycleDiscovered = false;
for (let page = 0; page < 9 && !lifecycleDiscovered; page++) {
  const discovered = await lifecycleRuntime.scan({ cursor: lifecycleCursor, maxShardReads: 32 });
  lifecycleDiscovered = discovered.candidates.some(candidate => candidate.runId === lifecycleRun.id);
  lifecycleCursor = discovered.nextCursor; if (!lifecycleCursor) break;
}
assert.equal(lifecycleDiscovered, true);
const humanController = createWorkflowLifecycleHumanTransport({ scope: { principalId: 'consumer', projectId: 'project' } });
const [humanRouteId] = humanController.register({ agentId: 'consumer', definition: lifecycle, runtime: lifecycleRuntime, runId: lifecycleRun.id });
const humanPage = await humanController.transport.list({ scope: { principalId: 'consumer', projectId: 'project' }, agentIds: ['consumer'], after: null, limit: 10, signal: new AbortController().signal });
assert.equal(humanPage.items[0].id, humanRouteId); assert.equal(humanPage.items[0].digest, lifecycleRequest);
await humanController.transport.respond({ scope: { principalId: 'consumer', projectId: 'project' }, agentIds: ['consumer'], actorId: 'reviewer',
  id: humanRouteId, requestDigest: lifecycleRequest, commandId: 'answer', value: 3, signal: new AbortController().signal });
assert.equal((await lifecycleRuntime.runUntilSettled(lifecycle, lifecycleRun.id)).status, 'succeeded');
lifecycleRuntime.close();
const childPermissions = { allow: ['model:mayura.workflow', 'tool:consumer.left', 'tool:consumer.right'] };
const runtime = createRuntime({ profile: 'ephemeral', permissions: childPermissions });
try {
  const handle = runtime.submit(workflowAsAgent(definition, { profile: 'ephemeral' }), { input: 'abc' });
  assert.deepEqual(await handle.result(), { status: 'succeeded', output: { values: [6, 4] } });
  assert.equal(runtime.inspect(handle).budget.calls, 4); assert.equal(effects, 2);
} finally { await runtime.close(); }

const wrapped = workflowAsTool(definition, { profile: 'ephemeral', id: 'consumer.workflow', description: 'Delegate a finite graph.', permissions: childPermissions });
const parent = defineAgent({ id: 'consumer.parent', version: '1', instructions: 'PRIVATE_WORKFLOW_PARENT', input: number, output: { '~standard': { version: 1, vendor: 'consumer', validate: value => ({ value }) } }, tools: [wrapped],
  model: { id: 'consumer.parent-model', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, async generate(request) {
    const last = request.messages.at(-1);
    return last.role === 'tool' ? { type: 'final', output: last.result, usage: { costMicros: 0 } }
      : { type: 'tool_calls', calls: [{ id: 'graph-1', toolId: 'consumer.workflow', input: 'abcd' }], usage: { costMicros: 0 } };
  } },
});
const family = createRuntime({ profile: 'ephemeral', permissions: { allow: [...childPermissions.allow, 'agent:delegate', 'model:consumer.parent-model', 'tool:consumer.workflow'] }, limits: { maxConcurrentOperations: 1 } });
try {
  const handle = family.submit(parent, { input: 2 }); const result = await handle.result();
  assert.equal(result.status, 'succeeded'); assert.deepEqual(result.output, { values: [8, 5] });
  assert.equal(family.inspect(handle).runs.length, 2); assert.equal(effects, 4);
  assert(!JSON.stringify(family.inspect(handle)).includes('PRIVATE'));
} finally { await family.close(); }
const verifier = defineExternalEffectVerifier({ authorityId: 'consumer.provider', toolId: 'consumer.left', toolVersion: '1',
  verify: async (request, credential) => {
    assert.deepEqual(credential, { token: 'opaque' });
    return { attestationId: `consumer/${request.jobId}`, execution: 'succeeded', knownCostMicros: request.maximumCostMicros };
  } });
const verification = await composeExternalEffectVerifiers([verifier])({ runId: 'run', definitionHash: 'a'.repeat(64), nodeId: 'left',
  jobId: 'job', fence: 1, callId: 'run/step:left', toolId: 'consumer.left', toolVersion: '1', maximumCostMicros: 0,
  scope: { principalId: 'consumer', projectId: 'project' } }, { token: 'opaque' });
assert.deepEqual(verification, { authorityId: 'consumer.provider', attestationId: 'consumer/job', execution: 'succeeded', knownCostMicros: 0 });
console.log(JSON.stringify({ status: 'passed', graphEffects: effects, transformedForkJoin: true, requiredChildComposition: true,
  verifierRouter: true, lifecycleManifest: true, lifecycleRuntime: true, lifecycleFleet: true, lifecycleHumanTransport: true, sqlDriversInstalled: false }));
