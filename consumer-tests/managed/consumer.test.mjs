import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Budget, createRuntime, defineAgent, defineTool, invokeTool } from '@mayura/sdk';
import { defineModerationGuard } from '@mayura/guardrails';
import { assertBudgetTicket, readManagedGuardDefinition, registerManagedGuardDefinition } from '@mayura/core/host';
import { bindToolBudgetTicket } from '@mayura/tools/host';
import { createObserver } from '@mayura/observability';

const root = await realpath(process.cwd());
const packages = ['@mayura/core', '@mayura/tools', '@mayura/runtime', '@mayura/sdk', '@mayura/guardrails', '@mayura/observability'];
for (const name of [...packages, '@mayura/core/host', '@mayura/tools/host']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Runtime import escaped the packed consumer installation.');
}
for (const name of packages) {
  await assert.rejects(import(`${name}/src/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  await assert.rejects(import(`${name}/dist/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
for (const name of ['@mayura/provider-openai', '@mayura/storage', '@mayura/server', '@mayura/server-node', '@mayura/testing', 'better-sqlite3', 'pg', 'zod']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}

const input = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'string' ? { value: value.length } : { issues: [] } } };
const number = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };
const output = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value: { answer: value } } : { issues: [] } } };
let primaryCalls = 0; let auxiliaryCalls = 0; const requests = [];
const moderator = { id: 'consumer.moderator', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 1,
  generate: async request => {
    auxiliaryCalls++; requests.push(request);
    assert.deepEqual(request.tools, []); assert.equal(request.continuation, undefined);
    assert(!JSON.stringify(request).includes('PRIVATE_PRIMARY_PROMPT'));
    return { type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 1 } };
  },
};
const primary = { id: 'consumer.primary', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 1,
  generate: async request => {
    primaryCalls++; assert.deepEqual(request.messages, [{ role: 'user', content: 3 }]);
    return { type: 'final', output: 3, usage: { costMicros: 1 } };
  },
};
const guard = defineModerationGuard({ id: 'consumer.policy', version: '1', model: moderator, instructions: 'PRIVATE_MODERATION_PROMPT', egressGuards: [] });
assert(Object.isFrozen(guard)); assert.equal('check' in guard, false); assert.equal('evaluate' in guard, false);
const descriptor = readManagedGuardDefinition(guard);
assert.equal(descriptor.kind, 'moderation'); assert(Object.isFrozen(descriptor)); assert.equal(descriptor.model.id, moderator.id);
assert.equal(readManagedGuardDefinition({ ...guard }), undefined);
const hostRegistered = registerManagedGuardDefinition({ ...descriptor, id: 'consumer.host-policy' });
assert.equal(readManagedGuardDefinition(hostRegistered).kind, 'moderation');

const definition = { id: 'consumer.agent', version: '1', instructions: 'PRIVATE_PRIMARY_PROMPT', model: primary, tools: [], input, output,
  guards: { input: [guard], output: [guard] },
};
const agent = defineAgent(definition);
assert.equal(agent.guards.input[0], guard); assert.equal(agent.guards.output[0], guard);
assert.throws(() => defineAgent({ ...definition, guards: { input: [{ ...guard }] } }), { code: 'INVALID_CONFIG' });
assert.throws(() => defineAgent({ ...definition, guards: { input: [new Proxy(guard, {})] } }), { code: 'INVALID_CONFIG' });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:consumer.primary', 'model:consumer.moderator'] },
  scope: { principalId: 'consumer', projectId: 'managed-fixture' },
  limits: { maxCostMicros: 3, maxModelCalls: 3, maxSteps: 1, maxConcurrentOperations: 1, maxDurationMs: 2_000 },
});
const observer = createObserver(); let observationReport;
try {
  const handle = runtime.submit(agent, { input: 'abc' });
  const observation = observer.observe(handle);
  assert.equal((await observation.done()).reason, 'terminal');
  assert.deepEqual(await handle.result(), { status: 'succeeded', output: { answer: 3 } });
  assert.equal(primaryCalls, 1); assert.equal(auxiliaryCalls, 2);
  assert.deepEqual(requests.map(request => request.messages), [[{ role: 'user', content: 3 }], [{ role: 'user', content: { answer: 3 } }]]);
  assert.deepEqual(runtime.inspect(handle).budget, { spentMicros: 3, reservedMicros: 0, calls: 3 });
  const summary = observer.inspect(handle.id);
  assert.equal(summary.status, 'succeeded'); assert.equal(summary.coverage, 'complete');
  assert.equal(summary.counters.modelStarted, 3); assert.equal(summary.counters.modelCompleted, 3);
  assert.equal(summary.counters.rejected, 0); assert.equal(summary.counters.events, 8);
  assert.equal(summary.cost.spentMicros, 3); assert.equal(summary.cost.reservedMicros, 0); assert.equal(summary.cost.calls, 3);
  assert.equal(summary.recent.filter(event => event.type === 'model.started' && event.metadata.purpose === 'guardrail').length, 2);
  assert.equal(summary.recent.filter(event => event.type === 'model.completed' && event.metadata.purpose === 'guardrail').length, 2);
  assert(!JSON.stringify([runtime.inspect(handle), observer.inspect()]).includes('PRIVATE_'));
  observationReport = { coverage: summary.coverage, modelStarted: summary.counters.modelStarted, modelCompleted: summary.counters.modelCompleted,
    events: summary.counters.events, rejected: summary.counters.rejected, spentMicros: summary.cost.spentMicros, calls: summary.cost.calls };
} finally { await observer.close(); await runtime.close(); }

// Public host entries must share the same genuine core and tool registrations as SDK imports.
const budget = new Budget(2, 1); const bundle = budget.reserveBundle([{ id: 'consumer.host-ticket', maxCostMicros: 2 }]);
const ticket = bundle.tickets[0]; assertBudgetTicket(ticket, budget);
assert.throws(() => assertBudgetTicket(ticket, new Budget(2, 1)), { code: 'INVALID_CONFIG' });
const tool = defineTool({ id: 'consumer.tool', version: '1', description: 'Host binding smoke test.', input: number, output: number,
  effects: 'none', capabilities: [], costMicros: 2, execute: value => value + 1,
});
const context = { budget, runId: 'consumer.run', callId: 'consumer.call', scope: { principalId: 'consumer', projectId: 'managed-fixture' }, signal: new AbortController().signal };
const binding = bindToolBudgetTicket(tool, ticket, context);
assert(Object.isFrozen(binding)); assert.equal('ticket' in binding, false);
const toolOutcome = await invokeTool(tool, 2, { ...context, permissions: { allow: ['tool:consumer.tool'] }, budgetBinding: binding });
assert.equal(toolOutcome.status, 'succeeded'); assert.equal(toolOutcome.output, 3);
assert.deepEqual(budget.snapshot(), { spentMicros: 2, reservedMicros: 0, calls: 1 });
bundle.close();
console.log(JSON.stringify({ status: 'passed', packages: packages.length, observation: observationReport,
  singlePermit: true, transformedSchemas: true, sharedHostRegistrations: true, forgedHandlesRejected: true, noProviderOrNativeDependencies: true }));
