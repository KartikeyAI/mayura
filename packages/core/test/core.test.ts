import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { Budget, MayuraError, assertSchema, freezeJson, jsonValue, publicError, validate } from '../src/index.js';

describe('bounded JSON boundary', () => {
  it('copies JSON rather than preserving mutable aliases', () => {
    const value = { nested: [1, 'hello', null] };
    const copy = jsonValue(value);
    value.nested.push(2);
    expect(copy).toEqual({ nested: [1, 'hello', null] });
    expect(Object.isFrozen(freezeJson(copy))).toBe(true);
  });
  it('does not invoke accessors or toJSON', () => {
    let observed = false;
    const value = { get secret() { observed = true; return 'secret'; } };
    expect(() => jsonValue(value)).toThrow(MayuraError);
    expect(observed).toBe(false);
    expect(() => jsonValue(new Date())).toThrow(MayuraError);
  });
  it.each([undefined, NaN, Infinity, 2n, new Map(), () => 1, Number.MAX_SAFE_INTEGER + 1])('rejects unsupported values', value => {
    expect(() => jsonValue(value)).toThrow(MayuraError);
  });
  it('rejects cycles, sparse arrays, dangerous keys and configured bounds', () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => jsonValue(cyclic)).toThrow(MayuraError);
    expect(() => jsonValue(new Array(3))).toThrow(MayuraError);
    expect(() => jsonValue(JSON.parse('{"__proto__":1}'))).toThrow(MayuraError);
    expect(() => jsonValue('hello', { maxBytes: 4 })).toThrow(MayuraError);
    expect(() => jsonValue([[[0]]], { maxDepth: 2 })).toThrow(MayuraError);
    expect(() => jsonValue([1, 2], { maxNodes: 2 })).toThrow(MayuraError);
  });
  it('round-trips JSON primitives and arrays under property testing', () => {
    fc.assert(fc.property(fc.array(fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.constant(null))), value => {
      expect(jsonValue(value)).toEqual(value);
    }), { numRuns: 200 });
  });
});

describe('Standard Schema boundary', () => {
  it('accepts Zod without core depending on Zod', async () => {
    expect(await validate(z.object({ name: z.string() }), { name: 'Mayura' }, 'input')).toEqual({ name: 'Mayura' });
  });
  it('validates transformations and rejects non-JSON transformed output', async () => {
    expect(await validate(z.string().transform(s => s.length), 'abc', 'input')).toBe(3);
    await expect(validate(z.string().transform(() => new Date()), 'x', 'output')).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('does not disclose custom validator messages', async () => {
    await expect(validate(z.string('secret'), 2, 'input')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    try { await validate(z.string('secret'), 2, 'input'); } catch (error) { expect(String(error)).not.toContain('secret'); }
    expect(() => assertSchema({} as never)).toThrow(MayuraError);
  });
});

describe('budget reservations', () => {
  it('retains unknown usage and makes concurrent reservation admission atomic', async () => {
    const budget = new Budget(10, 10);
    const result = await Promise.allSettled([1, 2, 3].map(async () => budget.reserve(5)));
    expect(result.filter(x => x.status === 'fulfilled')).toHaveLength(2);
    expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 10, calls: 2 });
  });
  it('settles once and never treats an over-bound report as free', () => {
    const budget = new Budget(10, 3);
    const reservation = budget.reserve(8);
    expect(() => reservation.settle(-1)).toThrow(MayuraError);
    expect(budget.snapshot().reservedMicros).toBe(8);
    reservation.settle(6);
    expect(() => reservation.settle(0)).toThrow(MayuraError);
    expect(budget.snapshot()).toEqual({ spentMicros: 6, reservedMicros: 0, calls: 1 });
  });
  it('records known provider overruns instead of truncating spending', () => {
    const budget = new Budget(10, 10);
    const reservation = budget.reserve(8);
    expect(() => reservation.settle(12)).toThrow(MayuraError);
    expect(budget.snapshot()).toEqual({ spentMicros: 12, reservedMicros: 0, calls: 1 });
    expect(() => budget.reserve(0)).toThrow(MayuraError);
  });
  it('charges even free calls against call count', () => {
    const budget = new Budget(0, 1);
    budget.reserve(0).settle(0);
    expect(() => budget.reserve(0)).toThrow(MayuraError);
  });
  it('blocks admissions after a bound violation even with unused root budget', () => {
    const budget = new Budget(100, 10);
    expect(() => budget.reserve(1).settle(2)).toThrow(MayuraError);
    expect(() => budget.reserve(1)).toThrow(MayuraError);
  });
  it('retains exact known overrun totals outside the safe-number range', () => {
    const budget = new Budget(0, 2);
    const first = budget.reserve(0); const second = budget.reserve(0);
    expect(() => first.settle(Number.MAX_SAFE_INTEGER)).toThrow(MayuraError);
    expect(() => second.settle(Number.MAX_SAFE_INTEGER)).toThrow(MayuraError);
    expect(budget.snapshot().spentMicros).toBe('18014398509481982');
  });
});

it('sanitizes unknown errors', () => {
  expect(publicError(new Error('secret'))).toEqual({ code: 'TOOL_FAILED', message: 'The operation failed. Inspect authorized local diagnostics.' });
});
