// One phase of the upgrade-compatibility scenario, executed against the built packages of one source tree.
//   node scripts/upgrade-scenario.mjs <tree> <database> start|resume
// `start` (baseline version) creates durable state and stops mid-run; `resume` (candidate version) must continue it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, database, phase] = process.argv.slice(2);
assert(tree && database && ['start', 'resume'].includes(phase), 'usage: upgrade-scenario.mjs <tree> <database> start|resume');
const load = path => import(pathToFileURL(join(tree, 'packages', ...path.split('/'))).href);
const { createSqliteStore } = await load('storage/dist/index.js');
const { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } = await load('workflows/dist/lifecycle.js');
const { defineTool } = await load('tools/dist/index.js');
const { createMemoryStore } = await load('memory/dist/index.js');

const any = { '~standard': { version: 1, vendor: 'upgrade', validate: value => ({ value }) } };
const text = { '~standard': { version: 1, vendor: 'upgrade', validate: value => typeof value === 'string' ? { value: { decision: value } } : { issues: [{ message: 'text' }] } } };
const draft = defineTool({ id: 'upgrade/draft', version: '1', description: 'Draft.', input: any, output: any, effects: 'none', capabilities: [], costMicros: 1,
  execute: input => ({ draft: input }) });
const digest = 'b'.repeat(64);
// The definition is authored identically in both versions; its digest must match across the upgrade.
const definition = defineWorkflowLifecycle({ id: 'upgrade-review', version: '1', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: ['payload'] } },
  { kind: 'human', id: 'review', dependsOn: ['draft'], request: { kind: 'information', schemaId: 'upgrade/review', schemaDigest: digest,
    prompt: 'Review the draft.', response: text, context: { kind: 'step', stepId: 'draft', path: [] } } },
  { kind: 'timer', id: 'publish', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
], result: { kind: 'step', stepId: 'review', path: [] } });
const scope = { principalId: 'upgrade', projectId: 'compat' };
const clock = { value: phase === 'start' ? 1_000 : 2_000 };
const store = createSqliteStore({ filename: database });
await store.initialize();
const runtime = createWorkflowLifecycleRuntime({ store, scope, permissions: { allow: ['tool:upgrade/draft'] }, policyVersion: '1', maxCostMicros: 5,
  now: () => clock.value, verifyHuman: async credential => ({ id: String(credential), projectId: 'compat', canApprove: false }) });
const memory = createMemoryStore({ store, scope, permissions: { allow: ['memory:read', 'memory:write', 'memory:export'] } });
const provenance = { sourceId: 'upgrade', reference: 'upgrade://fixture', revision: '1', sha256: 'c'.repeat(64), author: 'upgrade', observedAt: '2026-01-01T00:00:00.000Z', origin: 'observed', confidence: 1 };
try {
  if (phase === 'start') {
    const run = await runtime.submit(definition, { input: { payload: 'release notes', publishAt: 3_000 }, idempotencyKey: 'upgrade-1' });
    const waiting = await runtime.runUntilSettled(definition, run.id);
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.steps.review.status, 'waiting');
    await memory.add({ id: 'decision-1', content: 'Releases require human review.', provenance });
    console.log(JSON.stringify({ phase, runId: run.id, definition: definition.digest, requestDigest: waiting.steps.review.requestDigest }));
  } else {
    const [runId] = process.argv.slice(5);
    const before = await runtime.inspect(runId);
    assert.equal(before.status, 'waiting', 'The baseline run must still be waiting after the upgrade.');
    await runtime.respond(definition, { id: runId, nodeId: 'review', requestDigest: before.steps.review.requestDigest, commandId: 'upgrade-answer', credential: 'reviewer', value: 'approve' });
    assert.equal((await runtime.runUntilSettled(definition, runId)).status, 'waiting', 'The run should wait for its timer.');
    clock.value = 3_000;
    const done = await runtime.runUntilSettled(definition, runId);
    assert.equal(done.status, 'succeeded'); assert.deepEqual(done.output, { decision: 'approve' });
    assert.equal(done.budget.spentMicros, 1, 'The baseline tool charge must be preserved, not replayed.');
    assert.equal((await memory.get('decision-1'))?.content, 'Releases require human review.');
    console.log(JSON.stringify({ phase, runId, definition: definition.digest, status: done.status }));
  }
} finally { runtime.close(); await store.close(); }
