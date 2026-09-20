import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineWorkflow } from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';
import { StorageError } from '@mayura/storage-contracts';

const root = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/tools', '@mayura/runtime', '@mayura/workflows', '@mayura/workflows/ephemeral', '@mayura/storage-contracts']) {
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
let effects = 0;
const left = defineTool({ id: 'consumer.left', version: '1', description: 'Double a number.', input: number, output: number, effects: 'none', capabilities: [], execute: value => { effects++; return value * 2; } });
const right = defineTool({ id: 'consumer.right', version: '1', description: 'Increment a number.', input: number, output: number, effects: 'none', capabilities: [], execute: value => { effects++; return value + 1; } });
const definition = defineWorkflow({ id: 'consumer.graph', version: '1', input, output, nodes: [
  { id: 'left', kind: 'tool', tool: left, input: { kind: 'input', path: [] } },
  { id: 'right', kind: 'tool', tool: right, input: { kind: 'input', path: [] } },
  { id: 'joined', kind: 'join', dependsOn: ['left', 'right'] },
], result: { kind: 'step', stepId: 'joined', path: [] } });
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
console.log(JSON.stringify({ status: 'passed', graphEffects: effects, transformedForkJoin: true, requiredChildComposition: true, sqlDriversInstalled: false }));
