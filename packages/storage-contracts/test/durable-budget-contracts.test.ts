import { describe, expect, it, vi } from 'vitest';
import * as contracts from '../src/index.js';

const key = { scope: 'project/मयूर', id: 'budget/one', policyHash: 'a'.repeat(64) };
const command = (method: contracts.DurableBudgetMethod, raw: unknown): Record<string, unknown> => contracts.durableBudgetCommand(method, raw);
const snapshot = (raw: unknown): contracts.DurableBudgetSnapshot => contracts.durableBudgetSnapshot(raw, key);
const result = (method: contracts.DurableBudgetMethod, raw: unknown, input: unknown): unknown => contracts.durableBudgetResult(method, raw, input);
function root() {
  return { ...key, format: 1, mode: 'shared-ceiling-v1', owner: 'host-v1', version: 1, eventSequence: 1, blocked: false,
    accounts: [{ id: 'root', parentId: null, maxCostMicros: 10, maxCalls: 10, closed: false, spentMicros: 0 as number | string, reservedMicros: 0, calls: 0, heldCalls: 0 }],
    bundles: [] as { id: string; accountId: string; operations: { id: string; maxCostMicros: number }[] }[],
    reservations: [] as { id: string; accountId: string; bundleId: string; maxCostMicros: number; status: string; actualMicros: number | null }[] };
}
function held() {
  const value = root(); value.version = value.eventSequence = 2;
  value.accounts[0]!.reservedMicros = 7; value.accounts[0]!.heldCalls = 1;
  value.bundles.push({ id: 'bundle', accountId: 'root', operations: [{ id: 'ticket', maxCostMicros: 7 }] });
  value.reservations.push({ id: 'ticket', accountId: 'root', bundleId: 'bundle', maxCostMicros: 7, status: 'held', actualMicros: null }); return value;
}

describe('durable budget contracts', () => {
  it('exports explicit command, snapshot and transport-result boundaries', () => {
    expect(Reflect.get(contracts, 'durableBudgetCommand')).toBeTypeOf('function');
    expect(Reflect.get(contracts, 'durableBudgetSnapshot')).toBeTypeOf('function');
    expect(Reflect.get(contracts, 'durableBudgetResult')).toBeTypeOf('function');
  });

  it('owns exact bounded commands and defaults event cursors before transport', () => {
    const input = { ...key, accountId: 'root', bundleId: 'bundle', operations: [{ id: 'ticket', maxCostMicros: 0 }] };
    const captured = command('reserveBundle', input); input.operations[0]!.maxCostMicros = 99;
    expect(captured['operations']).toEqual([{ id: 'ticket', maxCostMicros: 0 }]); expect(Object.isFrozen(captured)).toBe(true);
    expect(command('events', key)).toEqual({ ...key, after: 0 }); expect(command('initialize', {})).toEqual({});
  });

  it('rejects accessors, unsupported owners and unknown fields without getter execution', () => {
    const getter = vi.fn(() => 1);
    for (const value of [null, [], { ...key, maxCostMicros: 0, maxCalls: 1, owner: 'scheduler-v1' },
      Object.defineProperty({ ...key, maxCostMicros: 0 }, 'maxCalls', { enumerable: true, get: getter })]) {
      expect(() => command('create', value)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects malformed keys, IDs, costs and operation arrays', () => {
    for (const change of [{ scope: '' }, { scope: 'अ'.repeat(86) }, { id: 'bad\0id' }, { policyHash: 'A'.repeat(64) },
      { maxCostMicros: -1 }, { maxCostMicros: Number.MAX_SAFE_INTEGER + 1 }, { maxCalls: 0 }]) {
      expect(() => command('create', { ...key, maxCostMicros: 0, maxCalls: 1, ...change })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    for (const operations of [[], [{ id: 'bad id', maxCostMicros: 0 }], [{ id: 'x', maxCostMicros: 0 }, { id: 'x', maxCostMicros: 0 }],
      Array.from({ length: 33 }, (_, index) => ({ id: `x${index}`, maxCostMicros: 0 }))]) {
      expect(() => command('reserveBundle', { ...key, accountId: 'root', bundleId: 'bundle', operations })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it.each(['scope', 'id'] as const)('rejects lossy UTF-16 %s keys while preserving bounded supplementary characters', field => {
    for (const malformed of ['\ud800', '\udfff', 'prefix\ud800suffix', '\udfff-tail']) {
      expect(() => command('create', { ...key, maxCostMicros: 0, maxCalls: 1, [field]: malformed }))
        .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    const exactByteLimit = '\u{1F680}'.repeat(64);
    expect(command('create', { ...key, maxCostMicros: 0, maxCalls: 1, [field]: exactByteLimit })[field]).toBe(exactByteLimit);
    expect(() => command('create', { ...key, maxCostMicros: 0, maxCalls: 1, [field]: `${exactByteLimit}\u{1F680}` }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('validates frozen full state and independently derives ancestor counters', () => {
    const value = held(); const owned = snapshot(value); value.accounts[0]!.reservedMicros = 0;
    expect(Object.isFrozen(owned)).toBe(true); expect((owned['accounts'] as typeof value.accounts)[0]!.reservedMicros).toBe(7);
    expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
  });

  it('rejects forged topology, projections, limits and ticket evidence', () => {
    const changes: ((value: ReturnType<typeof held>) => void)[] = [
      value => { value.mode = 'other'; }, value => { value.owner = 'scheduler-v1'; }, value => { value.policyHash = 'b'.repeat(64); },
      value => { value.accounts[0]!.parentId = 'root' as never; }, value => { value.accounts[0]!.calls = 1; },
      value => { value.reservations[0]!.actualMicros = 0; }, value => { value.bundles[0]!.operations[0]!.maxCostMicros = 8; },
      value => { value.reservations[0]!.accountId = 'missing'; }, value => { value.blocked = true; },
      value => { value.eventSequence = 1; }, value => { value.accounts[0]!.maxCostMicros = 6; },
    ];
    for (const mutate of changes) { const value = held(); mutate(value); expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' })); }
  });

  it('admits exact cumulative overrun strings but rejects unsafe and noncanonical totals', () => {
    const value = held(); const maximum = Number.MAX_SAFE_INTEGER;
    value.version = value.eventSequence = 6; value.blocked = true;
    value.accounts[0]!.reservedMicros = value.accounts[0]!.heldCalls = 0; value.accounts[0]!.calls = 2;
    value.accounts[0]!.spentMicros = (BigInt(maximum) * 2n).toString();
    value.bundles[0]!.operations.push({ id: 'ticket2', maxCostMicros: 0 });
    Object.assign(value.reservations[0]!, { status: 'settled', actualMicros: maximum });
    value.reservations.push({ id: 'ticket2', accountId: 'root', bundleId: 'bundle', maxCostMicros: 0, status: 'settled', actualMicros: maximum });
    expect(snapshot(value)).toMatchObject({ blocked: true });
    for (const spent of ['01', '0', '+9007199254740992', '9007199254740993', '1e20', '9'.repeat(100)]) {
      value.accounts[0]!.spentMicros = spent; expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    }
  });

  it.each(['root', 'child'] as const)('does not let an overrun hide impossible nominal spending in a %s ceiling', owner => {
    const value = root(); value.version = value.eventSequence = owner === 'root' ? 9 : 10; value.blocked = true;
    if (owner === 'child') {
      value.accounts[0]!.maxCostMicros = 100;
      value.accounts.unshift({ ...value.accounts[0]!, id: 'child', parentId: 'root' as never, maxCostMicros: 10 });
    }
    for (const account of value.accounts) Object.assign(account, { spentMicros: 110, reservedMicros: 10, calls: 3 });
    for (const [id, bound, status, actual] of [['a', 1, 'settled', 100], ['b', 10, 'settled', 10], ['c', 10, 'started', null]] as const) {
      value.bundles.push({ id, accountId: owner, operations: [{ id, maxCostMicros: bound }] });
      value.reservations.push({ id, accountId: owner, bundleId: id, maxCostMicros: bound, status, actualMicros: actual });
    }
    // The committed nominal amount is 1 + 10 + 10, independent of the excess
    // actual cost. No sequence of valid admissions fits that in a ceiling of 10.
    expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    expect(() => result('inspect', value, key)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
  });

  it('checks nominal ancestor usage across siblings while retaining valid exact overruns', () => {
    const value = root(); value.version = value.eventSequence = 11; value.blocked = true;
    value.accounts.unshift({ ...value.accounts[0]!, id: 'a', parentId: 'root' as never }, { ...value.accounts[0]!, id: 'b', parentId: 'root' as never });
    Object.assign(value.accounts[0]!, { spentMicros: 100, calls: 1 });
    Object.assign(value.accounts[1]!, { spentMicros: 5, reservedMicros: 5, calls: 2 });
    Object.assign(value.accounts[2]!, { spentMicros: 105, reservedMicros: 5, calls: 3 });
    for (const [id, owner, bound, status, actual] of [['a', 'a', 1, 'settled', 100], ['b', 'b', 5, 'settled', 5], ['c', 'b', 5, 'started', null]] as const) {
      value.bundles.push({ id, accountId: owner, operations: [{ id, maxCostMicros: bound }] });
      value.reservations.push({ id, accountId: owner, bundleId: id, maxCostMicros: bound, status, actualMicros: actual });
    }
    // Each child's nominal amount fits; their shared ancestor's amount does not.
    expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    value.bundles[2]!.operations[0]!.maxCostMicros = value.reservations[2]!.maxCostMicros = 4;
    value.accounts[1]!.reservedMicros = value.accounts[2]!.reservedMicros = 4;
    const accepted = snapshot(value);
    expect(accepted.blocked).toBe(true); expect(accepted.accounts[2]!.spentMicros).toBe(105);
    expect(accepted.accounts[2]!.reservedMicros).toBe(4);
  });

  it('rejects historically impossible bundles after held counters have been released', () => {
    const value = held(); value.version = value.eventSequence = 3;
    value.accounts[0]!.reservedMicros = value.accounts[0]!.heldCalls = 0;
    value.reservations[0]!.status = 'cancelled';
    value.bundles[0]!.operations.push({ id: 'ticket2', maxCostMicros: 7 });
    value.reservations.push({ id: 'ticket2', accountId: 'root', bundleId: 'bundle', maxCostMicros: 7, status: 'cancelled', actualMicros: null });
    expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    value.accounts[0]!.maxCostMicros = 20; value.accounts[0]!.maxCalls = 1;
    expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
  });

  it('rejects invented history that consumes reserved terminal evidence capacity', () => {
    for (const version of [1, 2_048]) {
      const value = held(); value.version = value.eventSequence = version;
      expect(() => snapshot(value)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    }
  });

  it('checks transport reply envelopes, command identity and postconditions', () => {
    const create = { ...key, maxCostMicros: 10, maxCalls: 10 };
    expect(result('create', { snapshot: root(), created: true }, create)).toMatchObject({ created: true });
    expect(result('inspect', undefined, key)).toBeUndefined();
    for (const raw of [{ snapshot: root(), created: true, extra: true }, { snapshot: held(), created: true }, { snapshot: root(), created: 'yes' }]) {
      expect(() => result('create', raw, create)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    }
    expect(() => result('start', { snapshot: held(), status: 'started' }, { ...key, accountId: 'root', reservationId: 'ticket' }))
      .toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
  });

  it('never reports a fresh start from an already closed ancestor snapshot', () => {
    const value = held(); value.version = value.eventSequence = 4;
    value.accounts[0]!.closed = true; value.accounts[0]!.calls = 1; value.accounts[0]!.heldCalls = 0;
    value.reservations[0]!.status = 'started';
    const input = { ...key, accountId: 'root', reservationId: 'ticket' };
    expect(result('start', { snapshot: value, status: 'already_started' }, input)).toMatchObject({ status: 'already_started' });
    expect(() => result('start', { snapshot: value, status: 'started' }, input)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
  });

  it('validates exact event fields, metadata and increasing bounded sequences', () => {
    const event = { sequence: 1, createdAt: '2026-09-21T00:00:00.000Z', type: 'budget.created', data: {} };
    expect(result('events', [event], { ...key, after: 0 })).toEqual([event]);
    for (const events of [[event, event], [{ ...event, type: 'other' }], [{ ...event, data: { secret: true } }], [{ ...event, createdAt: 'yesterday' }]]) {
      expect(() => result('events', events, { ...key, after: 0 })).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    }
  });
});
