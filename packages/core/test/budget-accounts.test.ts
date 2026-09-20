import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { assertBudget, Budget, type Reservation } from '../src/index.js';

function caught(action: () => unknown): unknown {
  try { action(); return undefined; } catch (error) { return error; }
}

describe('shared hierarchical budget accounts', () => {
  it('creates ceilings without prepaid calls/cost and exposes immutable lineage only', () => {
    const root = new Budget(10, 10);
    const left = root.fork({ id: 'left', maxCostMicros: 10, maxCalls: 10 });
    const right = root.fork({ id: 'right', maxCostMicros: 10, maxCalls: 10 });
    const leaf = left.fork({ id: 'leaf', maxCostMicros: 4, maxCalls: 3 });
    for (const account of [root, left, right, leaf]) expect(account.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
    expect(root.identity).toEqual({ id: 'root', lineage: ['root'], depth: 0 });
    expect(leaf.identity).toEqual({ id: 'leaf', parentId: 'left', lineage: ['root', 'left', 'leaf'], depth: 2 });
    expect(Object.isFrozen(leaf.identity)).toBe(true); expect(Object.isFrozen(leaf.identity.lineage)).toBe(true);
    expect(leaf).not.toHaveProperty('parent'); expect(leaf).not.toHaveProperty('root');
    const reservation = leaf.reserve(4);
    for (const account of [root, left, leaf]) expect(account.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 4, calls: 1 });
    expect(right.snapshot().calls).toBe(0);
    reservation.settle(3);
    for (const account of [root, left, leaf]) expect(account.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
  });

  it('admits sibling reservations synchronously against one root balance', async () => {
    const root = new Budget(10, 10);
    const children = ['a', 'b', 'c'].map(id => root.fork({ id, maxCostMicros: 10, maxCalls: 10 }));
    const results = await Promise.allSettled(children.map(async child => child.reserve(5)));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 10, calls: 2 });
    expect(children[2]!.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('enforces intermediate ceilings atomically without consuming leaf/root capacity on rejection', () => {
    const root = new Budget(100, 100);
    const parent = root.fork({ id: 'parent', maxCostMicros: 6, maxCalls: 10 });
    const leaf = parent.fork({ id: 'leaf', maxCostMicros: 6, maxCalls: 10 });
    parent.reserve(4);
    const before = [root, parent, leaf].map(account => account.snapshot());
    expect(caught(() => leaf.reserve(3))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect([root, parent, leaf].map(account => account.snapshot())).toEqual(before);
    leaf.reserve(2).settle(1);
    expect(root.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 4, calls: 2 });
  });

  it('enforces root/child/intermediate call caps even for zero-cost executions', () => {
    const root = new Budget(0, 3);
    const child = root.fork({ id: 'child', maxCostMicros: 0, maxCalls: 1 });
    const grandchild = child.fork({ id: 'grandchild', maxCostMicros: 0, maxCalls: 1 });
    const sibling = root.fork({ id: 'sibling', maxCostMicros: 0, maxCalls: 3 });
    grandchild.reserve(0).settle(0);
    expect(caught(() => child.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(caught(() => grandchild.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    sibling.reserve(0).settle(0); sibling.reserve(0).settle(0);
    expect(caught(() => sibling.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(root.snapshot().calls).toBe(3); expect(sibling.snapshot().calls).toBe(2);
  });

  it('retains unknown/invalid usage on every ancestor and permits one later valid settlement', () => {
    const root = new Budget(10, 10); const child = root.fork({ id: 'child', maxCostMicros: 8, maxCalls: 5 });
    const reservation = child.reserve(8);
    for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(caught(() => reservation.settle(invalid))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      for (const account of [root, child]) expect(account.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 8, calls: 1 });
    }
    reservation.settle(5);
    expect(caught(() => reservation.settle(0))).toMatchObject({ code: 'CONFLICT' });
    for (const account of [root, child]) expect(account.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 1 });
  });

  it('records full overruns across ancestors, blocks all siblings, and settles existing usage', () => {
    const root = new Budget(100, 10);
    const one = root.fork({ id: 'one', maxCostMicros: 20, maxCalls: 5 });
    const two = root.fork({ id: 'two', maxCostMicros: 20, maxCalls: 5 });
    const first = one.reserve(1); const second = two.reserve(5);
    expect(caught(() => first.settle(2))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(root.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 5, calls: 2 });
    expect(one.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
    for (const account of [root, one, two]) {
      expect(caught(() => account.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(caught(() => account.fork({ id: 'new-child', maxCostMicros: 0, maxCalls: 1 }))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    second.settle(3);
    expect(root.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 2 });
    expect(two.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
    expect(caught(() => first.settle(0))).toMatchObject({ code: 'CONFLICT' });
  });

  it('preserves exact large known actual totals across root and nested accounts', () => {
    const root = new Budget(0, 3); const child = root.fork({ id: 'child', maxCostMicros: 0, maxCalls: 3 });
    const leaf = child.fork({ id: 'leaf', maxCostMicros: 0, maxCalls: 2 });
    const reservations = [leaf.reserve(0), leaf.reserve(0), root.reserve(0)];
    for (const reservation of reservations) expect(caught(() => reservation.settle(Number.MAX_SAFE_INTEGER))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(root.snapshot()).toEqual({ spentMicros: '27021597764222973', reservedMicros: 0, calls: 3 });
    for (const account of [child, leaf]) expect(account.snapshot()).toEqual({ spentMicros: '18014398509481982', reservedMicros: 0, calls: 2 });
  });

  it('closes only the chosen subtree without releasing uncertain reservations', () => {
    const root = new Budget(20, 10); const child = root.fork({ id: 'child', maxCostMicros: 10, maxCalls: 5 });
    const leaf = child.fork({ id: 'leaf', maxCostMicros: 10, maxCalls: 5 });
    const sibling = root.fork({ id: 'sibling', maxCostMicros: 10, maxCalls: 5 });
    const unknown = leaf.reserve(8); child.close(); child.close();
    for (const account of [child, leaf]) {
      expect(caught(() => account.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(caught(() => account.fork({ id: 'closed-child', maxCostMicros: 0, maxCalls: 1 }))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    sibling.reserve(4).settle(2);
    expect(root.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 8, calls: 2 });
    unknown.settle(7);
    expect(root.snapshot()).toEqual({ spentMicros: 9, reservedMicros: 0, calls: 2 });
    root.close();
    expect(caught(() => sibling.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('does not let child closure or usage modify separate root ledgers', () => {
    const first = new Budget(1, 1); const second = new Budget(1, 1);
    first.fork({ id: 'same-id', maxCostMicros: 1, maxCalls: 1 }).close();
    second.fork({ id: 'same-id', maxCostMicros: 1, maxCalls: 1 }).reserve(1).settle(1);
    expect(first.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
    expect(second.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('enforces unique lifetime IDs and parent ceiling attenuation', () => {
    const root = new Budget(10, 10); const child = root.fork({ id: 'child', maxCostMicros: 5, maxCalls: 5 });
    child.close();
    for (const id of ['root', 'child']) expect(caught(() => root.fork({ id, maxCostMicros: 0, maxCalls: 1 }))).toMatchObject({ code: 'CONFLICT' });
    const other = root.fork({ id: 'other', maxCostMicros: 5, maxCalls: 5 });
    expect(caught(() => other.fork({ id: 'child', maxCostMicros: 0, maxCalls: 1 }))).toMatchObject({ code: 'CONFLICT' });
    for (const limits of [{ maxCostMicros: 6, maxCalls: 5 }, { maxCostMicros: 5, maxCalls: 6 }]) {
      expect(caught(() => other.fork({ id: 'too-large', ...limits }))).toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(root.snapshot().calls).toBe(0);
  });

  it('bounds account count at 1024 including root and ancestry depth at 32', () => {
    const root = new Budget(0, 1);
    for (let index = 1; index < 1_024; index++) root.fork({ id: `account-${index}`, maxCostMicros: 0, maxCalls: 1 }).close();
    expect(caught(() => root.fork({ id: 'too-many', maxCostMicros: 0, maxCalls: 1 }))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    let deepest = new Budget(0, 1);
    for (let depth = 1; depth <= 32; depth++) deepest = deepest.fork({ id: `depth-${depth}`, maxCostMicros: 0, maxCalls: 1 });
    expect(deepest.identity.depth).toBe(32); expect(deepest.identity.lineage).toHaveLength(33);
    expect(caught(() => deepest.fork({ id: 'too-deep', maxCostMicros: 0, maxCalls: 1 }))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    deepest.reserve(0).settle(0);
  });

  it('freezes public authority handles without freezing their private accounting state', () => {
    const root = new Budget(2, 2); const child = root.fork({ id: 'child', maxCostMicros: 1, maxCalls: 1 });
    for (const [key, value] of [['maxCostMicros', 100], ['maxCalls', 100], ['reserved', -100], ['spent', -100n], ['identity', {}], ['reserve', () => ({ settle() {} })]] as const) {
      expect(Reflect.set(child, key, value)).toBe(false);
    }
    expect(Reflect.set(Budget.prototype, 'reserve', () => undefined)).toBe(false);
    expect(Reflect.setPrototypeOf(child, {})).toBe(false);
    const reservation = child.reserve(1);
    expect(Object.isFrozen(child)).toBe(true); expect(Object.isFrozen(reservation)).toBe(true);
    expect(Reflect.set(reservation, 'settle', () => undefined)).toBe(false);
    const snapshot = root.snapshot(); expect(Reflect.set(snapshot, 'calls', 0)).toBe(false);
    reservation.settle(1);
    expect(child.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
    expect(snapshot).toEqual({ spentMicros: 0, reservedMicros: 1, calls: 1 });
  });

  it('rejects forged/proxied instances and subclass overrides', () => {
    const real = new Budget(1, 1);
    assertBudget(real);
    const fake = Object.create(Budget.prototype) as Budget;
    expect(fake).toBeInstanceOf(Budget);
    for (const value of [fake, new Proxy(real, {}), {}, null, undefined]) expect(caught(() => assertBudget(value))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(caught(() => fake.reserve(0))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(caught(() => fake.close())).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(caught(() => fake.snapshot())).toMatchObject({ code: 'INVALID_CONFIG' });
    class Subclass extends Budget {}
    expect(caught(() => new Subclass(1, 1))).toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('rejects malformed fork metadata and never invokes accessor fields or leaks proxy errors', () => {
    const root = new Budget(10, 10); let getterCalls = 0;
    const accessor = { get id() { getterCalls++; return 'SECRET'; }, maxCostMicros: 1, maxCalls: 1 };
    const proxy = new Proxy({ id: 'child', maxCostMicros: 1, maxCalls: 1 }, { getOwnPropertyDescriptor() { throw new Error('SECRET'); } });
    for (const value of [accessor, proxy, { id: 'spaces invalid', maxCostMicros: 1, maxCalls: 1 },
      { id: 'child', maxCostMicros: Infinity, maxCalls: 1 }, { id: 'child', maxCostMicros: 1, maxCalls: 0 },
      { id: 'child', maxCostMicros: 1, maxCalls: 1, unexpected: true }]) {
      const error = caught(() => root.fork(value));
      expect(error).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(error)).not.toContain('SECRET');
    }
    expect(getterCalls).toBe(0); expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });
});

describe('hierarchical ledger reference model', () => {
  it('matches randomized forks, admission, settlement, closure and overrun accounting', () => {
    const operation = fc.record({ kind: fc.constantFrom('fork', 'reserve', 'settle', 'close'), selector: fc.nat(1_000), amount: fc.integer({ min: -1, max: 6 }) });
    fc.assert(fc.property(fc.array(operation, { minLength: 20, maxLength: 100 }), operations => {
      interface Reference { readonly parent: number | undefined; readonly cost: number; readonly cap: number; spent: number; reserved: number; calls: number; closed: boolean }
      const root = new Budget(20, 20); const actual = [root];
      const expected: Reference[] = [{ parent: undefined, cost: 20, cap: 20, spent: 0, reserved: 0, calls: 0, closed: false }];
      const reservations: { actual: Reservation; account: number; bound: number; settled: boolean }[] = [];
      let blocked = false;
      const path = (index: number): Reference[] => {
        const result: Reference[] = [];
        for (let current: number | undefined = index; current !== undefined; current = expected[current]!.parent) result.push(expected[current]!);
        return result;
      };
      for (const operation of operations) {
        const index = operation.selector % actual.length; const target = actual[index]!; const state = expected[index]!; const ancestors = path(index);
        if (operation.kind === 'close') { target.close(); state.closed = true; }
        else if (operation.kind === 'fork') {
          const cost = Math.min(state.cost, Math.max(0, operation.amount)); const cap = Math.min(state.cap, Math.max(1, operation.amount));
          const config = { id: `account-${actual.length}`, maxCostMicros: cost, maxCalls: cap };
          if (blocked || ancestors.some(account => account.closed)) expect(caught(() => target.fork(config))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
          else {
            actual.push(target.fork(config)); expected.push({ parent: index, cost, cap, spent: 0, reserved: 0, calls: 0, closed: false });
          }
        } else if (operation.kind === 'reserve') {
          const bound = Math.max(0, operation.amount);
          const permitted = !blocked && ancestors.every(account => !account.closed && account.calls < account.cap && account.spent + account.reserved + bound <= account.cost);
          if (!permitted) expect(caught(() => target.reserve(bound))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
          else {
            reservations.push({ actual: target.reserve(bound), account: index, bound, settled: false });
            for (const account of ancestors) { account.calls++; account.reserved += bound; }
          }
        } else if (reservations.length > 0) {
          const reservation = reservations[operation.selector % reservations.length]!;
          if (reservation.settled) expect(caught(() => reservation.actual.settle(operation.amount))).toMatchObject({ code: 'CONFLICT' });
          else if (operation.amount < 0) expect(caught(() => reservation.actual.settle(operation.amount))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
          else {
            const overrun = operation.amount > reservation.bound;
            if (overrun) expect(caught(() => reservation.actual.settle(operation.amount))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
            else reservation.actual.settle(operation.amount);
            reservation.settled = true; blocked ||= overrun;
            for (const account of path(reservation.account)) { account.reserved -= reservation.bound; account.spent += operation.amount; }
          }
        }
        for (const [position, account] of actual.entries()) {
          const model = expected[position]!;
          expect(account.snapshot()).toEqual({ spentMicros: model.spent, reservedMicros: model.reserved, calls: model.calls });
        }
      }
    }), { numRuns: 200 });
  });
});
