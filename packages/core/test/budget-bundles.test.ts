import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Budget, type BudgetBundle, type BudgetTicket, type Reservation } from '../src/index.js';

/** Keep assertions on public error codes, never on implementation-specific raw error text. */
function caught(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error('Expected the operation to fail.');
}

function operation(id: string, maxCostMicros = 0): { id: string; maxCostMicros: number } {
  return { id, maxCostMicros };
}

function view(account: Budget): unknown {
  return { usage: account.snapshot(), capacity: account.capacitySnapshot() };
}

function ticket(bundle: BudgetBundle, index = 0): BudgetTicket { return bundle.tickets[index]!; }

describe('atomic budget reservation bundles', () => {
  it('holds money and future calls on every ancestor without changing the old snapshot shape', () => {
    const root = new Budget(100, 10);
    const middle = root.fork({ id: 'middle', maxCostMicros: 20, maxCalls: 5 });
    const leaf = middle.fork({ id: 'leaf', maxCostMicros: 15, maxCalls: 4 });
    const sibling = root.fork({ id: 'sibling', maxCostMicros: 100, maxCalls: 10 });
    const bundle = leaf.reserveBundle([operation('paid', 6), operation('free')]);
    const oldUsage = root.snapshot(); const oldCapacity = root.capacitySnapshot();
    for (const account of [root, middle, leaf]) {
      expect(account.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 6, calls: 0 });
      expect(account.capacitySnapshot()).toEqual({ heldCalls: 2 });
    }
    expect(view(sibling)).toEqual({ usage: { spentMicros: 0, reservedMicros: 0, calls: 0 }, capacity: { heldCalls: 0 } });
    const reservation = ticket(bundle).start();
    for (const account of [root, middle, leaf]) {
      expect(account.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 6, calls: 1 });
      expect(account.capacitySnapshot()).toEqual({ heldCalls: 1 });
    }
    reservation.settle(4); ticket(bundle, 1).cancel();
    for (const account of [root, middle, leaf]) {
      expect(account.snapshot()).toEqual({ spentMicros: 4, reservedMicros: 0, calls: 1 });
      expect(account.capacitySnapshot()).toEqual({ heldCalls: 0 });
    }
    expect(Object.keys(root.snapshot()).sort()).toEqual(['calls', 'reservedMicros', 'spentMicros']);
    expect(Object.isFrozen(oldUsage)).toBe(true); expect(Object.isFrozen(oldCapacity)).toBe(true);
    expect(oldUsage).toEqual({ spentMicros: 0, reservedMicros: 6, calls: 0 });
    expect(oldCapacity).toEqual({ heldCalls: 2 });
  });

  it('prevents ordinary and later-forked paid calls from spending a sibling bundle hold', () => {
    const root = new Budget(10, 10);
    const left = root.fork({ id: 'left', maxCostMicros: 10, maxCalls: 10 });
    const bundle = left.reserveBundle([operation('first', 6), operation('second', 4)]);
    const right = root.fork({ id: 'right', maxCostMicros: 10, maxCalls: 10 });
    for (const account of [root, right]) {
      expect(caught(() => account.reserve(1))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(caught(() => account.reserveBundle([operation('competing', 1)]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 10, calls: 0 });
    ticket(bundle, 1).cancel();
    right.reserveBundle([operation('competing', 4)]).close();
    expect(root.capacitySnapshot()).toEqual({ heldCalls: 1 });
  });

  it('protects free-call capacity against ordinary reserves, sibling bundles and later forks', () => {
    const root = new Budget(0, 2);
    const bundle = root.reserveBundle([operation('one'), operation('two')]);
    const child = root.fork({ id: 'later', maxCostMicros: 0, maxCalls: 2 });
    for (const account of [root, child]) {
      expect(caught(() => account.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(caught(() => account.reserveBundle([operation('extra')]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    ticket(bundle).start().settle(0);
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
    expect(root.capacitySnapshot()).toEqual({ heldCalls: 1 });
    expect(caught(() => child.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    ticket(bundle, 1).cancel(); child.reserve(0).settle(0);
    expect(root.snapshot().calls).toBe(2);
    expect(caught(() => root.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('enforces intermediate money ceilings atomically and does not burn rejected ticket identities', () => {
    const root = new Budget(100, 100);
    const middle = root.fork({ id: 'middle', maxCostMicros: 8, maxCalls: 10 });
    const leaf = middle.fork({ id: 'leaf', maxCostMicros: 8, maxCalls: 10 });
    middle.reserve(4);
    const before = [root, middle, leaf].map(view);
    expect(caught(() => leaf.reserveBundle([operation('reusable-a', 3), operation('reusable-b', 2)]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect([root, middle, leaf].map(view)).toEqual(before);
    const admitted = leaf.reserveBundle([operation('reusable-a', 3), operation('reusable-b', 1)]);
    expect(admitted.tickets.map(item => item.id)).toEqual(['reusable-a', 'reusable-b']);
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 8, calls: 1 });
    expect(root.capacitySnapshot()).toEqual({ heldCalls: 2 });
  });

  it('enforces intermediate held-call ceilings while leaving independent branches usable', () => {
    const root = new Budget(100, 6);
    const middle = root.fork({ id: 'middle', maxCostMicros: 100, maxCalls: 2 });
    const leaf = middle.fork({ id: 'leaf', maxCostMicros: 100, maxCalls: 2 });
    const independent = root.fork({ id: 'independent', maxCostMicros: 100, maxCalls: 6 });
    leaf.reserveBundle([operation('a'), operation('b')]);
    const before = [root, middle, leaf].map(view);
    for (const account of [middle, leaf]) {
      expect(caught(() => account.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(caught(() => account.reserveBundle([operation('denied')]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    expect([root, middle, leaf].map(view)).toEqual(before);
    independent.reserve(0).settle(0);
    expect(root.snapshot().calls).toBe(1); expect(root.capacitySnapshot().heldCalls).toBe(2);
  });

  it('checks the whole bundle before any call or money commit at the root', () => {
    for (const root of [new Budget(3, 10), new Budget(10, 1)]) {
      const before = view(root);
      expect(caught(() => root.reserveBundle([operation('a', 2), operation('b', 2)]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(view(root)).toEqual(before);
      root.reserveBundle([operation('a', 1)]).close();
    }
  });

  it('rejects an aggregate safe-integer overflow without reserving or consuming identities', () => {
    const root = new Budget(Number.MAX_SAFE_INTEGER, 3);
    const before = view(root);
    expect(caught(() => root.reserveBundle([operation('huge', Number.MAX_SAFE_INTEGER), operation('small', 1)]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(view(root)).toEqual(before);
    root.reserveBundle([operation('huge', Number.MAX_SAFE_INTEGER), operation('small', 0)]).close();
  });

  it('admits exactly one competing asynchronous branch as a complete bundle', async () => {
    const root = new Budget(6, 2);
    const children = [0, 1, 2].map(id => root.fork({ id: `child-${id}`, maxCostMicros: 6, maxCalls: 2 }));
    const results = await Promise.allSettled(children.map(async (child, id) => child.reserveBundle([
      operation(`paid-${id}`, 6), operation(`free-${id}`),
    ])));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 6, calls: 0 });
    expect(root.capacitySnapshot()).toEqual({ heldCalls: 2 });
    expect(children.map(child => child.capacitySnapshot().heldCalls)).toEqual([2, 0, 0]);
  });
});

describe('genuine immutable bundle authority', () => {
  it('snapshots mutable operation lists and freezes every public handle and metadata view', () => {
    const root = new Budget(10, 5); const config = [operation('original', 4)];
    const bundle = root.reserveBundle(config); const original = ticket(bundle);
    config[0]!.id = 'replacement'; config[0]!.maxCostMicros = 0; config.push(operation('injected'));
    expect(bundle.tickets).toHaveLength(1);
    expect(original).toMatchObject({ id: 'original', maxCostMicros: 4 });
    for (const value of [bundle, bundle.tickets, original, root.capacitySnapshot()]) expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(original, 'maxCostMicros', 0)).toBe(false);
    expect(Reflect.set(bundle.tickets, '0', {})).toBe(false);
    expect(Reflect.set(Budget.prototype, 'reserveBundle', () => undefined)).toBe(false);
    const reservation = original.start(); expect(Object.isFrozen(reservation)).toBe(true);
    reservation.settle(3);
    expect(root.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
  });

  it('rejects forged and proxy account receivers without touching the genuine account', () => {
    const root = new Budget(10, 10); const before = view(root);
    for (const receiver of [{ ...root }, Object.create(Budget.prototype), new Proxy(root, {}), null, undefined]) {
      expect(caught(() => Reflect.apply(Budget.prototype.reserveBundle, receiver, [[operation('copy')]]))).toMatchObject({ code: 'INVALID_CONFIG' });
      expect(caught(() => Reflect.apply(Budget.prototype.capacitySnapshot, receiver, []))).toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(view(root)).toEqual(before);
  });

  it('rejects copied, inherited, proxied and unbound ticket receivers for both transitions', () => {
    const root = new Budget(10, 10); const bundle = root.reserveBundle([operation('real', 4)]);
    const real = ticket(bundle); const before = view(root);
    for (const receiver of [{ ...real }, Object.create(real), new Proxy(real, {}), { id: real.id }, null, undefined]) {
      expect(caught(() => Reflect.apply(real.start, receiver, []))).toMatchObject({ code: 'INVALID_CONFIG' });
      expect(caught(() => Reflect.apply(real.cancel, receiver, []))).toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(view(root)).toEqual(before);
    real.start().settle(4);
  });

  it('rejects copied, inherited, proxied and unbound bundle close receivers', () => {
    const root = new Budget(10, 10); const bundle = root.reserveBundle([operation('real', 4)]);
    const before = view(root);
    for (const receiver of [{ ...bundle }, Object.create(bundle), new Proxy(bundle, {}), {}, null, undefined]) {
      expect(caught(() => Reflect.apply(bundle.close, receiver, []))).toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(view(root)).toEqual(before); bundle.close();
    expect(root.capacitySnapshot().heldCalls).toBe(0);
  });

  it('borrowing a method onto another genuine ticket never transitions the captured origin', () => {
    const root = new Budget(10, 5);
    const bundle = root.reserveBundle([operation('origin', 3), operation('receiver', 4)]);
    const origin = ticket(bundle); const receiver = ticket(bundle, 1);
    const receiverReservation = Reflect.apply(origin.start, receiver, []) as Reservation;
    expect(caught(() => receiver.start())).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => receiver.cancel())).toMatchObject({ code: 'CONFLICT' });
    origin.cancel(); receiverReservation.settle(2);
    expect(root.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
  });

  it('starts a genuine ticket once and never refunds a started or settled call', () => {
    const root = new Budget(4, 1); const item = ticket(root.reserveBundle([operation('once', 4)]));
    const reservation = item.start();
    expect(caught(() => item.start())).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => item.cancel())).toMatchObject({ code: 'CONFLICT' });
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 4, calls: 1 });
    reservation.settle(0);
    expect(caught(() => item.cancel())).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => item.start())).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => reservation.settle(0))).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => root.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
  });

  it('keeps ticket identities unique across the whole ledger after cancellation and settlement', () => {
    const root = new Budget(10, 10); const child = root.fork({ id: 'child', maxCostMicros: 10, maxCalls: 10 });
    const bundle = child.reserveBundle([operation('cancelled'), operation('settled')]);
    ticket(bundle).cancel(); ticket(bundle, 1).start().settle(0);
    for (const account of [root, child]) for (const id of ['cancelled', 'settled']) {
      expect(caught(() => account.reserveBundle([operation(id)]))).toMatchObject({ code: 'CONFLICT' });
    }
    new Budget(0, 1).reserveBundle([operation('cancelled')]).close();
  });

  it('does not burn any fresh identity when another operation in the bundle conflicts', () => {
    const root = new Budget(10, 10); root.reserveBundle([operation('existing')]).close();
    const before = view(root);
    expect(caught(() => root.reserveBundle([operation('fresh'), operation('existing')]))).toMatchObject({ code: 'CONFLICT' });
    expect(view(root)).toEqual(before);
    root.reserveBundle([operation('fresh')]).close();
    expect(caught(() => root.reserveBundle([operation('duplicate'), operation('duplicate')]))).toMatchObject({ code: 'CONFLICT' });
    root.reserveBundle([operation('duplicate')]).close();
  });

  it('validates fields without invoking operation accessors and leaves rejected IDs reusable', () => {
    const root = new Budget(10, 10); let reads = 0;
    const accessor = { id: 'accessor', get maxCostMicros(): number { reads++; return 0; } };
    const before = view(root);
    expect(caught(() => root.reserveBundle([accessor]))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(reads).toBe(0); expect(view(root)).toEqual(before);
    root.reserveBundle([operation('accessor')]).close();
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cost %s without partial holds or identity burn', invalid => {
    const root = new Budget(10, 10); const before = view(root);
    expect(caught(() => root.reserveBundle([operation('first', 1), operation('invalid', invalid)]))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(view(root)).toEqual(before);
    root.reserveBundle([operation('first'), operation('invalid')]).close();
  });

  it.each(['', 'a'.repeat(257), 'non-ascii-\u00e9', 'line\nbreak', 'nul\0byte'])('rejects malformed or oversized ticket identity %j', id => {
    const root = new Budget(10, 10); const before = view(root);
    expect(caught(() => root.reserveBundle([operation('fresh'), operation(id)]))).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(view(root)).toEqual(before); root.reserveBundle([operation('fresh')]).close();
  });

  it('accepts bounded ASCII identifiers including the 256-character boundary', () => {
    const root = new Budget(0, 3);
    const bundle = root.reserveBundle([operation('a'), operation('A9._:/-'), operation('b'.repeat(256))]);
    expect(bundle.tickets.map(item => item.id)).toEqual(['a', 'A9._:/-', 'b'.repeat(256)]);
    bundle.close();
  });
});

describe('bundle cancellation and exact late accounting', () => {
  it('cancels a held ticket idempotently without consuming a call and forbids later start', () => {
    const root = new Budget(4, 1); const item = ticket(root.reserveBundle([operation('held', 4)]));
    item.cancel(); item.cancel();
    expect(view(root)).toEqual({ usage: { spentMicros: 0, reservedMicros: 0, calls: 0 }, capacity: { heldCalls: 0 } });
    expect(caught(() => item.start())).toMatchObject({ code: 'CONFLICT' });
    root.reserve(4).settle(4);
  });

  it('closes only held tickets after account closure while preserving unknown and settled calls', () => {
    const root = new Budget(20, 5);
    const child = root.fork({ id: 'child', maxCostMicros: 20, maxCalls: 5 });
    const bundle = child.reserveBundle([operation('unknown', 5), operation('known', 4), operation('held', 3)]);
    const unknown = ticket(bundle).start(); ticket(bundle, 1).start().settle(2);
    root.close();
    expect(root.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 8, calls: 2 });
    expect(root.capacitySnapshot().heldCalls).toBe(1);
    expect(caught(() => ticket(bundle, 2).start())).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    bundle.close(); bundle.close(); ticket(bundle, 2).cancel();
    expect(caught(() => ticket(bundle, 2).start())).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => ticket(bundle).cancel())).toMatchObject({ code: 'CONFLICT' });
    for (const account of [root, child]) {
      expect(account.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 5, calls: 2 });
      expect(account.capacitySnapshot()).toEqual({ heldCalls: 0 });
    }
    unknown.settle(3);
    for (const account of [root, child]) expect(account.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 2 });
  });

  it('cancels held descendants after intermediate closure without closing another branch', () => {
    const root = new Budget(10, 5);
    const middle = root.fork({ id: 'middle', maxCostMicros: 10, maxCalls: 5 });
    const leaf = middle.fork({ id: 'leaf', maxCostMicros: 10, maxCalls: 5 });
    const sibling = root.fork({ id: 'sibling', maxCostMicros: 10, maxCalls: 5 });
    const held = ticket(leaf.reserveBundle([operation('held', 10)]));
    middle.close();
    expect(caught(() => held.start())).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    held.cancel(); sibling.reserve(10).settle(2);
    expect(root.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
  });

  it('retains invalid known-usage reports and allows one later valid settlement after closure', () => {
    const root = new Budget(10, 3); const bundle = root.reserveBundle([operation('unknown', 7), operation('held', 2)]);
    const reservation = ticket(bundle).start(); root.close(); bundle.close();
    for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(caught(() => reservation.settle(invalid))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 7, calls: 1 });
    }
    reservation.settle(6);
    expect(caught(() => reservation.settle(5))).toMatchObject({ code: 'CONFLICT' });
    expect(root.snapshot()).toEqual({ spentMicros: 6, reservedMicros: 0, calls: 1 });
  });

  it('records an overrun fully, blocks new and held admissions, and settles other late calls exactly', () => {
    const root = new Budget(20, 10);
    const left = root.fork({ id: 'left', maxCostMicros: 20, maxCalls: 10 });
    const right = root.fork({ id: 'right', maxCostMicros: 20, maxCalls: 10 });
    const a = left.reserveBundle([operation('overrun', 1), operation('never', 3)]);
    const b = right.reserveBundle([operation('late', 5)]);
    const first = ticket(a).start(); const late = ticket(b).start();
    expect(caught(() => first.settle(2))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(root.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 8, calls: 2 });
    for (const account of [root, left, right]) {
      expect(caught(() => account.reserve(0))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
      expect(caught(() => account.reserveBundle([operation('blocked')]))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    }
    expect(caught(() => ticket(a, 1).start())).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(caught(() => root.fork({ id: 'too-late', maxCostMicros: 20, maxCalls: 10 }))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    root.close(); a.close(); b.close(); late.settle(4);
    expect(caught(() => first.settle(2))).toMatchObject({ code: 'CONFLICT' });
    expect(caught(() => late.settle(4))).toMatchObject({ code: 'CONFLICT' });
    expect(root.snapshot()).toEqual({ spentMicros: 6, reservedMicros: 0, calls: 2 });
    expect(left.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
    expect(right.snapshot()).toEqual({ spentMicros: 4, reservedMicros: 0, calls: 1 });
  });

  it('preserves exact large late totals without lossy number coercion', () => {
    const root = new Budget(0, 3); const child = root.fork({ id: 'child', maxCostMicros: 0, maxCalls: 3 });
    const bundle = child.reserveBundle([operation('one'), operation('two'), operation('three')]);
    const reservations = bundle.tickets.map(item => item.start()); root.close(); bundle.close();
    for (const reservation of reservations) expect(caught(() => reservation.settle(Number.MAX_SAFE_INTEGER))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    for (const account of [root, child]) {
      expect(account.snapshot()).toEqual({ spentMicros: '27021597764222973', reservedMicros: 0, calls: 3 });
      expect(account.capacitySnapshot()).toEqual({ heldCalls: 0 });
    }
  });
});

describe('finite bundle resource bounds', () => {
  it('requires a nonempty bounded bundle and accepts exactly 128 operations', () => {
    const root = new Budget(0, 256);
    expect(caught(() => root.reserveBundle([]))).toMatchObject({ code: expect.stringMatching(/^(INVALID_CONFIG|LIMIT_EXCEEDED)$/) });
    const excessive = Array.from({ length: 129 }, (_, id) => operation(`limit-${id}`));
    expect(caught(() => root.reserveBundle(excessive))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(root.capacitySnapshot().heldCalls).toBe(0);
    const accepted = root.reserveBundle(excessive.slice(0, 128));
    expect(accepted.tickets).toHaveLength(128); expect(root.capacitySnapshot().heldCalls).toBe(128);
    accepted.close();
  });

  it('counts both held and started unknown tickets toward the shared 1024 outstanding limit', () => {
    const root = new Budget(0, 2_048);
    const left = root.fork({ id: 'left', maxCostMicros: 0, maxCalls: 2_048 });
    const right = root.fork({ id: 'right', maxCostMicros: 0, maxCalls: 2_048 });
    const bundles = Array.from({ length: 8 }, (_, group) => (group % 2 === 0 ? left : right).reserveBundle(
      Array.from({ length: 128 }, (_, item) => operation(`active-${group}-${item}`)),
    ));
    const unknown = ticket(bundles[0]!).start();
    expect(root.capacitySnapshot().heldCalls).toBe(1_023);
    const before = view(root);
    expect(caught(() => right.reserveBundle([operation('next')]))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(view(root)).toEqual(before);
    expect(caught(() => unknown.settle(-1))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(caught(() => right.reserveBundle([operation('next')]))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    unknown.settle(0);
    const next = right.reserveBundle([operation('next')]);
    expect(root.capacitySnapshot().heldCalls).toBe(1_024);
    expect(caught(() => left.reserveBundle([operation('after-cancel')]))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    ticket(bundles[1]!).cancel();
    left.reserveBundle([operation('after-cancel')]).close(); next.close();
    for (const bundle of bundles) bundle.close();
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
    expect(root.capacitySnapshot().heldCalls).toBe(0);
  });

  it('does not partially consume the final outstanding capacity or burn failed identities', () => {
    const root = new Budget(0, 2_048);
    const bundles: BudgetBundle[] = [];
    for (let group = 0; group < 8; group++) bundles.push(root.reserveBundle(
      Array.from({ length: group === 7 ? 127 : 128 }, (_, item) => operation(`capacity-${group}-${item}`)),
    ));
    expect(root.capacitySnapshot().heldCalls).toBe(1_023);
    expect(caught(() => root.reserveBundle([operation('fresh-one'), operation('fresh-two')]))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(root.capacitySnapshot().heldCalls).toBe(1_023);
    root.reserveBundle([operation('fresh-one')]).close();
    root.reserveBundle([operation('fresh-two')]).close();
    for (const bundle of bundles) bundle.close();
  });

  it('retains all 16384 lifetime identities across accounts and rejects atomic overflow without identity burn', () => {
    const root = new Budget(0, 20_000);
    const child = root.fork({ id: 'child', maxCostMicros: 0, maxCalls: 20_000 });
    for (let group = 0; group < 128; group++) {
      const count = group === 127 ? 127 : 128;
      (group % 2 === 0 ? root : child).reserveBundle(Array.from({ length: count }, (_, item) => operation(`history-${group}-${item}`))).close();
    }
    expect(root.capacitySnapshot().heldCalls).toBe(0);
    expect(caught(() => child.reserveBundle([operation('last-allowed'), operation('one-too-many')]))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    root.reserveBundle([operation('last-allowed')]).close();
    expect(caught(() => child.reserveBundle([operation('one-too-many')]))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(caught(() => root.reserveBundle([operation('history-0-0')]))).toMatchObject({ code: expect.stringMatching(/^(CONFLICT|LIMIT_EXCEEDED)$/) });
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
    new Budget(0, 1).reserveBundle([operation('one-too-many')]).close();
  });
});

describe('bundle conservation under generated operation sequences', () => {
  it('matches an independent ancestor ledger across reserve/start/cancel/settle/close interleavings', () => {
    const generated = fc.record({
      kind: fc.constantFrom('bundle', 'bundle', 'start', 'start', 'cancel', 'settle', 'settle', 'reserve', 'bundle-close', 'account-close'),
      account: fc.integer({ min: 0, max: 3 }), selector: fc.nat(10_000), amount: fc.integer({ min: -1, max: 6 }),
    });
    fc.assert(fc.property(fc.array(generated, { minLength: 1, maxLength: 120 }), operations => {
      interface ReferenceAccount { parent: number | undefined; cost: number; cap: number; spent: number; reserved: number; calls: number; held: number; closed: boolean }
      interface ReferenceTicket { actual: BudgetTicket | undefined; reservation: Reservation | undefined; account: number; bound: number; state: 'held' | 'started' | 'cancelled' | 'settled' }
      const root = new Budget(20, 20);
      const middle = root.fork({ id: 'middle', maxCostMicros: 12, maxCalls: 12 });
      const actual = [root, middle, middle.fork({ id: 'leaf', maxCostMicros: 8, maxCalls: 8 }), root.fork({ id: 'sibling', maxCostMicros: 20, maxCalls: 20 })];
      const reference: ReferenceAccount[] = [
        { parent: undefined, cost: 20, cap: 20, spent: 0, reserved: 0, calls: 0, held: 0, closed: false },
        { parent: 0, cost: 12, cap: 12, spent: 0, reserved: 0, calls: 0, held: 0, closed: false },
        { parent: 1, cost: 8, cap: 8, spent: 0, reserved: 0, calls: 0, held: 0, closed: false },
        { parent: 0, cost: 20, cap: 20, spent: 0, reserved: 0, calls: 0, held: 0, closed: false },
      ];
      const tickets: ReferenceTicket[] = []; const bundles: { actual: BudgetBundle; tickets: ReferenceTicket[] }[] = [];
      let blocked = false; let serial = 0;
      function path(index: number): ReferenceAccount[] {
        const result: ReferenceAccount[] = [];
        for (let current: number | undefined = index; current !== undefined; current = reference[current]!.parent) result.push(reference[current]!);
        return result;
      }
      function cancelReference(item: ReferenceTicket): void {
        if (item.state !== 'held') return;
        item.state = 'cancelled';
        for (const account of path(item.account)) { account.held--; account.reserved -= item.bound; }
      }
      for (const command of operations) {
        const target = actual[command.account]!; const ancestors = path(command.account);
        const bound = Math.max(0, command.amount);
        if (command.kind === 'bundle' || command.kind === 'reserve') {
          const bounds = command.kind === 'bundle' ? [bound, command.selector % 3] : [bound];
          const sum = bounds.reduce((total, amount) => total + amount, 0);
          const admitted = !blocked && ancestors.every(account => !account.closed && account.calls + account.held + bounds.length <= account.cap && account.spent + account.reserved + sum <= account.cost);
          const definitions = bounds.map(amount => operation(`generated-${serial++}`, amount));
          const call = (): BudgetBundle | Reservation => command.kind === 'bundle' ? target.reserveBundle(definitions) : target.reserve(bound);
          if (!admitted) expect(caught(call)).toMatchObject({ code: 'BUDGET_EXCEEDED' });
          else if (command.kind === 'bundle') {
            const bundle = target.reserveBundle(definitions);
            const owned = bundle.tickets.map((item, index): ReferenceTicket => ({ actual: item, reservation: undefined, account: command.account, bound: bounds[index]!, state: 'held' }));
            tickets.push(...owned); bundles.push({ actual: bundle, tickets: owned });
            for (const account of ancestors) { account.held += bounds.length; account.reserved += sum; }
          } else {
            tickets.push({ actual: undefined, reservation: target.reserve(bound), account: command.account, bound, state: 'started' });
            for (const account of ancestors) { account.calls++; account.reserved += bound; }
          }
        } else if (command.kind === 'account-close') {
          target.close(); reference[command.account]!.closed = true;
        } else if (command.kind === 'bundle-close') {
          if (bundles.length > 0) {
            const bundle = bundles[command.selector % bundles.length]!; bundle.actual.close();
            for (const item of bundle.tickets) cancelReference(item);
          }
        } else if (tickets.length > 0) {
          const item = tickets[command.selector % tickets.length]!; const owners = path(item.account);
          if (command.kind === 'start' && item.actual !== undefined) {
            if (item.state !== 'held') expect(caught(() => item.actual!.start())).toMatchObject({ code: 'CONFLICT' });
            else if (blocked || owners.some(account => account.closed)) expect(caught(() => item.actual!.start())).toMatchObject({ code: 'BUDGET_EXCEEDED' });
            else {
              item.reservation = item.actual.start(); item.state = 'started';
              for (const account of owners) { account.held--; account.calls++; }
            }
          } else if (command.kind === 'cancel' && item.actual !== undefined) {
            if (item.state === 'held' || item.state === 'cancelled') { item.actual.cancel(); cancelReference(item); }
            else expect(caught(() => item.actual!.cancel())).toMatchObject({ code: 'CONFLICT' });
          } else if (command.kind === 'settle' && item.reservation !== undefined) {
            if (item.state === 'settled') expect(caught(() => item.reservation!.settle(command.amount))).toMatchObject({ code: 'CONFLICT' });
            else if (command.amount < 0) expect(caught(() => item.reservation!.settle(command.amount))).toMatchObject({ code: 'BUDGET_EXCEEDED' });
            else {
              if (command.amount > item.bound) { expect(caught(() => item.reservation!.settle(command.amount))).toMatchObject({ code: 'BUDGET_EXCEEDED' }); blocked = true; }
              else item.reservation.settle(command.amount);
              item.state = 'settled';
              for (const account of owners) { account.reserved -= item.bound; account.spent += command.amount; }
            }
          }
        }
        for (let index = 0; index < actual.length; index++) {
          const expected = reference[index]!;
          expect(actual[index]!.snapshot()).toEqual({ spentMicros: expected.spent, reservedMicros: expected.reserved, calls: expected.calls });
          expect(actual[index]!.capacitySnapshot()).toEqual({ heldCalls: expected.held });
          expect(expected.reserved).toBeGreaterThanOrEqual(0); expect(expected.held).toBeGreaterThanOrEqual(0);
        }
      }
    }), { numRuns: 100, seed: 20_260_920 });
  });
});
