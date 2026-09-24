import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, type ExecutionReceipt, type Schema } from '@mayura/core';
import { batchOutput, defineTool, invokeBatch, type BatchCall, type InvokeBatchOptions, type ToolOptions } from '../src/index.js';

const input = z.object({ value: z.number() });
const output = z.object({ result: z.number() });
function tool(overrides: Partial<ToolOptions<typeof input, typeof output>> = {}) {
  return defineTool({
    id: 'batch.tool', version: '1', description: 'Controlled batch fixture', input, output,
    effects: 'none', capabilities: [], execute: value => ({ result: value.value }), ...overrides,
  });
}
function options(overrides: Partial<InvokeBatchOptions> = {}): InvokeBatchOptions {
  return {
    runId: 'run-1', scope: { principalId: 'owner', projectId: 'project' }, signal: new AbortController().signal,
    permissions: { allow: ['tool:batch.tool', 'effect:write'] }, budget: new Budget(100, 128), ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('whole-batch preflight', () => {
  it('rejects cycles, missing references, duplicate IDs and duplicate dependencies before effects', async () => {
    const execute = vi.fn(() => ({ result: 1 })); const definition = tool({ execute });
    const base = { tool: definition, input: { value: 1 } };
    const invalid: BatchCall[][] = [
      [{ ...base, id: 'a', dependsOn: ['b'] }, { ...base, id: 'b', dependsOn: ['a'] }],
      [{ ...base, id: 'a', dependsOn: ['missing'] }],
      [{ ...base, id: 'a' }, { ...base, id: 'a' }],
      [{ ...base, id: 'a' }, { ...base, id: 'b', dependsOn: ['a', 'a'] }],
    ];
    for (const calls of invalid) await expect(invokeBatch(calls, options())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates every input before the first valid handler can execute', async () => {
    const execute = vi.fn(() => ({ result: 1 })); const definition = tool({ execute });
    await expect(invokeBatch([
      { id: 'valid', tool: definition, input: { value: 1 } },
      { id: 'invalid', tool: definition, input: { value: 'private-value' } },
    ], options())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates every exact tool/effect/capability grant before any effect', async () => {
    const execute = vi.fn(() => ({ result: 1 })); const definition = tool({ execute });
    const denied = tool({ id: 'denied.tool', effects: 'write', capabilities: ['extra'], execute });
    await expect(invokeBatch([
      { id: 'valid', tool: definition, input: { value: 1 } },
      { id: 'denied', tool: denied, input: { value: 1 } },
    ], options())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects forged tool identities and invalid execution limits', async () => {
    const definition = tool(); const call = { id: 'a', tool: definition, input: { value: 1 } };
    await expect(invokeBatch([{ ...call, tool: { ...definition } }], options())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    for (const concurrency of [0, -1, 1.5, 33]) await expect(invokeBatch([call], options({ concurrency }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(invokeBatch([], options())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(invokeBatch(Array.from({ length: 129 }, (_, index) => ({ ...call, id: `${index}` })), options())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(invokeBatch([{ ...call, resources: ['same', 'same'] }], options())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('bounds hanging asynchronous preflight without starting a tool', async () => {
    vi.useFakeTimers(); const execute = vi.fn(() => ({ result: 1 }));
    const schema: Schema<{ value: number }> = { '~standard': { version: 1, vendor: 'hang', validate: () => new Promise(() => {}) } };
    const definition = defineTool({ id: 'batch.tool', version: '1', description: 'Hanging schema', input: schema, output, effects: 'none', capabilities: [], execute });
    const pending = invokeBatch([{ id: 'a', tool: definition, input: { value: 1 } }], options({ preflightTimeoutMs: 20 }));
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(21); await assertion;
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels hanging preflight and removes the parent listener', async () => {
    const controller = new AbortController(); const began = deferred<void>();
    const schema: Schema<{ value: number }> = { '~standard': { version: 1, vendor: 'hang', validate: () => { began.resolve(); return new Promise(() => {}); } } };
    const execute = vi.fn(() => ({ result: 1 }));
    const definition = defineTool({ id: 'batch.tool', version: '1', description: 'Cancelled schema', input: schema, output, effects: 'none', capabilities: [], execute });
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = invokeBatch([{ id: 'a', tool: definition, input: { value: 1 } }], options({ signal: controller.signal }));
    await began.promise; controller.abort('private-reason');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(execute).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a transformed candidate that changes after preflight', async () => {
    let validations = 0; const execute = vi.fn((value: { value: number }) => ({ result: value.value }));
    const schema: Schema<{ value: number }> = { '~standard': { version: 1, vendor: 'changing', validate: () => ({ value: { value: ++validations } }) } };
    const definition = defineTool({ id: 'batch.tool', version: '1', description: 'Changing input', input: schema, output, effects: 'none', capabilities: [], execute });
    const budget = new Budget(10, 10);
    const result = await invokeBatch([{ id: 'a', tool: definition, input: { value: 1 } }], options({ budget }));
    expect(result[0]?.outcome).toMatchObject({ status: 'blocked', receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('snapshots all inputs, scope and grants before asynchronous validation', async () => {
    const execute = vi.fn((value: { value: number }) => ({ result: value.value }));
    const definition = tool({ execute });
    const firstInput = { value: 1 }; const secondInput = { value: 2 };
    const scope = { principalId: 'owner', projectId: 'project' }; const allow = ['tool:batch.tool'];
    const pending = invokeBatch([
      { id: 'a', tool: definition, input: firstInput }, { id: 'b', tool: definition, input: secondInput },
    ], options({ scope, permissions: { allow } }));
    firstInput.value = 10; secondInput.value = 20; scope.projectId = 'other'; allow.length = 0;
    const result = await pending;
    expect(result.map(call => call.outcome.status === 'succeeded' ? call.outcome.output : null)).toEqual([{ result: 1 }, { result: 2 }]);
    expect(execute.mock.calls.map(call => call[0].value).sort()).toEqual([1, 2]);
  });
});

describe('batch scheduling and outcome truth', () => {
  it('runs independent handlers concurrently while returning original call order', async () => {
    const both = deferred<void>(); const releases = [deferred<{ result: number }>(), deferred<{ result: number }>()]; let started = 0;
    const definition = tool({ execute: value => { if (++started === 2) both.resolve(); return releases[value.value - 1]!.promise; } });
    const pending = invokeBatch([
      { id: 'first', tool: definition, input: { value: 1 } }, { id: 'second', tool: definition, input: { value: 2 } },
    ], options({ concurrency: 2 }));
    await both.promise; releases[1]!.resolve({ result: 2 }); releases[0]!.resolve({ result: 1 });
    const result = await pending;
    expect(result.map(call => call.id)).toEqual(['first', 'second']);
    expect(result.map(call => call.outcome.status)).toEqual(['succeeded', 'succeeded']);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true);
  });

  it('honors dependencies and skips only dependent branches under collect-all', async () => {
    const order: number[] = [];
    const definition = tool({ execute: value => { order.push(value.value); if (value.value === 1) throw new Error('private-failure'); return { result: value.value }; } });
    const result = await invokeBatch([
      { id: 'failed', tool: definition, input: { value: 1 } },
      { id: 'dependent', tool: definition, input: { value: 2 }, dependsOn: ['failed'] },
      { id: 'independent', tool: definition, input: { value: 3 } },
      { id: 'last', tool: definition, input: { value: 4 }, dependsOn: ['independent'] },
    ], options());
    expect(result.map(call => call.outcome.status)).toEqual(['failed', 'skipped', 'succeeded', 'succeeded']);
    expect(result[1]?.outcome).toEqual({ status: 'skipped', reason: 'dependency_failed', dependencies: ['failed'] });
    expect(order).not.toContain(2); expect(order.indexOf(4)).toBeGreaterThan(order.indexOf(3));
    expect(JSON.stringify(result)).not.toContain('private-failure');
  });

  it('serializes conflicting resource sets without blocking an unrelated ready call', async () => {
    const release = deferred<void>(); const unrelated = deferred<void>(); const order: string[] = [];
    const definition = tool({ execute: async value => {
      order.push(`start-${value.value}`);
      if (value.value === 1) await release.promise;
      if (value.value === 3) unrelated.resolve();
      order.push(`end-${value.value}`); return { result: value.value };
    } });
    const pending = invokeBatch([
      { id: 'first', tool: definition, input: { value: 1 }, resources: ['b', 'a'] },
      { id: 'second', tool: definition, input: { value: 2 }, resources: ['a', 'b'] },
      { id: 'other', tool: definition, input: { value: 3 }, resources: ['c'] },
    ], options({ concurrency: 3 }));
    await unrelated.promise; expect(order).not.toContain('start-2'); release.resolve();
    const result = await pending;
    expect(result.every(call => call.outcome.status === 'succeeded')).toBe(true);
    expect(order.indexOf('start-2')).toBeGreaterThan(order.indexOf('end-1'));
  });

  it('shares the existing atomic budget across parallel tool calls', async () => {
    const execute = vi.fn((value: { value: number }) => ({ result: value.value })); const definition = tool({ execute, costMicros: 5 });
    const budget = new Budget(5, 10);
    const result = await invokeBatch([
      { id: 'a', tool: definition, input: { value: 1 } }, { id: 'b', tool: definition, input: { value: 2 } },
    ], options({ budget }));
    expect(result.map(call => call.outcome.status).sort()).toEqual(['blocked', 'succeeded']);
    expect(execute).toHaveBeenCalledTimes(1); expect(budget.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 1 });
  });

  it('preserves successful effect receipts and skips dependents when output is withheld', async () => {
    const receipts: ExecutionReceipt[] = [];
    const definition = tool({ effects: 'write', guards: { output: [{ id: 'withhold', check: () => ({ decision: 'block' }) }] } });
    const result = await invokeBatch([
      { id: 'write', tool: definition, input: { value: 1 } }, { id: 'next', tool: definition, input: { value: 2 }, dependsOn: ['write'] },
    ], options({ onExecutionReceipt: async receipt => { receipts.push(receipt); } }));
    expect(result[0]?.outcome).toMatchObject({ status: 'blocked', receipt: { callId: 'write', execution: 'succeeded', disclosure: 'withheld' } });
    expect(result[1]?.outcome.status).toBe('skipped'); expect(receipts).toHaveLength(1);
  });

  it('quarantines uncertain resources while unrelated collect-all branches continue', async () => {
    const invoked: number[] = [];
    const definition = tool({ effects: 'write', costMicros: 2, execute: value => { invoked.push(value.value); if (value.value === 1) throw new Error('remote response lost'); return { result: value.value }; } });
    const budget = new Budget(10, 10);
    const result = await invokeBatch([
      { id: 'unknown', tool: definition, input: { value: 1 }, resources: ['account'] },
      { id: 'conflicting', tool: definition, input: { value: 2 }, resources: ['account'] },
      { id: 'other', tool: definition, input: { value: 3 }, resources: ['other'] },
    ], options({ budget }));
    expect(result[0]?.outcome.status).toBe('outcome_unknown');
    expect(result[1]?.outcome).toMatchObject({ status: 'skipped', reason: 'resource_uncertain' });
    expect(result[2]?.outcome.status).toBe('succeeded'); expect(invoked.sort()).toEqual([1, 3]);
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 2, calls: 2 });
  });

  it('does not release a timed-out handler resource to another conflicting call', async () => {
    vi.useFakeTimers(); const execute = vi.fn(() => new Promise<{ result: number }>(() => {}));
    const definition = tool({ timeoutMs: 20, execute });
    const pending = invokeBatch([
      { id: 'timeout', tool: definition, input: { value: 1 }, resources: ['workspace'] },
      { id: 'later', tool: definition, input: { value: 2 }, resources: ['workspace'] },
    ], options());
    await vi.advanceTimersByTimeAsync(25); const result = await pending;
    expect(result[0]?.outcome).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
    expect(result[1]?.outcome).toMatchObject({ status: 'skipped', reason: 'resource_uncertain' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops new fail-fast dispatch and cancels active calls without inventing rollback', async () => {
    const invoked: number[] = [];
    const definition = tool({ effects: 'write', execute: value => {
      invoked.push(value.value); if (value.value === 1) throw new Error('failure after request');
      return new Promise<{ result: number }>(() => {});
    } });
    const result = await invokeBatch([
      { id: 'first', tool: definition, input: { value: 1 } }, { id: 'active', tool: definition, input: { value: 2 } },
      { id: 'pending', tool: definition, input: { value: 3 } },
    ], options({ concurrency: 2, failurePolicy: 'fail-fast' }));
    expect(invoked).toEqual([1, 2]);
    expect(result[0]?.outcome.status).toBe('outcome_unknown'); expect(result[1]?.outcome.status).toBe('outcome_unknown');
    expect(result[2]?.outcome).toEqual({ status: 'skipped', reason: 'fail_fast', dependencies: [] });
  });

  it('propagates parent cancellation and returns an outcome for every accepted call', async () => {
    const controller = new AbortController(); const started = deferred<void>(); const execute = vi.fn(() => { started.resolve(); return new Promise<{ result: number }>(() => {}); });
    const definition = tool({ effects: 'write', execute });
    const pending = invokeBatch([
      { id: 'active', tool: definition, input: { value: 1 } }, { id: 'pending', tool: definition, input: { value: 2 } },
    ], options({ signal: controller.signal, concurrency: 1 }));
    await started.promise; controller.abort('private-cancellation-reason'); const result = await pending;
    expect(result[0]?.outcome).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown' } });
    expect(result[1]?.outcome).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(execute).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('private-cancellation-reason');
  });
});

describe('batch output references', () => {
  const producerOutput = z.object({ nested: z.object({ values: z.array(z.number()) }), label: z.string() });
  const consumerInput = z.object({ selected: z.number(), label: z.string(), whole: producerOutput });
  const consumerOutput = z.object({ result: z.number() });

  function referenceTools(overrides: { producerEffects?: 'none' | 'write'; consumer?: (input: z.infer<typeof consumerInput>) => { result: number } } = {}) {
    const order: string[] = [];
    const producer = defineTool({ id: 'reference.producer', version: '1', description: 'Reference producer.', input, output: producerOutput,
      effects: overrides.producerEffects ?? 'none', capabilities: [], execute: value => { order.push('producer'); return { nested: { values: [value.value, value.value + 1] }, label: `value-${value.value}` }; } });
    const execute = vi.fn((value: z.infer<typeof consumerInput>) => { order.push('consumer'); return overrides.consumer?.(value) ?? { result: value.selected }; });
    const consumer = defineTool({ id: 'reference.consumer', version: '1', description: 'Reference consumer.', input: consumerInput,
      output: consumerOutput, effects: 'none', capabilities: [], execute });
    const permissions = { allow: ['tool:reference.producer', 'tool:reference.consumer', 'effect:write'] };
    return { producer, consumer, execute, order, permissions };
  }

  it('resolves exact root, object and array paths and adds dependency edges automatically', async () => {
    const fixtures = referenceTools({ consumer: value => {
      expect(value).toEqual({ selected: 3, label: 'value-2', whole: { nested: { values: [2, 3] }, label: 'value-2' } });
      return { result: value.selected };
    } });
    const path: (string | number)[] = ['nested', 'values', 1];
    const selected = batchOutput<number>('source', path); path[2] = 0;
    const result = await invokeBatch([
      { id: 'consume', tool: fixtures.consumer, input: { selected, label: batchOutput<string>('source', ['label']), whole: batchOutput('source') } },
      { id: 'source', tool: fixtures.producer, input: { value: 2 } },
    ], options({ permissions: fixtures.permissions, concurrency: 2 }));
    expect(result.map((entry) => entry.outcome.status)).toEqual(['succeeded', 'succeeded']);
    expect(fixtures.order).toEqual(['producer', 'consumer']); expect(fixtures.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown, cyclic, cloned and accessor references before effects', async () => {
    const fixtures = referenceTools();
    const cases: readonly BatchCall[][] = [
      [{ id: 'consume', tool: fixtures.consumer, input: { selected: batchOutput<number>('missing'), label: 'x', whole: { nested: { values: [1] }, label: 'x' } } }],
      [{ id: 'self', tool: fixtures.consumer, input: { selected: batchOutput<number>('self'), label: 'x', whole: { nested: { values: [1] }, label: 'x' } } }],
      [{ id: 'consume', tool: fixtures.consumer, input: { selected: { ...batchOutput<number>('source') } as never, label: 'x', whole: { nested: { values: [1] }, label: 'x' } } },
        { id: 'source', tool: fixtures.producer, input: { value: 1 } }],
    ];
    for (const calls of cases) await expect(invokeBatch(calls, options({ permissions: fixtures.permissions }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    let invoked = false; const hostilePath = Object.defineProperty([], '0', { enumerable: true, get: () => { invoked = true; return 'label'; } });
    expect(() => batchOutput('source', hostilePath)).toThrow(); expect(invoked).toBe(false);
    expect(fixtures.execute).not.toHaveBeenCalled(); expect(fixtures.order).toEqual([]);
  });

  it('reports a missing path after a predecessor effect without dispatching the dependent or implying rollback', async () => {
    const fixtures = referenceTools({ producerEffects: 'write' }); const independent = vi.fn(() => ({ result: 9 }));
    const result = await invokeBatch([
      { id: 'source', tool: fixtures.producer, input: { value: 1 } },
      { id: 'consume', tool: fixtures.consumer, input: { selected: batchOutput<number>('source', ['nested', 'missing']),
        label: 'x', whole: batchOutput('source') } },
      { id: 'independent', tool: tool({ execute: independent }), input: { value: 9 } },
    ], options({ permissions: { allow: [...fixtures.permissions.allow, 'tool:batch.tool'] } }));
    expect(result[0]?.outcome).toMatchObject({ status: 'succeeded', receipt: { execution: 'succeeded' } });
    expect(result[1]?.outcome).toEqual({ status: 'failed', error: { code: 'INVALID_INPUT', message: 'Referenced batch output could not produce a valid input.' } });
    expect(result[2]?.outcome.status).toBe('succeeded'); expect(fixtures.execute).not.toHaveBeenCalled(); expect(independent).toHaveBeenCalledTimes(1);
  });

  it('validates a resolved dependent schema before dispatch while retaining predecessor success', async () => {
    const fixtures = referenceTools({ producerEffects: 'write' });
    const result = await invokeBatch([
      { id: 'source', tool: fixtures.producer, input: { value: 1 } },
      { id: 'consume', tool: fixtures.consumer, input: { selected: batchOutput<number>('source', ['label']),
        label: 'x', whole: batchOutput('source') } },
    ], options({ permissions: fixtures.permissions }));
    expect(result[0]?.outcome.status).toBe('succeeded');
    expect(result[1]?.outcome).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' }, receipt: { execution: 'not_started' } });
    expect(fixtures.execute).not.toHaveBeenCalled();
  });

  it('skips automatic reference dependents when predecessor output is withheld', async () => {
    const fixtures = referenceTools();
    const blockedProducer = defineTool({
      id: 'reference.blocked', version: '1', description: 'Blocked reference producer.', input, output: producerOutput,
      effects: 'none', capabilities: [], execute: value => ({ nested: { values: [value.value] }, label: `value-${value.value}` }),
      guards: { output: [{ id: 'block', check: () => ({ decision: 'block' as const }) }] },
    });
    const result = await invokeBatch([
      { id: 'source', tool: blockedProducer, input: { value: 1 } },
      { id: 'consume', tool: fixtures.consumer, input: { selected: batchOutput<number>('source', ['nested', 'values', 0]),
        label: 'x', whole: { nested: { values: [1] }, label: 'x' } } },
    ], options({ permissions: { allow: ['tool:reference.blocked', 'tool:reference.consumer'] } }));
    expect(result[0]?.outcome.status).toBe('blocked');
    expect(result[1]?.outcome).toEqual({ status: 'skipped', reason: 'dependency_failed', dependencies: ['source'] });
  });

  it('applies fail-fast to resolution failures before later dispatch', async () => {
    const fixtures = referenceTools(); const later = vi.fn(() => ({ result: 7 }));
    const result = await invokeBatch([
      { id: 'source', tool: fixtures.producer, input: { value: 1 } },
      { id: 'bad', tool: fixtures.consumer, input: { selected: batchOutput<number>('source', ['missing']), label: 'x', whole: batchOutput('source') } },
      { id: 'later', tool: tool({ execute: later }), input: { value: 7 } },
    ], options({ permissions: { allow: [...fixtures.permissions.allow, 'tool:batch.tool'] }, concurrency: 1, failurePolicy: 'fail-fast' }));
    expect(result[1]?.outcome.status).toBe('failed'); expect(result[2]?.outcome).toEqual({ status: 'skipped', reason: 'fail_fast', dependencies: [] });
    expect(later).not.toHaveBeenCalled();
  });

  it('enforces the resolved aggregate byte bound before the dependent dispatch', async () => {
    const largeOutput = z.object({ data: z.string() });
    const producer = defineTool({ id: 'reference.large', version: '1', description: 'Large output.', input, output: largeOutput,
      effects: 'none', capabilities: [], execute: () => ({ data: 'x'.repeat(900_000) }) });
    const consume = vi.fn(() => ({ result: 1 }));
    const consumer = defineTool({ id: 'reference.large-consumer', version: '1', description: 'Large consumer.', input: largeOutput,
      output: consumerOutput, effects: 'none', capabilities: [], execute: consume });
    const sources = Array.from({ length: 5 }, (_, index) => ({ id: `source-${index}`, tool: producer, input: { value: index } }));
    const consumers = sources.map((source, index) => ({ id: `consume-${index}`, tool: consumer, input: batchOutput(source.id) }));
    const result = await invokeBatch([...sources, ...consumers], options({
      permissions: { allow: ['tool:reference.large', 'tool:reference.large-consumer'] }, maxOutputBytes: 1_000_000, concurrency: 5,
    }));
    expect(result.slice(0, 5).every((entry) => entry.outcome.status === 'succeeded')).toBe(true);
    expect(result.slice(5, 9).every((entry) => entry.outcome.status === 'succeeded')).toBe(true);
    expect(result[9]?.outcome).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
    expect(consume).toHaveBeenCalledTimes(4);
  });

  it('bounds output handles per template before any handler executes', async () => {
    const fixtures = referenceTools(); const references = Array.from({ length: 65 }, () => batchOutput('source'));
    await expect(invokeBatch([
      { id: 'source', tool: fixtures.producer, input: { value: 1 } },
      { id: 'consume', tool: fixtures.consumer, input: { selected: 1, label: 'x', whole: { nested: { values: references as never }, label: 'x' } } },
    ], options({ permissions: fixtures.permissions }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixtures.order).toEqual([]);
  });
});
