import assert from 'node:assert/strict';
import { agentAsTool, createRuntime, defineAgent, defineHook, defineTool } from '@mayura/sdk';
import * as runtimeModule from '@mayura/runtime';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

assert.equal(defineHook, runtimeModule.defineHook);
assert.equal('readHookDefinition' in runtimeModule, false);
await assert.rejects(import('@mayura/runtime/dist/hooks.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/runtime/dist/hook-execution.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
let callbacks = 0; let actions = 0; let modelProjection;
const hidden = defineTool({ id: 'policy.read', version: '1', description: 'Read a policy fixture.',
  input: z.string(), output: z.literal(true), effects: 'read', capabilities: [], costMicros: 1,
  execute: value => { assert.equal(value, 'private fixture'); actions++; return true; } });
const hook = defineHook({ id: 'read-policy', version: '1', stage: 'beforeExecution', tools: [hidden], handler: (event, context) => {
  callbacks++; assert(Object.isFrozen(event)); assert(Object.isFrozen(context)); assert(Object.isFrozen(context.scope));
  for (const key of ['budget', 'permissions', 'ticket', 'handle', 'descriptor', 'spawn', 'invoke']) assert.equal(key in context, false);
  return { decision: 'continue', actions: [{ toolId: hidden.id, input: event.input }] };
} });
const release = defineHook({ id: 'release-policy', version: '1', stage: 'beforeOutputRelease', tools: [], handler: event => {
  callbacks++; assert.equal(event.source, 'agent'); assert.equal(event.candidate, 'safe'); return { decision: 'continue' };
} });
const beforeModel = defineHook({ id: 'primary-policy', version: '1', stage: 'beforeModelCall', tools: [], handler: (event, context) => {
  callbacks++; assert.equal(event.purpose, 'primary'); assert.equal(event.modelId, 'scripted'); assert.equal(context.step, 0);
  assert.deepEqual(Object.keys(event.request).sort(), ['maxOutputTokens', 'messages', 'tools']);
  assert(Object.isFrozen(event.request)); assert(Object.isFrozen(event.request.messages)); assert(Object.isFrozen(event.request.messages[0]));
  assert(Object.isFrozen(event.request.tools)); assert.equal(event.request.maxOutputTokens, 4_096);
  assert(!JSON.stringify(event.request).includes('Packed hook fixture.')); modelProjection = event.request;
  return { decision: 'continue' };
} });
const configuration = { id: 'hook-agent', version: '1', instructions: 'Packed hook fixture.', tools: [], hooks: [hook, beforeModel, release],
  input: z.string(), output: z.string(), model: scriptedModel([request => {
    assert.deepEqual(request.tools, []); assert.deepEqual(request.messages, [{ role: 'user', content: 'private fixture' }]);
    assert.deepEqual(modelProjection, { messages: request.messages, tools: request.tools, maxOutputTokens: request.maxOutputTokens });
    return { type: 'final', output: 'safe', usage: { costMicros: 0 } };
  }]) };
const agent = defineAgent(configuration);
assert.equal(agent.hooks[0], hook); assert.equal('handler' in hook, false); assert.equal('tools' in hook, false);
assert.throws(() => defineAgent({ ...configuration, hooks: [{ ...hook }] }), { code: 'INVALID_CONFIG' });
const composed = agentAsTool(agent, { id: 'delegate', description: 'Composition fixture.', permissions: { allow: [] } });
assert.throws(() => defineHook({ id: 'no-compose', version: '1', stage: 'beforeExecution', tools: [composed], handler: () => ({ decision: 'continue' }) }), { code: 'INVALID_CONFIG' });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:policy.read', 'effect:read'] },
  limits: { maxCostMicros: 1, maxToolCalls: 1, maxModelCalls: 1, maxHookCalls: 3, maxConcurrentOperations: 1 } });
try {
  const run = runtime.submit(agent, { input: 'private fixture' }); const result = await run.result();
  assert.equal(result.status, 'succeeded'); assert.equal(result.output, 'safe');
  assert.equal(callbacks, 3); assert.equal(actions, 1);
  assert.deepEqual(runtime.inspect(run).budget, { spentMicros: 1, reservedMicros: 0, calls: 2 });
  assert.equal(result.evidence.length, 1); assert.match(result.evidence[0].receipt.callId, /^hook:/);
  const events = await Array.fromAsync(run.observe());
  assert.equal(events.filter(event => event.type === 'hook.started').length, 3);
  assert.equal(events.filter(event => event.type === 'hook.completed').length, 3);
  const primaryEvents = events.filter(event => event.type.startsWith('hook.') && event.metadata.stage === 'beforeModelCall');
  assert.equal(primaryEvents.length, 2); assert(primaryEvents.every(event => event.metadata.step === 0 && event.metadata.attempt === 1));
  assert(primaryEvents.every(event => !['request', 'purpose', 'modelId'].some(key => key in event.metadata)));
  assert(!JSON.stringify(events).includes('private fixture'));
  console.log(JSON.stringify({ status: 'passed', hookCallbacks: callbacks, hookActions: actions }));
} finally { await runtime.close(); }
