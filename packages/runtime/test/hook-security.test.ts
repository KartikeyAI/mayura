import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Guard, JsonValue, ModelAdapter, ModelResponse, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineModerationGuard } from '../../guardrails/src/index.js';
import { createRuntime, defineAgent, defineHook, type AgentOptions, type Runtime } from '../src/index.js';

const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'hook-security', validate: value => ({ value: value as JsonValue }) } };
const grants = ['model:primary', 'model:moderator', 'tool:read', 'tool:original', 'effect:read', 'effect:write'];
const final = (output: JsonValue = 1): ModelResponse => ({ type: 'final', output, usage: { costMicros: 0 } });
function agent(extras: Partial<AgentOptions<typeof schema, typeof schema>> = {}) {
  const model: ModelAdapter = { id: 'primary', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => final() };
  return defineAgent({ id: 'agent', version: '1', instructions: 'No private content in diagnostics.', input: schema, output: schema, tools: [], model, ...extras });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const engines: Runtime[] = [];
function runtime(maxDurationMs = 2_000) {
  const engine = createRuntime({ profile: 'ephemeral', scope: { principalId: 'principal', projectId: 'project' }, permissions: { allow: grants },
    limits: { maxConcurrentOperations: 1, maxConcurrentRuns: 1, maxDurationMs, maxCostMicros: 20 } });
  engines.push(engine); return engine;
}
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.close())); });

describe('hook integration security regressions', () => {
  it.each(['input', 'output'] as const)(
    'retains global capacity until a timed-out agent %s schema actually settles', async boundary => {
      const started = deferred<void>(); const release = deferred<void>();
      const pending: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'noncooperative-agent-schema', validate: async value => {
        started.resolve(); await release.promise; return { value: value as JsonValue };
      } } };
      const generate = vi.fn(async () => final('PRIVATE final candidate'));
      const engine = runtime(80);
      const first = engine.submit(agent({ [boundary]: pending, model: {
        id: 'primary', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate,
      } }), { input: 'PRIVATE input' });
      try {
        await started.promise;
        const initial = await first.result(); const before = JSON.stringify(initial);
        expect(initial).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
        expect('output' in initial).toBe(false);
        expect(generate).toHaveBeenCalledTimes(boundary === 'output' ? 1 : 0);
        expect(engine.inspect(first).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: boundary === 'output' ? 1 : 0 });
        expect(engine.inspect(first).evidence).toEqual([]);
        const callback = vi.fn(() => ({ decision: 'continue' as const }));
        const hook = defineHook({ id: 'next', version: '1', stage: 'beforeExecution', tools: [], handler: callback });
        const next = engine.submit(agent({ hooks: [hook] }), { input: 1 });
        await nextTurn(); await nextTurn();
        expect(callback).not.toHaveBeenCalled();
        release.resolve();
        expect((await next.result()).status).toBe('succeeded');
        expect(callback).toHaveBeenCalledTimes(1);
        expect(generate).toHaveBeenCalledTimes(boundary === 'output' ? 1 : 0);
        expect(await first.result()).toBe(initial); expect(JSON.stringify(initial)).toBe(before);
        expect(before).not.toContain('PRIVATE');
        expect(engine.inspect(first).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: boundary === 'output' ? 1 : 0 });
        expect(engine.inspect(first).evidence).toEqual([]);
      } finally { release.resolve(); }
    },
  );

  it.each(['mandatory-output-guard', 'output-hook'] as const)(
    'does not report a protected result as released while its %s is still pending', async boundary => {
      const started = deferred<void>(); const release = deferred<void>();
      const pause = async () => { started.resolve(); await release.promise; };
      const original = defineTool({ id: 'original', version: '1', description: 'Write.', input: schema, output: schema, effects: 'write', capabilities: [], costMicros: 3, execute: async () => 1 });
      const hook = defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [], handler: async event => {
        if (boundary === 'output-hook' && event.source === 'tool') await pause(); return { decision: 'continue' };
      } });
      const guard: Guard = { id: 'release-check', check: async (_value, context) => {
        if (boundary === 'mandatory-output-guard' && context.callId === 'original.1') await pause(); return { decision: 'allow' };
      } };
      const generate = vi.fn(async (): Promise<ModelResponse> => generate.mock.calls.length === 1
        ? { type: 'tool_calls', calls: [{ id: 'original.1', toolId: 'original', input: 1 }], usage: { costMicros: 0 } } : final());
      const engine = runtime();
      const run = engine.submit(agent({ model: { id: 'primary', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate }, tools: [original], hooks: [hook], guards: { output: [guard] } }), { input: 1 });
      try {
        await started.promise;
        expect(engine.inspect(run).evidence).toEqual([{ runId: run.id, receipt: { callId: 'original.1', toolId: 'original', execution: 'succeeded', disclosure: 'withheld' } }]);
        expect(generate).toHaveBeenCalledTimes(1);
        release.resolve(); expect((await run.result()).status).toBe('succeeded');
        expect(engine.inspect(run).evidence).toEqual([{ runId: run.id, receipt: { callId: 'original.1', toolId: 'original', execution: 'succeeded', disclosure: 'released' } }]);
      } finally { release.resolve(); }
    },
  );

  it.each(['input-schema', 'input-guard', 'output-schema', 'output-guard'] as const)(
    'retains actual callback admission when the hook action broker %s ignores cancellation', async boundary => {
      const started = deferred<void>(); const release = deferred<void>();
      let inputValidations = 0;
      const paused = async () => { started.resolve(); await release.promise; };
      const input: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'broker-input', validate: async value => {
        // The first validation is the runtime's whole-list preflight, not the final broker admission.
        if (boundary === 'input-schema' && ++inputValidations === 2) await paused();
        return { value: value as JsonValue };
      } } };
      const output: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'broker-output', validate: async value => {
        if (boundary === 'output-schema') await paused(); return { value: value as JsonValue };
      } } };
      const guarded = (stage: 'input' | 'output'): Guard => ({ id: `${stage}-guard`, check: async () => {
        if (boundary === `${stage}-guard`) await paused(); return { decision: 'allow' };
      } });
      const execute = vi.fn(async () => 1);
      const read = defineTool({ id: 'read', version: '1', description: 'Required read.', input, output, effects: 'read', capabilities: [], costMicros: 3,
        guards: { input: [guarded('input')], output: [guarded('output')] }, execute });
      const firstHook = defineHook({ id: 'first', version: '1', stage: 'beforeExecution', tools: [read], timeoutMs: 35,
        handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
      const secondCallback = vi.fn(() => ({ decision: 'continue' as const }));
      const secondHook = defineHook({ id: 'second', version: '1', stage: 'beforeExecution', tools: [], handler: secondCallback });
      const engine = runtime(); const first = engine.submit(agent({ hooks: [firstHook] }), { input: 1 });
      try {
        await started.promise;
        const initial = await first.result();
        expect(initial).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' }, receipt: {
          execution: boundary.startsWith('output') ? 'succeeded' : 'not_started', disclosure: 'withheld',
        } });
        const second = engine.submit(agent({ hooks: [secondHook] }), { input: 1 });
        await nextTurn(); await nextTurn();
        // A logical timeout is not settlement of a schema/guard callback's real promise.
        expect(secondCallback).not.toHaveBeenCalled();
        release.resolve();
        expect((await second.result()).status).toBe('succeeded');
        expect(execute).toHaveBeenCalledTimes(boundary.startsWith('output') ? 1 : 0);
        expect(await first.result()).toBe(initial);
        expect(engine.inspect(first).budget).toEqual({ spentMicros: boundary.startsWith('output') ? 3 : 0, reservedMicros: 0, calls: boundary.startsWith('output') ? 1 : 0 });
      } finally { release.resolve(); }
    },
  );

  it('keeps an uncertain output-hook read distinct from the protected successful write', async () => {
    const started = deferred<void>(); const release = deferred<JsonValue>();
    const write = vi.fn(async () => 'PRIVATE original output');
    const original = defineTool({ id: 'original', version: '1', description: 'Write.', input: schema, output: schema, effects: 'write', capabilities: [], costMicros: 3, execute: write });
    const read = defineTool({ id: 'read', version: '1', description: 'Read before release.', input: schema, output: schema, effects: 'read', capabilities: [], costMicros: 2,
      execute: () => { started.resolve(); return release.promise; } });
    const hook = defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [read], timeoutMs: 35,
      handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'tool_calls', calls: [{ id: 'original.1', toolId: 'original', input: 1 }], usage: { costMicros: 0 } }));
    const engine = runtime();
    const run = engine.submit(agent({ model: { id: 'primary', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate }, tools: [original], hooks: [hook] }), { input: 1 });
    try {
      await started.promise;
      const result = await run.result(); const before = JSON.stringify(result);
      expect(result).toMatchObject({ status: 'outcome_unknown', receipt: { toolId: 'read', execution: 'unknown', disclosure: 'withheld' } });
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence).toEqual(expect.arrayContaining([
        { runId: run.id, receipt: { callId: 'original.1', toolId: 'original', execution: 'succeeded', disclosure: 'withheld' } },
        { runId: run.id, receipt: { callId: expect.stringMatching(/^hook:/), toolId: 'read', execution: 'unknown', disclosure: 'withheld' } },
      ]));
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 2, calls: 3 });
      release.resolve('PRIVATE late output'); await nextTurn(); await nextTurn();
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 3 });
      expect(engine.inspect(run).evidence).toHaveLength(2);
      expect(engine.inspect(run).evidence.every(item => item.receipt.execution === 'succeeded' && item.receipt.disclosure === 'withheld')).toBe(true);
      expect(JSON.stringify(result)).toBe(before); expect(before).not.toContain('PRIVATE');
      expect(generate).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    } finally { release.resolve(1); }
  });

  it('retains a started hook-action moderation charge and permit while refunding the undispatched original holds', async () => {
    const started = deferred<void>(); const release = deferred<ModelResponse>();
    const originalExecute = vi.fn(async () => 1);
    const original = defineTool({ id: 'original', version: '1', description: 'Protected write.', input: schema, output: schema, effects: 'write', capabilities: [], costMicros: 3, execute: originalExecute });
    const read = defineTool({ id: 'read', version: '1', description: 'Required read.', input: schema, output: schema, effects: 'read', capabilities: [], costMicros: 2, execute: async () => 1 });
    const hook = defineHook({ id: 'before', version: '1', stage: 'beforeToolCall', tools: [read], timeoutMs: 35,
      handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const auxiliary = vi.fn(() => { started.resolve(); return release.promise; });
    const guard = defineModerationGuard({ id: 'moderate', version: '1', instructions: 'PRIVATE policy', egressGuards: [], model: {
      id: 'moderator', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 5, generate: auxiliary,
    } });
    const engine = runtime();
    const run = engine.submit(agent({ tools: [original], hooks: [hook], guards: { output: [guard] }, model: {
      id: 'primary', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
      generate: async () => ({ type: 'tool_calls', calls: [{ id: 'original.1', toolId: 'original', input: 1 }], usage: { costMicros: 0 } }),
    } }), { input: 1 });
    try {
      await started.promise;
      const result = await run.result(); const before = JSON.stringify(result);
      expect(result).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' }, receipt: { toolId: 'read', execution: 'succeeded', disclosure: 'withheld' } });
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 5, calls: 3 });
      expect(originalExecute).not.toHaveBeenCalled();
      const nextCallback = vi.fn(() => ({ decision: 'continue' as const }));
      const nextHook = defineHook({ id: 'next', version: '1', stage: 'beforeExecution', tools: [], handler: nextCallback });
      const next = engine.submit(agent({ hooks: [nextHook] }), { input: 1 });
      await nextTurn(); await nextTurn(); expect(nextCallback).not.toHaveBeenCalled();
      release.resolve({ type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 4 } });
      expect((await next.result()).status).toBe('succeeded');
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 6, reservedMicros: 0, calls: 3 });
      expect(auxiliary).toHaveBeenCalledTimes(1); expect(originalExecute).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).toBe(before);
      const events = []; for await (const event of run.observe()) events.push(event);
      expect(events.filter(event => event.type === 'model.completed' && event.metadata['purpose'] === 'guardrail')).toHaveLength(0);
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
    } finally { release.resolve(final()); }
  });
});
