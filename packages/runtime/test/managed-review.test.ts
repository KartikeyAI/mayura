import { describe, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Budget, MayuraError, ModelInvocationError, type Guard, type GuardContext, type JsonValue, type ModelAdapter } from '@mayura/core';
import { defineTool, invokeTool } from '@mayura/tools';
import { z } from 'zod';
import { createAuxiliaryCheck, createPipeline, defineModerationGuard } from '../../guardrails/src/index.js';
import { createRuntime, defineAgent } from '../src/index.js';

const schema = z.string();
const scope = { principalId: 'review-principal', projectId: 'review-project' };
function context(): GuardContext {
  return { runId: 'review-run', callId: 'review-call', scope, boundary: 'input', signal: new AbortController().signal };
}
function adapter(output: JsonValue = 'value'): ModelAdapter {
  return { id: 'review-model', maxCostMicros: 0, capabilities: { tools: false, structuredOutput: true },
    generate: async () => ({ type: 'final', output, usage: { costMicros: 0 } }) };
}
function localGuard(inherited: boolean): { guard: Guard; check: ReturnType<typeof vi.fn<Guard['check']>> } {
  const check = vi.fn<Guard['check']>(() => ({ decision: 'allow' }));
  // Application metadata was valid before managed handles were introduced. Only
  // the reserved Mayura discriminator, not every unrelated kind, is authority.
  const guard: Guard = inherited
    ? Object.assign(Object.create({ kind: 'application.local-check' }) as Guard, { id: 'local-policy', check })
    : { id: 'local-policy', check, ...{ kind: 'application.local-check' } };
  return { guard, check };
}

describe.each([false, true])('local guard metadata compatibility (inherited=%s)', inherited => {
  it('preserves application metadata guards in managed factory egress screening', async () => {
    const { guard, check } = localGuard(inherited);
    const moderation = defineModerationGuard({ id: 'review-moderation', version: '1',
      model: adapter({ decision: 'allow', categories: [] }), instructions: 'Review fixture.', egressGuards: [guard] });
    const agent = defineAgent({ id: 'review-agent', version: '1', instructions: 'Review fixture.', model: adapter(),
      input: schema, output: schema, tools: [], guards: { input: [moderation] } });
    const runtime = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:review-model'] } });
    try {
      expect(await runtime.submit(agent, { input: 'value' }).result()).toMatchObject({ status: 'succeeded', output: 'value' });
      expect(check).toHaveBeenCalledOnce();
    } finally { await runtime.close(); }
  });

  it('preserves application metadata guards in agent definitions', async () => {
    const { guard, check } = localGuard(inherited);
    const agent = defineAgent({ id: 'review-agent', version: '1', instructions: 'Review fixture.', model: adapter(),
      input: schema, output: schema, tools: [], guards: { input: [guard] } });
    const runtime = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:review-model'] } });
    try {
      expect(await runtime.submit(agent, { input: 'value' }).result()).toMatchObject({ status: 'succeeded', output: 'value' });
      expect(check).toHaveBeenCalledOnce();
    } finally { await runtime.close(); }
  });

  it('preserves application metadata guards in standalone tools', async () => {
    const { guard, check } = localGuard(inherited);
    const tool = defineTool({ id: 'review-tool', version: '1', description: 'Review fixture.', input: schema, output: schema,
      effects: 'none', capabilities: [], guards: { input: [guard] }, execute: value => value });
    const invocation = context();
    const result = await invokeTool(tool, 'value', { runId: invocation.runId, callId: invocation.callId, signal: invocation.signal,
      scope, budget: new Budget(0, 1), permissions: { allow: ['tool:review-tool'] } });
    expect(result).toMatchObject({ status: 'succeeded', output: 'value' }); expect(check).toHaveBeenCalledOnce();
  });

  it('preserves application metadata guards in standalone pipelines', async () => {
    const { guard, check } = localGuard(inherited);
    const result = await createPipeline({ guards: [guard] }).process('value', context());
    expect(result).toMatchObject({ status: 'succeeded', output: { value: 'value' } }); expect(check).toHaveBeenCalledOnce();
  });

  it('preserves application metadata guards in explicitly wired auxiliary checks', async () => {
    const { guard, check } = localGuard(inherited);
    const auxiliary = createAuxiliaryCheck({ id: 'review-check', version: '1', model: adapter(), instructions: 'Review fixture.',
      input: schema, output: schema, budget: new Budget(0, 1), permissions: { allow: ['model:review-model'] }, egressGuards: [guard] });
    expect(await auxiliary.evaluate('value', context())).toMatchObject({ status: 'succeeded', output: { output: 'value' } });
    expect(check).toHaveBeenCalledOnce();
  });
});

describe('managed accounting independent review', () => {
  it('does not execute or disclose an accessor on primary failure usage while releasing undispatched checks', async () => {
    const reads = vi.fn(() => { throw new MayuraError('MODEL_FAILED', 'SECRET_PROVIDER_CREDENTIAL'); });
    const error = Object.create(ModelInvocationError.prototype) as ModelInvocationError;
    Object.defineProperty(error, 'costMicros', { get: reads });
    const primary: ModelAdapter = { ...adapter(), maxCostMicros: 3, generate: async () => { throw error; } };
    const auxiliary = vi.fn(async () => ({ type: 'final' as const, output: { decision: 'allow', categories: [] }, usage: { costMicros: 2 } }));
    const moderation = defineModerationGuard({ id: 'review-moderation', version: '1',
      model: { ...adapter(), maxCostMicros: 2, generate: auxiliary }, instructions: 'Review fixture.', egressGuards: [] });
    const agent = defineAgent({ id: 'review-agent', version: '1', instructions: 'Review fixture.', model: primary,
      input: schema, output: schema, tools: [], guards: { output: [moderation] } });
    const runtime = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:review-model'] },
      limits: { maxCostMicros: 5, maxModelCalls: 2 } });
    try {
      const run = runtime.submit(agent, { input: 'value' }); const result = await run.result();
      expect(JSON.stringify(result)).not.toContain('SECRET_PROVIDER_CREDENTIAL');
      expect(result).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
      expect(reads).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
      expect(runtime.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
    } finally { await runtime.close(); }
  });

  it('releases cancelled child kind holds so a required sibling can use the remaining ancestor slot', async () => {
    let primaryEntered!: () => void; let finishPrimary!: (response: Awaited<ReturnType<ModelAdapter['generate']>>) => void;
    const entered = new Promise<void>(resolve => { primaryEntered = resolve; });
    const pending = new Promise<Awaited<ReturnType<ModelAdapter['generate']>>>(resolve => { finishPrimary = resolve; });
    const final = { type: 'final' as const, output: 'value', usage: { costMicros: 0 } };
    const moderator = vi.fn(async () => ({ type: 'final' as const, output: { decision: 'allow', categories: [] }, usage: { costMicros: 1 } }));
    const check = defineModerationGuard({ id: 'review-moderation', version: '1',
      model: { ...adapter(), maxCostMicros: 1, generate: moderator }, instructions: 'Review fixture.', egressGuards: [] });
    const parent = defineAgent({ id: 'review-parent', version: '1', instructions: 'Review fixture.',
      model: { ...adapter(), generate: () => { primaryEntered(); return pending; } }, input: schema, output: schema, tools: [] });
    const cancelled = defineAgent({ id: 'review-cancelled', version: '1', instructions: 'Review fixture.', model: adapter(),
      input: schema, output: schema, tools: [], guards: { input: [check] } });
    const siblingModel = vi.fn(async () => ({ ...final, usage: { costMicros: 1 } }));
    const sibling = defineAgent({ id: 'review-sibling', version: '1', instructions: 'Review fixture.',
      model: { ...adapter(), maxCostMicros: 1, generate: siblingModel }, input: schema, output: schema, tools: [] });
    const permissions = { allow: ['model:review-model', 'agent:delegate'] };
    const runtime = createRuntime({ profile: 'ephemeral', scope, permissions,
      limits: { maxCostMicros: 1, maxModelCalls: 2, maxConcurrentOperations: 1, maxDurationMs: 1_000 } });
    try {
      const root = runtime.submit(parent, { input: 'value' }); await entered;
      const first = runtime.spawn(root, cancelled, { input: 'value', permissions }); await nextTurn();
      expect(runtime.inspect(root).budget).toEqual({ spentMicros: 0, reservedMicros: 1, calls: 1 });
      first.cancel(); expect((await first.result()).status).toBe('cancelled');
      expect(runtime.inspect(root).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
      const second = runtime.spawn(root, sibling, { input: 'value', permissions }); await nextTurn();
      expect(siblingModel).not.toHaveBeenCalled(); // The actual parent callback still owns the sole permit.
      finishPrimary(final);
      expect((await second.result()).status).toBe('succeeded'); await root.result();
      expect(siblingModel).toHaveBeenCalledOnce(); expect(moderator).not.toHaveBeenCalled();
      expect(runtime.inspect(root).budget).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 2 });
    } finally { finishPrimary(final); await runtime.close(); }
  });
});
