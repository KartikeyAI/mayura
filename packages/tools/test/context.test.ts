import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { Budget, MayuraError, type Effect, type ExecutionContext, type Schema } from '@mayura/core';
import { createToolContextSlot, defineTool, invokeBatch, invokeTool, type InvokeToolContext, type ToolContextBinding } from '../src/index.js';

const schema: Schema<string> = { '~standard': { version: 1, vendor: 'context-test', validate: (value) => typeof value === 'string' ? { value } : { issues: [{ message: 'String required.' }] } } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function tool(execute: (input: string, context: ExecutionContext) => string | Promise<string>, effects: Effect = 'none', timeoutMs = 5_000) {
  return defineTool({ id: 'context.tool', version: '1', description: 'Context and operation-admission regression.', input: schema, output: schema, capabilities: [], effects, costMicros: 1, timeoutMs, execute });
}
function context(overrides: Partial<InvokeToolContext> = {}): InvokeToolContext {
  return { runId: 'context-run', callId: 'context-call', scope: { principalId: 'person', projectId: 'project' }, signal: new AbortController().signal,
    permissions: { allow: ['tool:context.tool', 'effect:write'] }, budget: new Budget(10, 10), ...overrides,
  };
}

describe('opaque per-key tool context', () => {
  it('keeps credentials out of public contexts, bindings, inputs and outcomes', async () => {
    const privateSlot = createToolContextSlot<{ token: string }>(); const otherSlot = createToolContextSlot<{ token: string }>();
    const credentials = { token: 'SECRET-CREDENTIAL' }; const binding = privateSlot.bind(credentials);
    let seen: ExecutionContext | undefined;
    const definition = tool((input, execution) => {
      seen = execution;
      expect(privateSlot.get(execution)).toBe(credentials); expect(otherSlot.get(execution)).toBeUndefined();
      expect(privateSlot.get({ ...execution })).toBeUndefined();
      expect(Object.keys(execution).sort()).toEqual(['callId', 'runId', 'scope', 'signal']);
      expect(Object.isFrozen(execution)).toBe(true); expect(Object.isFrozen(execution.scope)).toBe(true);
      expect(input).toBe('public-input'); return 'public-output';
    });
    const outcome = await invokeTool(definition, 'public-input', context({ contextBindings: [binding] }));
    expect(outcome.status).toBe('succeeded'); expect(Object.isFrozen(binding)).toBe(true); expect(Object.isFrozen(privateSlot)).toBe(true);
    expect(JSON.stringify({ context: seen, binding, outcome })).not.toContain('SECRET');
  });

  it('isolates multiple keys and concurrent invocation bindings', async () => {
    const first = createToolContextSlot<string>(); const second = createToolContextSlot<string>();
    const definition = tool(async (input, execution) => {
      await nextTurn(); expect(first.get(execution)).toBe(`first-${input}`); expect(second.get(execution)).toBe(`second-${input}`); return input;
    });
    const outcomes = await Promise.all(['one', 'two'].map(input => invokeTool(definition, input, context({
      callId: input, contextBindings: [first.bind(`first-${input}`), second.bind(`second-${input}`)],
    }))));
    expect(outcomes.map(outcome => outcome.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('admits exactly 32 distinct slots and rejects a 33rd before execution', async () => {
    const slots = Array.from({ length: 33 }, () => createToolContextSlot<number>());
    const bindings = slots.map((slot, index) => slot.bind(index));
    const execute = vi.fn((_input: string, execution: ExecutionContext) => {
      for (let index = 0; index < 32; index++) expect(slots[index]!.get(execution)).toBe(index);
      expect(slots[32]!.get(execution)).toBeUndefined(); return 'ok';
    });
    const definition = tool(execute); const budget = new Budget(10, 10);
    expect((await invokeTool(definition, 'input', context({ budget, contextBindings: bindings.slice(0, 32) }))).status).toBe('succeeded');
    expect(await invokeTool(definition, 'input', context({ budget, contextBindings: bindings }))).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
    expect(execute).toHaveBeenCalledTimes(1); expect(budget.snapshot().calls).toBe(1);
  });

  it('cannot bypass the slot limit with a changing proxied array length', async () => {
    const bindings = Array.from({ length: 33 }, () => createToolContextSlot<number>().bind(1)); let reads = 0;
    const contextBindings = new Proxy(bindings, { get: (target, key, receiver) => key === 'length' ? (++reads === 1 ? 1 : 33) : Reflect.get(target, key, receiver) });
    const execute = vi.fn(() => 'ok'); const budget = new Budget(10, 10);
    expect(await invokeTool(tool(execute), 'input', context({ budget, contextBindings }))).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
    expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('snapshots the binding list before the first asynchronous validation', async () => {
    const slot = createToolContextSlot<string>(); const bindings = [slot.bind('original')];
    const definition = tool((_input, execution) => { expect(slot.get(execution)).toBe('original'); return 'ok'; });
    const pending = invokeTool(definition, 'input', context({ contextBindings: bindings }));
    bindings[0] = slot.bind('replacement'); bindings.push(slot.bind('duplicate'));
    expect((await pending).status).toBe('succeeded');
  });

  it('rejects copied, forged, proxied and duplicate-slot bindings before reservation or execution', async () => {
    const slot = createToolContextSlot<string>(); const binding = slot.bind('SECRET');
    const execute = vi.fn(() => 'ok'); const definition = tool(execute);
    const cases: readonly ToolContextBinding[][] = [
      [{ ...binding }], [{ kind: 'mayura.tool-context' }], [new Proxy(binding, {})],
      [binding, binding], [binding, slot.bind('second-value')], [null as never],
      Array.from({ length: 33 }, () => createToolContextSlot<string>().bind('value')),
    ];
    for (const contextBindings of cases) {
      const budget = new Budget(10, 10);
      const outcome = await invokeTool(definition, 'input', context({ budget, contextBindings }));
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
      expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
      expect(JSON.stringify(outcome)).not.toContain('SECRET');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('redacts binding-list accessor exceptions', async () => {
    const binding = createToolContextSlot<string>().bind('value'); const contextBindings = [binding];
    Object.defineProperty(contextBindings, 0, { get: () => { throw new MayuraError('INVALID_CONFIG', 'SECRET-BINDING-ERROR'); } });
    const execute = vi.fn(() => 'ok'); const budget = new Budget(10, 10);
    const outcome = await invokeTool(tool(execute), 'input', context({ contextBindings, budget }));
    expect(outcome.status).not.toBe('succeeded'); expect(JSON.stringify(outcome)).not.toContain('SECRET');
    expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('never substitutes a second custom-iterator result for the binding that was checked', async () => {
    const slot = createToolContextSlot<string>(); const original = slot.bind('original'); const replacement = slot.bind('replacement');
    const contextBindings = [original]; let iterations = 0; let observed: string | undefined;
    Object.defineProperty(contextBindings, Symbol.iterator, { value: function* () { yield ++iterations === 1 ? original : replacement; } });
    const outcome = await invokeTool(tool((_input, execution) => { observed = slot.get(execution); return 'ok'; }), 'input', context({ contextBindings }));
    // Rejecting exotic arrays is safe; accepting them requires consuming exactly the validated snapshot.
    expect(observed).not.toBe('replacement');
    if (outcome.status === 'succeeded') expect(observed).toBe('original');
  });
});

describe('tool operation permits', () => {
  it('does not reserve or dispatch while queued and releases a late grant after cancellation', async () => {
    const queued = deferred<void>(); const permit = deferred<() => void>(); const release = vi.fn();
    const controller = new AbortController(); const execute = vi.fn(() => 'ok'); const budget = new Budget(10, 10);
    const pending = invokeTool(tool(execute), 'input', context({ budget, signal: controller.signal,
      acquireExecution: () => { queued.resolve(); return permit.promise; },
    }));
    await queued.promise; expect(budget.snapshot().calls).toBe(0); expect(execute).not.toHaveBeenCalled();
    controller.abort('SECRET-ABORT');
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'cancelled', receipt: { execution: 'not_started' } });
    permit.resolve(release); await nextTurn();
    expect(release).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it.each(['none', 'write'] as const)('retains the permit while a cancelled %s handler remains pending', async (effects) => {
    const started = deferred<void>(); const completion = deferred<string>(); const release = vi.fn(); const recorded = deferred<void>();
    const controller = new AbortController(); const budget = new Budget(10, 10);
    const pending = invokeTool(tool(() => { started.resolve(); return completion.promise; }, effects), 'input', context({
      signal: controller.signal, budget, acquireExecution: async () => release, onExecutionReceipt: async () => { recorded.resolve(); },
    }));
    await started.promise; controller.abort();
    try {
      const outcome = await pending;
      expect(outcome.status).toBe(effects === 'none' ? 'cancelled' : 'outcome_unknown');
      expect(release).not.toHaveBeenCalled(); expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 1, calls: 1 });
    } finally { completion.resolve('late-known-output'); }
    await recorded.promise; await nextTurn();
    expect(release).toHaveBeenCalledTimes(1); expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('rechecks claims after leaving the queue and releases the permit if the claim was revoked', async () => {
    const queued = deferred<void>(); const permit = deferred<() => void>(); const release = vi.fn(); const execute = vi.fn(() => 'ok');
    const budget = new Budget(10, 10); let claimValid = true; const checked: boolean[] = [];
    const pending = invokeTool(tool(execute), 'input', context({ budget,
      acquireExecution: () => { queued.resolve(); return permit.promise; },
      beforeDispatch: async () => { checked.push(claimValid); if (!claimValid) throw new MayuraError('PERMISSION_DENIED', 'SECRET-CLAIM'); },
    }));
    await queued.promise; claimValid = false; permit.resolve(release);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' }, receipt: { execution: 'not_started' } });
    expect(checked.at(-1)).toBe(false); expect(release).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    expect(budget.snapshot().calls).toBe(0); expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it('retains a permit while an admitted claim callback remains pending after cancellation', async () => {
    const checking = deferred<void>(); const claim = deferred<void>(); const release = vi.fn(); const execute = vi.fn(() => 'ok');
    const controller = new AbortController(); const budget = new Budget(10, 10);
    const pending = invokeTool(tool(execute), 'input', context({ budget, signal: controller.signal,
      acquireExecution: async () => release, beforeDispatch: () => { checking.resolve(); return claim.promise; },
    }));
    await checking.promise; controller.abort();
    try {
      expect((await pending).status).toBe('cancelled'); expect(release).not.toHaveBeenCalled();
      expect(budget.snapshot().calls).toBe(0); expect(execute).not.toHaveBeenCalled();
    } finally { claim.resolve(); }
    await nextTurn();
    expect(release).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('releases an acquired permit when shared budget admission fails', async () => {
    const budget = new Budget(0, 10); const release = vi.fn(); const execute = vi.fn(() => 'ok');
    const outcome = await invokeTool(tool(execute), 'input', context({ budget, acquireExecution: async () => release }));
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' }, receipt: { execution: 'not_started' } });
    expect(release).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('redacts acquisition errors including framework-shaped exceptions before dispatch', async () => {
    const budget = new Budget(10, 10); const execute = vi.fn(() => 'ok');
    const outcome = await invokeTool(tool(execute), 'input', context({ budget,
      acquireExecution: async () => { throw new MayuraError('INVALID_CONFIG', 'SECRET-ACQUISITION'); },
    }));
    expect(outcome.status).not.toBe('succeeded'); expect(JSON.stringify(outcome)).not.toContain('SECRET');
    expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('fails closed when a configured limiter returns no release capability', async () => {
    const budget = new Budget(10, 10); const execute = vi.fn(() => 'ok');
    const outcome = await invokeTool(tool(execute), 'input', context({ budget, acquireExecution: (async () => undefined) as never }));
    expect(outcome.status).not.toBe('succeeded'); expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('does not discard known handler success or cost when releasing a permit throws', async () => {
    const budget = new Budget(10, 10); const execute = vi.fn(() => 'known-success');
    const outcome = await invokeTool(tool(execute, 'write'), 'input', context({ budget,
      acquireExecution: async () => () => { throw new MayuraError('INVALID_CONFIG', 'SECRET-RELEASE'); },
    }));
    expect(execute).toHaveBeenCalledTimes(1); expect(outcome.receipt?.execution).toBe('succeeded');
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it('rejects instanceof-only forged budgets before invoking a fake reserve or handler', async () => {
    const fake = Object.create(Budget.prototype) as Budget; const reserve = vi.fn(() => ({ settle() {} }));
    Object.defineProperty(fake, 'reserve', { value: reserve });
    const execute = vi.fn(() => 'ok'); const outcome = await invokeTool(tool(execute), 'input', context({ budget: fake }));
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
    expect(reserve).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('forwards inherited opaque bindings and operation admission through the batch broker', async () => {
    const slot = createToolContextSlot<string>(); const release = vi.fn(); const acquireExecution = vi.fn(async () => release);
    let observed: string | undefined;
    const definition = tool((_input, execution) => { observed = slot.get(execution); return 'ok'; });
    const outcomes = await invokeBatch([{ id: 'batch-call', tool: definition, input: 'input' }], context({
      contextBindings: [slot.bind('SECRET-BATCH-CONTEXT')], acquireExecution,
    }));
    expect(observed).toBe('SECRET-BATCH-CONTEXT'); expect(acquireExecution).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
    expect(outcomes[0]?.outcome.status).toBe('succeeded'); expect(JSON.stringify(outcomes)).not.toContain('SECRET');
  });
});
