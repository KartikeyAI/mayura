import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type Guard, type JsonValue, type ModelAdapter, type ModelResponse, type RunEvent, type RunHandle, type Schema } from '@mayura/core';
import { readManagedGuardDefinition, registerManagedGuardDefinition } from '@mayura/core/host';
import { defineModerationGuard } from '../../guardrails/src/index.js';
import { createRuntime, defineAgent, type AgentGuard, type Runtime } from '../src/index.js';

const schema: Schema<JsonValue> = { '~standard': {
  version: 1, vendor: 'managed-security-review', validate: value => ({ value: value as JsonValue }),
} };
const model: ModelAdapter = { id: 'review-model', maxCostMicros: 0,
  capabilities: { tools: true, structuredOutput: true },
  generate: async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } }),
};
function definition(input: readonly AgentGuard[]) {
  return defineAgent({ id: 'review-agent', version: '1', instructions: 'Review only.', model,
    input: schema, output: schema, tools: [], guards: { input } });
}
const engines: Runtime[] = [];
function runtime() {
  const engine = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:review-model'] },
    limits: { maxCostMicros: 3, maxDurationMs: 2_000, maxConcurrentOperations: 1 } });
  engines.push(engine); return engine;
}
async function observations(handle: RunHandle<unknown>): Promise<RunEvent[]> {
  const events: RunEvent[] = []; for await (const event of handle.observe()) events.push(event); return events;
}
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.close())); });

describe('managed definition snapshot security review', () => {
  it('rejects a custom array map that bypasses genuine managed-handle admission', () => {
    const genuine = defineModerationGuard({ id: 'review-guard', version: '1', model,
      instructions: 'Review moderation.', egressGuards: [] });
    const check = vi.fn(() => ({ decision: 'allow' as const }));
    const forged = { ...genuine, check };
    const supplied: AgentGuard[] = [];
    const map = vi.fn(() => [forged]);
    Object.defineProperty(supplied, 'map', { value: map });
    expect(() => definition(supplied)).toThrow();
    expect(map).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  });

  it('rejects accessor array entries without running configuration callbacks', () => {
    const supplied: AgentGuard[] = [];
    const entry = vi.fn((): Guard => ({ id: 'unexpected', check: () => ({ decision: 'allow' }) }));
    Object.defineProperty(supplied, '0', { enumerable: true, get: entry });
    expect(() => definition(supplied)).toThrow();
    expect(entry).not.toHaveBeenCalled();
  });
});

describe('managed execution boundary security review', () => {
  it.each(['output-getter', 'usage-getter', 'own-keys-proxy', 'undefined-continuation', 'raw-error', 'framework-error'] as const)
    ('redacts malformed %s responses and charges only independently known usage', async variant => {
      const secret = 'SECRET_PROVIDER_ORIGINAL_CONTENT';
      const getter = vi.fn(() => { throw new Error(secret); });
      const generate = vi.fn(async (): Promise<ModelResponse> => {
        if (variant === 'raw-error') throw new Error(secret);
        if (variant === 'framework-error') throw new MayuraError('GUARD_BLOCKED', secret);
        const result: Record<string, unknown> = { type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 2 } };
        if (variant === 'undefined-continuation') result['continuation'] = undefined;
        if (variant === 'output-getter') Object.defineProperty(result, 'output', { enumerable: true, get: getter });
        if (variant === 'usage-getter') Object.defineProperty(result, 'usage', { enumerable: true, get: getter });
        return (variant === 'own-keys-proxy' ? new Proxy(result, { ownKeys: () => { throw new MayuraError('GUARD_UNAVAILABLE', secret); } }) : result) as unknown as ModelResponse;
      });
      const guard = defineModerationGuard({ id: 'review-guard', version: '1', model: { ...model, maxCostMicros: 3, generate },
        instructions: 'Review moderation.', egressGuards: [] });
      const engine = runtime(); const handle = engine.submit(definition([guard]), { input: 1 });
      const outcome = await handle.result();
      expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
      const known = ['output-getter', 'own-keys-proxy', 'undefined-continuation'].includes(variant);
      expect(engine.inspect(handle).budget).toEqual({ spentMicros: known ? 2 : 0, reservedMicros: known ? 0 : 3, calls: 1 });
      expect(generate).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify([outcome, engine.inspect(handle), await observations(handle)])).not.toContain(secret);
    });

  it.each([0, -1])('enforces the exact UTF-8 complete request bound with a %i byte offset', async offset => {
    const instructions = 'Review moderation: 隐私.';
    const data = { instructions, messages: [{ role: 'user', content: 1 }], tools: [], maxOutputTokens: 7 };
    const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 2 } }));
    const guard = defineModerationGuard({ id: 'review-guard', version: '1', model: { ...model, maxCostMicros: 3, generate },
      instructions, egressGuards: [], limits: { maxInputBytes: bytes + offset, maxOutputTokens: 7 } });
    const engine = runtime(); const handle = engine.submit(definition([guard]), { input: 1 });
    const outcome = await handle.result();
    if (offset === 0) {
      expect(outcome.status).toBe('succeeded'); expect(generate).toHaveBeenCalledTimes(1);
      expect(engine.inspect(handle).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 2 });
    } else {
      expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
      expect(generate).not.toHaveBeenCalled();
      expect(engine.inspect(handle).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
    }
  });

  it('cancels from the completed local egress check before consuming the managed ticket', async () => {
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 2 } }));
    let handle!: RunHandle<unknown>;
    const guard = defineModerationGuard({ id: 'review-guard', version: '1', model: { ...model, maxCostMicros: 3, generate },
      instructions: 'Review moderation.', egressGuards: [{ id: 'cancel-at-egress', check: () => { handle.cancel(); return { decision: 'allow' }; } }] });
    const engine = runtime(); handle = engine.submit(definition([guard]), { input: 1 });
    expect(await handle.result()).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(generate).not.toHaveBeenCalled();
    expect(engine.inspect(handle).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it.each([false, true])('compares the settled async input schema result canonically (changed=%s)', async changed => {
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 2 } }));
    const original = defineModerationGuard({ id: 'review-guard', version: '1', model: { ...model, maxCostMicros: 3, generate },
      instructions: 'Review moderation.', egressGuards: [] });
    const descriptor = readManagedGuardDefinition(original)!;
    const guard = registerManagedGuardDefinition({ ...descriptor, input: { '~standard': {
      version: 1, vendor: 'async-schema-review', validate: async () => { await Promise.resolve(); return { value: { b: 2, a: changed ? 3 : 1 } }; },
    } } });
    const engine = runtime(); const handle = engine.submit(definition([guard]), { input: { a: 1, b: 2 } });
    const outcome = await handle.result();
    if (changed) {
      expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
      expect(generate).not.toHaveBeenCalled();
      expect(engine.inspect(handle).budget.calls).toBe(0);
    } else {
      expect(outcome.status).toBe('succeeded'); expect(generate).toHaveBeenCalledTimes(1);
    }
  });
});
