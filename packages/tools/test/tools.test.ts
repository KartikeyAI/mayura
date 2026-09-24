import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, MayuraError, type Guard, type Schema } from '@mayura/core';
import { assertTool, defineTool, invokeTool, type InvokeToolContext, type ToolOptions, type ToolOutput } from '../src/index.js';

const inputSchema = z.object({ value: z.number() });
const outputSchema = z.object({ result: z.number() });

function tool(overrides: Partial<ToolOptions<typeof inputSchema, typeof outputSchema>> = {}) {
  return defineTool({
    id: 'number.double', version: '1.0.0', description: 'Double a number.',
    input: inputSchema, output: outputSchema, effects: 'none', capabilities: [],
    execute: ({ value }) => ({ result: value * 2 }), ...overrides,
  });
}

function context(overrides: Partial<InvokeToolContext> = {}): InvokeToolContext {
  return {
    runId: 'run-1', callId: 'call-1', scope: { principalId: 'person-1', projectId: 'project-1' },
    signal: new AbortController().signal,
    permissions: { allow: ['tool:number.double'] }, budget: new Budget(100, 20), ...overrides,
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('tool authoring and schemas', () => {
  it('infers schema inputs and outputs with no runtime validator dependency', async () => {
    const definition = tool({ execute: ({ value }) => { expectTypeOf(value).toEqualTypeOf<number>(); return { result: value * 2 }; } });
    expectTypeOf<ToolOutput<typeof definition>>().toEqualTypeOf<{ result: number }>();
    const result = await invokeTool(definition, { value: 5 }, context());
    expect(result).toMatchObject({ status: 'succeeded', output: { result: 10 }, receipt: { execution: 'succeeded', disclosure: 'released' } });
    expect('execute' in definition).toBe(false);
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it('rejects invalid input before executing', async () => {
    const execute = vi.fn(() => ({ result: 0 }));
    const result = await invokeTool(tool({ execute }), { value: 'private-input' }, context());
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-input');
  });

  it('preserves a successful effect receipt when output validation fails', async () => {
    const definition = tool({ execute: () => ({ result: 'private-invalid-output' }) as unknown as { result: number } });
    const result = await invokeTool(definition, { value: 1 }, context());
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' }, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect(JSON.stringify(result)).not.toContain('private-invalid-output');
  });

  it('supports explicitly validated input and output transformations', async () => {
    const definition = defineTool({
      id: 'number.double', version: '1.0.0', description: 'Transform example.',
      input: z.string().transform((value) => value.length), output: z.number().transform((result) => ({ result })),
      effects: 'none', capabilities: [], execute: (length) => { expectTypeOf(length).toEqualTypeOf<number>(); return length * 2; },
    });
    expectTypeOf<ToolOutput<typeof definition>>().toEqualTypeOf<{ result: number }>();
    expect(await invokeTool(definition, 'hello', context())).toMatchObject({ status: 'succeeded', output: { result: 10 } });
  });

  it('rejects non-JSON transformed output even when a validator accepts it', async () => {
    const definition = defineTool({
      id: 'number.double', version: '1', description: 'Invalid date output.', input: inputSchema,
      output: z.number().transform(() => new Date()), effects: 'none', capabilities: [], execute: () => 1,
    });
    expect(await invokeTool(definition, { value: 1 }, context())).toMatchObject({ error: { code: 'INVALID_OUTPUT' }, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
  });

  it('rejects malformed definitions and invalid limit configuration', () => {
    expect(() => tool({ id: '' })).toThrow(MayuraError);
    expect(() => tool({ timeoutMs: 0 })).toThrow(MayuraError);
    expect(() => tool({ timeoutMs: 2_147_483_648 })).toThrow(MayuraError);
    expect(() => tool({ costMicros: -1 })).toThrow(MayuraError);
    expect(() => tool({ capabilities: ['same', 'same'] })).toThrow(MayuraError);
  });

  it('bounds disclosed output bytes', async () => {
    const result = await invokeTool(tool(), { value: 1 }, context({ maxOutputBytes: 3 }));
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' }, receipt: { execution: 'succeeded' } });
  });
});

describe('authorization and immutable snapshots', () => {
  it('denies even pure tools without the exact tool grant', async () => {
    const execute = vi.fn(() => ({ result: 0 }));
    const result = await invokeTool(tool({ execute }), { value: 1 }, context({ permissions: { allow: [] } }));
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires tool, effect, and every additional capability', async () => {
    const execute = vi.fn(() => ({ result: 2 }));
    const definition = tool({ effects: 'write', capabilities: ['project:write'], execute });
    for (const allow of [['tool:number.double'], ['tool:number.double', 'effect:write'], ['tool:number.double', 'project:write']]) {
      expect(await invokeTool(definition, { value: 1 }, context({ permissions: { allow } }))).toMatchObject({ status: 'blocked' });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await invokeTool(definition, { value: 1 }, context({ permissions: { allow: ['tool:number.double', 'effect:write', 'project:write'] } }))).toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not accept forged metadata as an executable definition', async () => {
    expect(() => assertTool({ ...tool() })).toThrow(MayuraError);
    expect(await invokeTool({ ...tool() }, { value: 1 }, context())).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
  });

  it('copies input, capabilities, scope, and executor before asynchronous work', async () => {
    const capabilities = ['extra:read'];
    const options = {
      id: 'number.double', version: '1', description: 'Snapshot tool.', input: inputSchema, output: outputSchema,
      effects: 'none' as const, capabilities,
      execute: ({ value }: { value: number }) => ({ result: value * 2 }),
    };
    const definition = defineTool(options);
    capabilities.push('extra:write');
    options.execute = () => ({ result: 999 });
    const input = { value: 2 };
    const scope = { principalId: 'person-1', projectId: 'project-1' };
    const grants = ['tool:number.double', 'extra:read'];
    const pending = invokeTool(definition, input, context({ scope, permissions: { allow: grants } }));
    input.value = 100;
    scope.projectId = 'project-2';
    grants.length = 0;
    expect(await pending).toMatchObject({ status: 'succeeded', output: { result: 4 } });
    expect(definition.capabilities).toEqual(['extra:read']);
  });

  it('captures the schema validator without freezing its consumer object', async () => {
    const standard = { version: 1 as const, vendor: 'fixture', validate: () => ({ value: { value: 5 } }) };
    const schema: Schema<{ value: number }> = { '~standard': standard };
    const definition = defineTool({ id: 'number.double', version: '1', description: 'Captured schema.', input: schema, output: outputSchema, effects: 'none', capabilities: [], execute: ({ value }) => ({ result: value }) });
    standard.validate = () => ({ value: { value: 999 } });
    expect(await invokeTool(definition, {}, context())).toMatchObject({ status: 'succeeded', output: { result: 5 } });
    expect(Object.isFrozen(schema)).toBe(false);
  });
});

describe('mandatory execution receipt persistence', () => {
  it('rechecks processed immutable input after guards and before dispatch', async () => {
    const order: string[] = [];
    const definition = tool({
      guards: { input: [{ id: 'input-check', check: () => { order.push('guard'); return { decision: 'allow' }; } }] },
      execute: ({ value }) => { order.push('execute'); return { result: value }; },
    });
    const result = await invokeTool(definition, { value: 1 }, context({ beforeDispatch: async (input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(input).toEqual({ value: 1 });
      order.push('claim');
    } }));
    expect(result.status).toBe('succeeded');
    expect(order).toEqual(['guard', 'claim', 'execute']);
  });

  it('denies failed claim rechecks before dispatch and redacts their errors', async () => {
    const execute = vi.fn(() => ({ result: 1 }));
    const budget = new Budget(10, 2);
    const result = await invokeTool(tool({ execute }), { value: 1 }, context({ budget, beforeDispatch: async () => { throw new MayuraError('OUTCOME_UNKNOWN', 'private-claim-state'); } }));
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
    expect(budget.snapshot().calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private-claim-state');
  });

  it('bounds hanging admission callbacks without dispatching', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => ({ result: 1 }));
    const pending = invokeTool(tool({ timeoutMs: 20, execute }), { value: 1 }, context({ beforeDispatch: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ error: { code: 'TIMEOUT' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records completion before validating or disclosing output', async () => {
    const order: string[] = [];
    const output: Schema<{ result: number }> = { '~standard': { version: 1, vendor: 'order', validate: (value) => {
      order.push('validate-output'); return { value: value as { result: number } };
    } } };
    const definition = defineTool({
      id: 'number.double', version: '1', description: 'Persistence order.', input: inputSchema, output,
      effects: 'none', capabilities: [], execute: () => { order.push('execute'); return { result: 1 }; },
      guards: { output: [{ id: 'output-check', check: () => { order.push('guard-output'); return { decision: 'allow' }; } }] },
    });
    const result = await invokeTool(definition, { value: 1 }, context({ onExecutionReceipt: async (receipt) => {
      order.push('persist');
      expect(receipt).toEqual({ callId: 'call-1', toolId: 'number.double', execution: 'succeeded', disclosure: 'withheld' });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect('output' in receipt).toBe(false);
    } }));
    expect(result.status).toBe('succeeded');
    expect(order).toEqual(['execute', 'persist', 'validate-output', 'guard-output']);
  });

  it('withholds output with outcome_unknown when successful-effect persistence fails', async () => {
    const guard = vi.fn(() => ({ decision: 'allow' as const }));
    const result = await invokeTool(tool({ guards: { output: [{ id: 'output-check', check: guard }] } }), { value: 1 }, context({ onExecutionReceipt: async () => { throw new Error('private-storage-error'); } }));
    expect(result).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' }, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect(guard).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-storage-error');
  });

  it('bounds persistence callback time without losing the completed-effect receipt', async () => {
    vi.useFakeTimers();
    const pending = invokeTool(tool({ timeoutMs: 20 }), { value: 1 }, context({ onExecutionReceipt: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'succeeded', disclosure: 'withheld' } });
  });

  it('records unknown external execution without laundering it into success', async () => {
    const record = vi.fn(async () => {});
    const pending = await invokeTool(tool({ effects: 'write', execute: () => { throw new Error(); } }), { value: 1 }, context({ permissions: { allow: ['tool:number.double', 'effect:write'] }, onExecutionReceipt: record }));
    expect(record).toHaveBeenCalledWith(
      { callId: 'call-1', toolId: 'number.double', execution: 'unknown', disclosure: 'withheld' },
      { knownCostMicros: 0, unknownCostMicros: 0 },
    );
    expect(pending.status).toBe('outcome_unknown');
  });

  it('settles a trusted dynamic usage report below the declared maximum', async () => {
    const budget = new Budget(10, 1); const record = vi.fn(async () => {});
    const definition = tool({ costMicros: 10, execute: (input, executionContext) => {
      executionContext.reportUsage({ knownCostMicros: 3, unknownCostMicros: 0 }); return { result: input.value };
    } });
    const result = await invokeTool(definition, { value: 2 }, context({ budget, onExecutionReceipt: record }));
    expect(result.status).toBe('succeeded');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ execution: 'succeeded' }), { knownCostMicros: 3, unknownCostMicros: 0 });
    expect(budget.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
  });

  it('withholds success when reported usage remains unresolved', async () => {
    const budget = new Budget(10, 1); const record = vi.fn(async () => {});
    const definition = tool({ effects: 'write', costMicros: 10, execute: (input, executionContext) => {
      executionContext.reportUsage({ knownCostMicros: 2, unknownCostMicros: 3 }); return { result: input.value };
    } });
    const result = await invokeTool(definition, { value: 2 }, context({ budget,
      permissions: { allow: ['tool:number.double', 'effect:write'] }, onExecutionReceipt: record }));
    expect(result).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ execution: 'unknown' }), { knownCostMicros: 2, unknownCostMicros: 3 });
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 3, calls: 1 });
  });

  it('cannot use persistence hooks to bypass authorization', async () => {
    const record = vi.fn(async () => {});
    const execute = vi.fn(() => ({ result: 1 }));
    await invokeTool(tool({ execute }), { value: 1 }, context({ permissions: { allow: [] }, onExecutionReceipt: record }));
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('guard barriers', () => {
  it('blocks before dispatch and never includes the guard reason', async () => {
    const execute = vi.fn(() => ({ result: 1 }));
    const block: Guard = { id: 'block', check: () => ({ decision: 'block', reason: 'private-guard-reason' }) };
    const result = await invokeTool(tool({ execute, guards: { input: [block] } }), { value: 1 }, context());
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-guard-reason');
  });

  it('fails closed when any parallel guard throws', async () => {
    const checks: string[] = [];
    const guards: Guard[] = [
      { id: 'allow', check: () => { checks.push('allow'); return { decision: 'allow' }; } },
      { id: 'error', check: () => { checks.push('error'); throw new Error('secret'); } },
    ];
    const execute = vi.fn(() => ({ result: 1 }));
    expect(await invokeTool(tool({ execute, guards: { input: guards } }), { value: 1 }, context())).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(checks).toEqual(['allow', 'error']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('withholds output without denying the already completed effect', async () => {
    const result = await invokeTool(tool({ guards: { output: [{ id: 'block', check: () => ({ decision: 'block' }) }] } }), { value: 1 }, context());
    expect(result).toMatchObject({ status: 'blocked', receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect('output' in result).toBe(false);
  });

  it('passes immutable values and scope to guards and handlers', async () => {
    const checks: Guard[] = [{ id: 'freeze-check', check: (value, guardContext) => {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(guardContext.scope)).toBe(true);
      expect(guardContext.boundary).toBe('input');
      return { decision: 'allow' };
    } }];
    const result = await invokeTool(tool({ guards: { input: checks }, execute: (value, executionContext) => {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(executionContext)).toBe(true);
      return { result: value.value };
    } }), { value: 2 }, context());
    expect(result.status).toBe('succeeded');
  });
});

describe('deadlines, cancellation, budgets, and secrecy', () => {
  it('rejects an already cancelled invocation before execution', async () => {
    const controller = new AbortController(); controller.abort('private-reason');
    const execute = vi.fn(() => ({ result: 1 }));
    const result = await invokeTool(tool({ execute }), { value: 1 }, context({ signal: controller.signal }));
    expect(result).toMatchObject({ status: 'cancelled', receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-reason');
  });

  it('bounds a hanging async validator before tool dispatch', async () => {
    vi.useFakeTimers();
    const schema: Schema<{ value: number }> = { '~standard': { version: 1, vendor: 'hang', validate: () => new Promise(() => {}) } };
    const execute = vi.fn(() => ({ result: 1 }));
    const definition = defineTool({ id: 'number.double', version: '1', description: 'Hanging validation.', input: schema, output: outputSchema, effects: 'none', capabilities: [], timeoutMs: 20, execute });
    const result = invokeTool(definition, { value: 1 }, context());
    await vi.advanceTimersByTimeAsync(21);
    expect(await result).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('bounds a hanging required guard', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => ({ result: 1 }));
    const result = invokeTool(tool({ timeoutMs: 20, execute, guards: { input: [{ id: 'hang', check: () => new Promise(() => {}) }] } }), { value: 1 }, context());
    await vi.advanceTimersByTimeAsync(21);
    expect(await result).toMatchObject({ error: { code: 'TIMEOUT' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('retains the reservation and unknown receipt for a timed-out external effect', async () => {
    vi.useFakeTimers();
    const budget = new Budget(10, 2);
    const definition = tool({ effects: 'write', costMicros: 5, timeoutMs: 20, execute: () => new Promise(() => {}) });
    const pending = invokeTool(definition, { value: 1 }, context({ budget, permissions: { allow: ['tool:number.double', 'effect:write'] } }));
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' }, receipt: { execution: 'unknown', disclosure: 'withheld' } });
    expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 5, calls: 1 });
  });

  it('returns promptly on cancellation while an effect handler remains pending', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const start = new Promise<void>((resolve) => { entered = resolve; });
    const definition = tool({ effects: 'read', execute: () => { entered(); return new Promise(() => {}); } });
    const pending = invokeTool(definition, { value: 1 }, context({ signal: controller.signal, permissions: { allow: ['tool:number.double', 'effect:read'] } }));
    await start;
    controller.abort();
    expect(await pending).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown' } });
  });

  it('removes signal listeners after successful and rejected execution', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await invokeTool(tool(), { value: 1 }, context({ signal: controller.signal }));
    await invokeTool(tool(), { value: 1 }, context({ signal: controller.signal, permissions: { allow: [] } }));
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(remove.mock.calls[1]?.[1]).toBe(add.mock.calls[1]?.[1]);
  });

  it('shares admission budget across concurrent tool invocations', async () => {
    const budget = new Budget(5, 20);
    const definition = tool({ costMicros: 5 });
    const results = await Promise.all([invokeTool(definition, { value: 1 }, context({ budget })), invokeTool(definition, { value: 2 }, context({ budget }))]);
    expect(results.map((result) => result.status).sort()).toEqual(['blocked', 'succeeded']);
    expect(budget.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 1 });
  });

  it('charges completed execution even when an output guard blocks disclosure', async () => {
    const budget = new Budget(10, 2);
    await invokeTool(tool({ costMicros: 5, guards: { output: [{ id: 'block', check: () => ({ decision: 'block' }) }] } }), { value: 1 }, context({ budget }));
    expect(budget.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 1 });
  });

  it('redacts raw and framework-shaped handler exceptions', async () => {
    for (const error of [new Error('raw-secret'), new MayuraError('TOOL_FAILED', 'typed-secret')]) {
      const result = await invokeTool(tool({ execute: () => { throw error; } }), { value: 1 }, context());
      expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' }, receipt: { execution: 'failed' } });
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it('does not classify a thrown external-effect handler as definitely failed', async () => {
    const result = await invokeTool(tool({ effects: 'host', execute: () => { throw new Error('failed after remote commit'); } }), { value: 1 }, context({ permissions: { allow: ['tool:number.double', 'effect:host'] } }));
    expect(result).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown' } });
  });
});
