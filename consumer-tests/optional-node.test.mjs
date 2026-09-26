import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Budget, batchOutput, createRuntime, defineAgent, defineTool, invokeBatch } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { listenAgentServer } from '@mayura/server-node';
import { createClient } from '@mayura/client';
import { createObserver } from '@mayura/observability';
import { createLocalArtifactStore } from '@mayura/artifacts';

const root = await realpath(process.cwd());
for (const name of ['@mayura/sdk', '@mayura/core', '@mayura/tools', '@mayura/runtime', '@mayura/testing', '@mayura/server', '@mayura/server-node', '@mayura/client', '@mayura/observability', '@mayura/artifacts', 'hono', '@hono/node-server']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Runtime import escaped the packed consumer installation.');
}
for (const name of ['@mayura/client', '@mayura/server-node', '@mayura/observability']) {
  await assert.rejects(import(`${name}/src/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  await assert.rejects(import(`${name}/dist/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}

const number = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };
const record = { '~standard': { version: 1, vendor: 'consumer', validate: value => value && typeof value === 'object' && typeof value.result === 'number' ? { value } : { issues: [] } } };
const batchSource = defineTool({ id: 'consumer.batch-source', version: '1', description: 'Produce a nested result.', input: number, output: record,
  effects: 'none', capabilities: [], execute: value => ({ result: value * 2 }) });
const batchTarget = defineTool({ id: 'consumer.batch-target', version: '1', description: 'Consume a referenced result.', input: number, output: number,
  effects: 'none', capabilities: [], execute: value => value + 1 });
const batch = await invokeBatch([
  { id: 'target', tool: batchTarget, input: batchOutput('source', ['result']) },
  { id: 'source', tool: batchSource, input: 2 },
], { runId: 'consumer.batch', scope: { principalId: 'consumer', projectId: 'fixture' },
  permissions: { allow: ['tool:consumer.batch-source', 'tool:consumer.batch-target'] }, budget: new Budget(0, 2), signal: new AbortController().signal });
assert.equal(batch[0].outcome.status, 'succeeded'); assert.equal(batch[0].outcome.output, 5);
function agent(id) {
  return defineAgent({ id, version: '1', instructions: 'PRIVATE_CONSUMER_PROMPT', input: number, output: number, tools: [],
    model: scriptedModel([{ type: 'final', output: 4, usage: { costMicros: 0 } }]),
  });
}
const permissions = { allow: ['model:scripted'] };
const runtime = createRuntime({ profile: 'ephemeral', permissions });
const observer = createObserver();
let observationReport;
try {
  const handle = runtime.submit(agent('consumer.observed'), { input: 2 });
  const observation = observer.observe(handle);
  assert.equal((await observation.done()).reason, 'terminal');
  assert.equal((await handle.result()).status, 'succeeded');
  const summary = observer.inspect(handle.id);
  assert.equal(summary.status, 'succeeded'); assert.equal(summary.coverage, 'complete');
  assert.equal(summary.counters.modelCompleted, 1); assert.equal(summary.cost.calls, 1);
  assert(!JSON.stringify(observer.inspect()).includes('PRIVATE'));
  assert(Object.isFrozen(summary)); assert(Object.isFrozen(summary.recent));
  observationReport = { status: summary.status, events: summary.counters.events, coverage: summary.coverage };
} finally { await observer.close(); await runtime.close(); }

let arrivals = 0; let markStarted; let releaseParallel;
const bothStarted = new Promise(resolve => { markStarted = resolve; });
const parallelGate = new Promise(resolve => { releaseParallel = resolve; });
const parallelModel = id => ({ id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => {
  arrivals++; if (arrivals === 2) markStarted(); await parallelGate; return { type: 'final', output: 7, usage: { costMicros: 0 } };
} });
const matrixRuntime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['agent:delegate', 'model:parent', 'model:parallel'] }, limits: { maxConcurrentOperations: 2 } });
let parallelChildren = false; let progressInspected = false; let policyEnforced = false; let artifactInspected = false;
const artifactDirectory = await mkdtemp(join(tmpdir(), 'mayura-v18-consumer-'));
try {
  const parent = matrixRuntime.submit(defineAgent({ id: 'matrix.parent', version: '1', instructions: 'parent', input: number, output: number, tools: [],
    model: { id: 'parent', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } }) } }), { input: 1 });
  const childDefinition = defineAgent({ id: 'matrix.child', version: '1', instructions: 'child', input: number, output: number, tools: [], model: parallelModel('parallel') });
  const childPermissions = { allow: ['model:parallel'] };
  const left = matrixRuntime.spawn(parent, childDefinition, { input: 2, permissions: childPermissions });
  const right = matrixRuntime.spawn(parent, childDefinition, { input: 3, permissions: childPermissions });
  await bothStarted; const progress = matrixRuntime.inspect(parent); progressInspected = progress.runs.length === 3;
  releaseParallel(); const joined = await Promise.all([left.result(), right.result(), parent.result()]);
  parallelChildren = joined.every(outcome => outcome.status === 'succeeded');

  let hostEffects = 0;
  const hostTool = defineTool({ id: 'matrix.host', version: '1', description: 'Denied host operation.', input: number, output: number,
    effects: 'host', capabilities: [], execute: value => { hostEffects++; return value; } });
  const deniedRuntime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:denied', 'tool:matrix.host'] } });
  try {
    const denied = deniedRuntime.submit(defineAgent({ id: 'matrix.denied', version: '1', instructions: 'request denied host tool', input: number, output: number, tools: [hostTool],
      model: { id: 'denied', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'tool_calls', calls: [{ id: 'host-1', toolId: 'matrix.host', input: 1 }], usage: { costMicros: 0 } }) } }), { input: 1 });
    policyEnforced = (await denied.result()).status === 'blocked' && hostEffects === 0;
  } finally { await deniedRuntime.close(); }

  const artifactStore = createLocalArtifactStore({ rootDirectory: artifactDirectory, maxArtifactBytes: 1_024 });
  const artifactScope = { tenantId: 'external', projectId: 'consumer' };
  const reference = await artifactStore.commit(await artifactStore.stage({ scope: artifactScope, content: new TextEncoder().encode('parallel report'), mediaType: 'text/plain', classification: 'internal' }));
  artifactInspected = (await artifactStore.audit([reference], artifactScope, { maxTotalBytes: 1_024 })).observations[0]?.status === 'ok';
} finally { await matrixRuntime.close(); await rm(artifactDirectory, { recursive: true, force: true }); }
const externalConsumerMatrix = parallelChildren && progressInspected && policyEnforced && artifactInspected;

const secret = randomBytes(32); const token = secret.toString('hex'); const expiresAtMs = Date.now() + 30_000;
const humanDigest = 'a'.repeat(64); const humanRequest = { id: 'review', agentId: 'consumer.http', kind: 'plan_selection', schemaId: 'choice-v1',
  schemaDigest: 'b'.repeat(64), prompt: 'Select the packed consumer plan.', digest: humanDigest, status: 'waiting' };
const workflowRunId = 'c'.repeat(64); const workflowView = { format: 4, definitionId: 'consumer-workflow', definitionVersion: '1', runId: workflowRunId,
  revision: 1, status: 'running', nodes: [{ id: 'step', kind: 'tool', dependsOn: [] }], steps: [{ id: 'step', kind: 'tool', status: 'pending' }] };
let humanActor;
const globals = { Request, Response, fetch };
const server = await listenAgentServer({
  agents: [{ agent: agent('consumer.http'), permissions }], shutdownGraceMs: 100, publicLiveness: true,
  healthChecks: [{ id: 'consumer', check: ({ signal, scope }) => !signal.aborted && scope.projectId === 'consumer-project' }],
  humanRequests: { list: async () => ({ items: [humanRequest], next: null }), inspect: async () => humanRequest,
    respond: async input => { humanActor = input.actorId; return { ...humanRequest, status: 'answered' }; } },
  workflowViews: { inspect: async input => input.runId === workflowRunId ? workflowView : null },
  workflowIndex: { list: async () => ({ items: [{ format: workflowView.format, definitionId: workflowView.definitionId,
    definitionVersion: workflowView.definitionVersion, runId: workflowView.runId, revision: workflowView.revision, status: workflowView.status }], next: null }) },
  workflowControls: { cancel: async input => ({ status: 'applied', workflow: { ...workflowView, revision: input.revision + 1, status: 'cancelled' } }),
    approve: async input => ({ status: 'applied', workflow: { ...workflowView, revision: input.revision + 1 } }) },
  workflowSignals: { deliver: async input => ({ status: 'applied', workflow: { ...workflowView, revision: input.revision + 1 } }) },
  workflowResumes: { resume: async input => ({ status: 'applied', workflow: { ...workflowView, revision: input.revision + 1 } }) },
  workflowPauses: { pause: async input => ({ status: 'applied', workflow: { ...workflowView, revision: input.revision + 1, status: 'paused' } }) },
  workflowFleet: { inspect: async () => ({ held: false, generation: 0, changedAtMs: null }), hold: async () => ({ held: true, generation: 1, changedAtMs: 1 }),
    release: async () => ({ held: false, generation: 1, changedAtMs: 2 }),
    sweep: async input => ({ status: 'applied', sweep: { outcomes: [{ target: 'lifecycle', runId: workflowRunId, outcome: input.phase === 'pause' ? 'paused' : 'resumed' }], nextCursor: null } }) },
  authenticate: async ({ token: supplied, signal }) => {
    if (signal.aborted || expiresAtMs <= Date.now() || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), secret)) return null;
    return { scope: { principalId: 'consumer-user', projectId: 'consumer-project' }, agentIds: ['consumer.http'], capabilities: ['runs:read', 'runs:submit', 'operations:read', 'humans:read', 'humans:respond', 'workflows:read', 'workflows:control', 'workflows:fleet'], expiresAtMs };
  },
});
let httpReport;
try {
  assert.equal(new URL(server.origin).hostname, '127.0.0.1');
  assert.deepEqual(await (await fetch(new URL('/healthz', server.origin))).json(), { status: 'ok' });
  const operationalHeaders = { authorization: `Bearer ${token}` };
  assert.deepEqual(await (await fetch(new URL('/v1/operations/health', server.origin), { headers: operationalHeaders })).json(),
    { status: 'ready', checks: [{ id: 'server', status: 'ready' }, { id: 'consumer', status: 'ready' }] });
  assert.deepEqual(await (await fetch(new URL('/v1/tools?limit=1', server.origin), { headers: operationalHeaders })).json(), { tools: [], next: null });
  const client = createClient({ baseUrl: server.origin, token: () => token, requestTimeoutMs: 3_000 });
  assert.deepEqual(await client.agents(), [{ id: 'consumer.http', version: '1' }]);
  assert.deepEqual((await client.humanRequests({ limit: 1 })).items, [humanRequest]);
  assert.equal((await client.respondHumanRequest('review', humanDigest, { choice: 'accept' }, { commandId: 'packed-answer' })).status, 'answered');
  assert.deepEqual(await client.workflow(workflowRunId), workflowView);
  assert.equal((await client.workflows({ limit: 1 })).items[0].runId, workflowRunId);
  assert.equal((await client.cancelWorkflow(workflowRunId, 1, { commandId: 'packed-cancel' })).status, 'cancelled');
  assert.equal((await client.approveWorkflow(workflowRunId, { revision: 2, nodeId: 'step', approvalDigest: 'd'.repeat(64) },
    { commandId: 'packed-approve' })).revision, 3);
  assert.equal((await client.signalWorkflow(workflowRunId, { revision: 3, signalId: 'ready/1', signalName: 'ready', value: { accepted: true } },
    { commandId: 'packed-signal' })).revision, 4);
  assert.equal((await client.resumeWorkflow(workflowRunId, 4, { commandId: 'packed-resume' })).revision, 5);
  assert.equal((await client.pauseWorkflow(workflowRunId, 5, { commandId: 'packed-pause' })).status, 'paused');
  assert.equal((await client.holdWorkflowFleet()).held, true);
  assert.equal((await client.sweepWorkflowFleet('pause', { cursor: null })).outcomes[0].outcome, 'paused');
  assert.equal((await client.releaseWorkflowFleet()).held, false); assert.equal((await client.workflowFleet()).generation, 0);
  assert.equal(humanActor, 'consumer-user');
  const denied = createClient({ baseUrl: server.origin, token: () => 'incorrect' });
  await assert.rejects(denied.agents(), { code: 'HTTP_ERROR', status: 401 });
  const run = await client.submit('consumer.http', 2, { idempotencyKey: 'packed-consumer' });
  const events = await Array.fromAsync(run.events());
  assert.equal(events.at(-1).type, 'run.completed');
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  const result = await run.result(number); assert.deepEqual(result, { status: 'succeeded', output: 4, evidence: [] });
  assert.equal((await client.submit('consumer.http', 2, { idempotencyKey: 'packed-consumer' })).id, run.id);
  assert(!JSON.stringify({ result, events }).includes(token)); assert(!JSON.stringify({ result, events }).includes('PRIVATE'));
  assert.equal(globalThis.Request, globals.Request); assert.equal(globalThis.Response, globals.Response); assert.equal(globalThis.fetch, globals.fetch);
  httpReport = { status: result.status, events: events.length, explicitRetryDeduplicated: true, operationalSurface: true, humanTransport: true,
    workflowTransport: true, workflowIndex: true, workflowControls: true, workflowSignals: true, workflowResume: true, workflowPause: true, workflowFleet: true };
} finally { await server.close(); }
console.log(JSON.stringify({ status: externalConsumerMatrix ? 'passed' : 'failed', batchOutputReferences: true, externalConsumerMatrix, observation: observationReport, http: httpReport }));
