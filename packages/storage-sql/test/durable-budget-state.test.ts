import { describe, expect, it } from 'vitest';
import type { DurableBudgetMethod, DurableBudgetSnapshot } from '@mayura/storage-contracts';
import {
  initialDurableBudgetState, initialWorkflowTreeBudgetState,
  reduceDurableBudgetState, reduceWorkflowTreeBudgetState,
} from '../src/durable-budget-state.js';

const key = { scope: 'financial/मयूर', id: 'tree', policyHash: 'a'.repeat(64) };
function initial(maxCostMicros = 10, maxCalls = 10) { return initialDurableBudgetState({ ...key, maxCostMicros, maxCalls }); }
function transition(state: DurableBudgetSnapshot, method: Exclude<DurableBudgetMethod, 'initialize' | 'inspect' | 'events'>, input: object = {}) {
  return reduceDurableBudgetState(state, method, { ...key, ...input });
}
function fork(state: DurableBudgetSnapshot, accountId = 'child', parentId = 'root', maxCostMicros = 10, maxCalls = 10) {
  return transition(state, 'fork', { accountId, parentId, maxCostMicros, maxCalls }).snapshot;
}
function reserve(state: DurableBudgetSnapshot, id = 'one', cost = 7, accountId = 'root') {
  return transition(state, 'reserveBundle', { accountId, bundleId: `bundle/${id}`, operations: [{ id, maxCostMicros: cost }] }).snapshot;
}
function ticket(state: DurableBudgetSnapshot, method: 'start' | 'markUnknown' | 'settle' | 'cancelReservation', id = 'one', accountId = 'root', actualMicros = 0) {
  return transition(state, method, { accountId, reservationId: id, ...(method === 'settle' ? { actualMicros } : {}) });
}
function account(state: DurableBudgetSnapshot, id = 'root') { return state.accounts.find(item => item.id === id)!; }

describe('durable budget pure state transitions', () => {
  it('keeps scheduler-owned trees distinct while preserving shared accounting', () => {
    const created = initialWorkflowTreeBudgetState({ ...key, maxCostMicros: 10, maxCalls: 2 });
    expect(created.owner).toBe('workflow-tree-v1');
    const forked = reduceWorkflowTreeBudgetState(created,'fork',{...key,parentId:'root',accountId:'child',maxCostMicros:4,maxCalls:1}).snapshot;
    const reserved = reduceWorkflowTreeBudgetState(forked,'reserveBundle',{...key,accountId:'child',bundleId:'bundle',operations:[{id:'ticket',maxCostMicros:4}]}).snapshot;
    expect(reserved.owner).toBe('workflow-tree-v1');
    expect(reserved.accounts.find(account => account.id === 'root')).toMatchObject({ reservedMicros: 4, heldCalls: 1 });
    expect(() => reduceDurableBudgetState(reserved,'start',{...key,accountId:'child',reservationId:'ticket'})).toThrow();
  });

  it('creates and retries immutable roots without consuming event capacity', () => {
    const state = initial(); expect(state).toMatchObject({ format: 1, mode: 'shared-ceiling-v1', owner: 'host-v1', version: 1, eventSequence: 1 });
    expect(Object.isFrozen(state.accounts[0])).toBe(true);
    expect(transition(state, 'create', { maxCostMicros: 10, maxCalls: 10 })).toEqual({ snapshot: state, changed: false });
    expect(() => transition(state, 'create', { maxCostMicros: 11, maxCalls: 10 })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('forks shared ceilings without allocating additional money', () => {
    const state = fork(fork(initial(), 'a'), 'b'); expect(account(state)).toMatchObject({ reservedMicros: 0, heldCalls: 0 });
    const held = reserve(state, 'one', 7, 'a'); expect(account(held, 'a').reservedMicros).toBe(7); expect(account(held).reservedMicros).toBe(7);
    expect(() => reserve(held, 'two', 4, 'b')).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(account(held, 'b').reservedMicros).toBe(0); expect(held.reservations).toHaveLength(1);
  });

  it('enforces intermediate ancestors and all-or-nothing bundles', () => {
    const state = fork(fork(initial(), 'parent', 'root', 5, 2), 'child', 'parent', 5, 2);
    expect(() => transition(state, 'reserveBundle', { accountId: 'child', bundleId: 'bad', operations: [{ id: 'a', maxCostMicros: 3 }, { id: 'b', maxCostMicros: 3 }] }))
      .toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(state.reservations).toHaveLength(0);
    const admitted = transition(state, 'reserveBundle', { accountId: 'child', bundleId: 'good', operations: [{ id: 'a', maxCostMicros: 0 }, { id: 'b', maxCostMicros: 0 }] }).snapshot;
    expect(() => reserve(admitted, 'c', 0, 'child')).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    expect(account(admitted)).toMatchObject({ reservedMicros: 0, heldCalls: 2, calls: 0 });
  });

  it('distinguishes a first start from historical retries and retains zero-cost calls', () => {
    const held = reserve(initial(), 'one', 0); const first = ticket(held, 'start');
    expect(first).toMatchObject({ changed: true, startStatus: 'started' }); expect(account(first.snapshot)).toMatchObject({ calls: 1, heldCalls: 0 });
    const second = ticket(first.snapshot, 'start'); expect(second).toMatchObject({ changed: false, startStatus: 'already_started' });
    const settled = ticket(second.snapshot, 'settle').snapshot; expect(account(settled)).toMatchObject({ calls: 1, spentMicros: 0 });
    expect(ticket(settled, 'start')).toMatchObject({ changed: false, startStatus: 'already_started' });
  });

  it('retains unknown funds through closure and charges known late cost once', () => {
    let state = ticket(reserve(fork(initial()), 'one', 7, 'child'), 'start', 'one', 'child').snapshot;
    state = ticket(state, 'markUnknown', 'one', 'child').snapshot;
    state = transition(state, 'closeSubtree', { accountId: 'root' }).snapshot;
    expect(account(state)).toMatchObject({ closed: true, reservedMicros: 7, calls: 1 });
    state = ticket(state, 'settle', 'one', 'child', 5).snapshot;
    expect(account(state)).toMatchObject({ spentMicros: 5, reservedMicros: 0, calls: 1 });
    expect(ticket(state, 'settle', 'one', 'child', 5)).toMatchObject({ changed: false, overrun: false });
    expect(ticket(state, 'markUnknown', 'one', 'child')).toMatchObject({ changed: false });
    expect(() => ticket(state, 'settle', 'one', 'child', 4)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => ticket(state, 'cancelReservation', 'one', 'child')).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('closes only its subtree and cancels held but never started reservations', () => {
    let state = fork(fork(initial(), 'a'), 'b'); state = reserve(reserve(state, 'held', 3, 'a'), 'started', 3, 'a');
    state = ticket(state, 'start', 'started', 'a').snapshot;
    const closed = transition(state, 'closeSubtree', { accountId: 'a' });
    expect(closed.event).toEqual({ type: 'budget.subtree_closed', data: { accountId: 'a', cancelledReservations: 1 } });
    expect(account(closed.snapshot)).toMatchObject({ reservedMicros: 3, heldCalls: 0, calls: 1 });
    expect(() => reserve(closed.snapshot, 'new', 0, 'a')).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(reserve(closed.snapshot, 'sibling', 7, 'b').reservations).toHaveLength(3);
    expect(transition(closed.snapshot, 'closeSubtree', { accountId: 'a' })).toMatchObject({ changed: false });
    expect(() => ticket(closed.snapshot, 'start', 'held', 'a')).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('commits exact overruns and preserves later truthful spending above safe integer', () => {
    let state = reserve(reserve(initial(), 'a', 0), 'b', 0); state = ticket(ticket(state, 'start', 'a').snapshot, 'start', 'b').snapshot;
    const first = ticket(state, 'settle', 'a', 'root', Number.MAX_SAFE_INTEGER); expect(first.overrun).toBe(true); expect(first.snapshot.blocked).toBe(true);
    expect(() => reserve(first.snapshot, 'new', 0)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    const second = ticket(first.snapshot, 'settle', 'b', 'root', Number.MAX_SAFE_INTEGER);
    expect(account(second.snapshot).spentMicros).toBe((BigInt(Number.MAX_SAFE_INTEGER) * 2n).toString()); expect(second.overrun).toBe(true);
  });

  it('keeps historical fork and bundle retries valid after close without restoring authority', () => {
    const original = reserve(fork(initial()), 'one', 7, 'child'); const closed = transition(original, 'closeSubtree', { accountId: 'root' }).snapshot;
    expect(transition(closed, 'fork', { parentId: 'root', accountId: 'child', maxCostMicros: 10, maxCalls: 10 })).toMatchObject({ changed: false });
    expect(transition(closed, 'reserveBundle', { accountId: 'child', bundleId: 'bundle/one', operations: [{ id: 'one', maxCostMicros: 7 }] })).toMatchObject({ changed: false });
    expect(() => fork(closed, 'new')).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(account(closed).reservedMicros).toBe(0);
  });

  it('rejects missing, mismatched, reparented and reused lifetime identities', () => {
    let state = fork(initial()); state = reserve(state);
    for (const [method, input] of [ ['fork', { parentId: 'child', accountId: 'root', maxCostMicros: 10, maxCalls: 10 }],
      ['reserveBundle', { accountId: 'child', bundleId: 'new', operations: [{ id: 'one', maxCostMicros: 7 }] }],
      ['start', { accountId: 'child', reservationId: 'one' }], ['fork', { parentId: 'root', accountId: 'child', maxCostMicros: 11, maxCalls: 10 }] ] as const) {
      expect(() => transition(state, method, input)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    }
    expect(() => ticket(state, 'start', 'missing')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => fork(state, 'new', 'missing')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => transition(state, 'closeSubtree', { accountId: 'missing' })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('enforces depth/account bounds without consuming identities on failed admission', () => {
    let state = initial(); let parent = 'root';
    for (let index = 1; index <= 16; index++) { state = fork(state, `depth${index}`, parent); parent = `depth${index}`; }
    expect(() => fork(state, 'too-deep', parent)).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    while (state.accounts.length < 128) state = fork(state, `account${state.accounts.length}`);
    expect(() => fork(state, 'too-many')).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' })); expect(state.accounts).toHaveLength(128);
  });

  it('preserves the full terminal suffix at maximum admitted ticket and bundle capacity', () => {
    let state = initial(0, 512);
    for (let index = 0; index < 128; index++) {
      state = transition(state, 'reserveBundle', { accountId: 'root', bundleId: `bundle${index.toString().padStart(3, '0')}`,
        operations: Array.from({ length: 4 }, (_, ordinal) => ({ id: `ticket${(index * 4 + ordinal).toString().padStart(3, '0')}`, maxCostMicros: 0 })) }).snapshot;
    }
    expect(() => reserve(state, 'overflow', 0)).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
    for (const operation of state.reservations) {
      state = ticket(state, 'start', operation.id).snapshot; state = ticket(state, 'markUnknown', operation.id).snapshot; state = ticket(state, 'settle', operation.id).snapshot;
    }
    state = transition(state, 'closeSubtree', { accountId: 'root' }).snapshot;
    expect(state.eventSequence).toBe(1 + 128 + 512 * 3 + 1); expect(account(state)).toMatchObject({ reservedMicros: 0, heldCalls: 0, calls: 512 });
  }, 30_000);
});
