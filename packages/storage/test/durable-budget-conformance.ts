import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DurableBudgetSnapshot, DurableBudgetStore } from '@mayura/storage-contracts';
import type { DurableBudgetFixture } from './durable-budget-fixtures.js';

const key = { scope: 'budget-scope', id: 'budget-root', policyHash: 'a'.repeat(64) };
const rootCommand = { ...key, maxCostMicros: 10, maxCalls: 10 };
const account = (snapshot: DurableBudgetSnapshot, id = 'root') => {
  const found = snapshot.accounts.find(item => item.id === id); if (!found) throw new Error('Expected fixture budget account.'); return found;
};
async function bounded<T>(promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Durable-budget fixture did not reach its bounded barrier.')), timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}

/** Identical public contract assertions run against both selected SQL adapters. */
export function durableBudgetConformance(name: string, factory: () => Promise<DurableBudgetFixture>): void {
  describe(`${name} transactional durable budgets`, () => {
    let fixture: DurableBudgetFixture; let store: DurableBudgetFixture['store']; let stores: DurableBudgetFixture['store'][]; let api: DurableBudgetStore;
    const create = async (maxCostMicros = 10, maxCalls = 10) => (await api.create({ ...key, maxCostMicros, maxCalls })).snapshot;
    const child = (accountId: string, parentId = 'root', maxCostMicros = 10, maxCalls = 10) => api.fork({ ...key, parentId, accountId, maxCostMicros, maxCalls });
    const reserve = (accountId = 'root', id = 'ticket', maxCostMicros = 3, target = api) => target.reserveBundle({
      ...key, accountId, bundleId: `bundle-${id}`, operations: [{ id, maxCostMicros }],
    });
    const ticket = (reservationId = 'ticket', accountId = 'root') => ({ ...key, accountId, reservationId });
    const snapshot = async () => { const value = await api.inspect(key); if (!value) throw new Error('Expected fixture budget root.'); return value; };
    const reopen = async () => { const next = fixture.reopen(); stores.push(next); await next.initialize(); await next.durableBudgets.initialize(); return next; };
    const fingerprint = () => Promise.all(['mayura_durable_budgets', 'mayura_durable_budget_events'].map(async table => ({
      table, rows: await fixture.query(`SELECT * FROM ${fixture.prefix}${table} ORDER BY 1,2`),
    })));
    const mutate = async (change: (value: Record<string, unknown>) => void) => {
      const rows = await fixture.query(`SELECT state FROM ${fixture.prefix}mayura_durable_budgets WHERE scope = ? AND id = ?`, [key.scope, key.id]);
      const value = JSON.parse(String(rows[0]!['state'])) as Record<string, unknown>; change(value);
      await fixture.query(`UPDATE ${fixture.prefix}mayura_durable_budgets SET state = ? WHERE scope = ? AND id = ?`, [JSON.stringify(value), key.scope, key.id]);
    };
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; stores = [store]; await store.initialize();
      api = store.durableBudgets; await api.initialize();
    });
    afterEach(async () => { await Promise.all((stores ?? []).map(item => item.close())); await fixture?.cleanup(); });

    it('advertises the optional durable-budget capability', () => {
      expect(Object.hasOwn(fixture.store, 'durableBudgets')).toBe(true);
    });

    it('requires explicit per-handle initialization and returns undefined for an absent root', async () => {
      const next = fixture.reopen(); stores.push(next); await next.initialize();
      await expect(next.durableBudgets.inspect(key)).rejects.toMatchObject({ code: 'STORE_NOT_INITIALIZED' });
      expect(await next.durableBudgets.initialize()).toBeUndefined(); expect(await next.durableBudgets.inspect(key)).toBeUndefined();
    });

    it('owns creation commands and returns frozen detached snapshots with one atomic initial event', async () => {
      const command = { ...rootCommand }; const pending = api.create(command); command.maxCostMicros = 99;
      const result = await pending;
      expect(result.created).toBe(true); expect(result.snapshot).toMatchObject({ ...key, format: 1, mode: 'shared-ceiling-v1', owner: 'host-v1', version: 1, eventSequence: 1, blocked: false });
      expect(account(result.snapshot)).toMatchObject({ id: 'root', parentId: null, closed: false, maxCostMicros: 10, maxCalls: 10, spentMicros: 0, reservedMicros: 0, calls: 0, heldCalls: 0 });
      expect(Object.isFrozen(result.snapshot)).toBe(true); expect(Object.isFrozen(result.snapshot.accounts)).toBe(true);
      expect(Object.isFrozen(account(result.snapshot))).toBe(true); expect(await api.events(key)).toHaveLength(1);
      await child('child'); expect(result.snapshot.accounts).toHaveLength(1);
    });

    it('deduplicates concurrent root creation without changing immutable policy or limits', async () => {
      const second = (await reopen()).durableBudgets;
      const replies = await Promise.all([api.create(rootCommand), second.create(rootCommand)]);
      expect(replies.filter(item => item.created)).toHaveLength(1); expect(await api.events(key)).toHaveLength(1);
      const before = await fingerprint();
      await expect(api.create({ ...rootCommand, maxCalls: 11 })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(second.create({ ...rootCommand, policyHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await fingerprint()).toEqual(before);
    });

    it('rejects lossy Unicode identifiers before writes and preserves valid supplementary-plane identities', async () => {
      const before = await fingerprint();
      for (const field of ['scope', 'id'] as const) for (const malformed of ['\ud800', '\udfff', 'prefix\ud800suffix']) {
        await expect(api.create({ ...rootCommand, [field]: malformed })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      expect(await fingerprint()).toEqual(before);
      const unicodeKey = { ...key, scope: 'project/\u{1f680}', id: 'budget/\u{1f680}' };
      const created = await api.create({ ...unicodeKey, maxCostMicros: 10, maxCalls: 10 });
      const second = (await reopen()).durableBudgets;
      expect(await second.inspect(unicodeKey)).toEqual(created.snapshot);
      expect((await second.create({ ...unicodeKey, maxCostMicros: 10, maxCalls: 10 })).created).toBe(false);
    });

    it('forks ceilings without allocating money and preserves exact historical identities', async () => {
      await create(); await child('a'); await child('b'); await child('leaf', 'a', 6, 6);
      const before = await snapshot(); expect(before.accounts.every(value => value.reservedMicros === 0 && value.spentMicros === 0 && value.heldCalls === 0)).toBe(true);
      expect(await child('leaf', 'a', 6, 6)).toEqual(before);
      for (const command of [{ parentId: 'b', accountId: 'leaf', maxCostMicros: 6, maxCalls: 6 },
        { parentId: 'a', accountId: 'leaf', maxCostMicros: 5, maxCalls: 6 }]) {
        await expect(api.fork({ ...key, ...command })).rejects.toMatchObject({ code: 'CONFLICT' });
      }
      await expect(child('too-large', 'leaf', 7, 6)).rejects.toBeDefined();
      await expect(child('root')).rejects.toBeDefined(); expect(await snapshot()).toEqual(before);
    });

    it('atomically enforces root and intermediate ceilings while updating only the exact ancestor path', async () => {
      await create(); await child('a', 'root', 6, 6); await child('b'); await child('leaf', 'a', 6, 6);
      const held = await reserve('leaf', 'leaf-ticket', 6);
      for (const id of ['root', 'a', 'leaf']) expect(account(held, id)).toMatchObject({ reservedMicros: 6, heldCalls: 1, calls: 0 });
      expect(account(held, 'b').reservedMicros).toBe(0);
      await expect(reserve('a', 'parent-overflow', 1)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      await expect(reserve('b', 'root-overflow', 5)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await snapshot()).toEqual(held); await reserve('b', 'sibling', 4);
      expect(account(await snapshot()).reservedMicros).toBe(10);
    });

    it('permits only one concurrent sibling reservation for the final shared money and held-call capacity', async () => {
      await create(5, 1); await child('a', 'root', 5, 1); await child('b', 'root', 5, 1);
      const second = (await reopen()).durableBudgets;
      const results = await Promise.allSettled([reserve('a', 'a-ticket', 5), reserve('b', 'b-ticket', 5, second)]);
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(item => item.status === 'rejected')).toMatchObject({ reason: { code: 'LIMIT_EXCEEDED' } });
      expect(account(await snapshot())).toMatchObject({ reservedMicros: 5, heldCalls: 1, calls: 0 });
      expect((await snapshot()).reservations).toHaveLength(1);
    });

    it('counts free held and historical calls and never refunds a started call', async () => {
      await create(0, 1); await reserve('root', 'free', 0);
      await expect(reserve('root', 'free-overflow', 0)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect((await api.start(ticket('free'))).status).toBe('started');
      await api.settle({ ...ticket('free'), actualMicros: 0 });
      expect(account(await snapshot())).toMatchObject({ calls: 1, heldCalls: 0, reservedMicros: 0, spentMicros: 0 });
      await expect(reserve('root', 'another-free', 0)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    });

    it('reserves bundles all-or-nothing and owns their immutable operation order and identities', async () => {
      await create(5); const before = await snapshot();
      await expect(api.reserveBundle({ ...key, accountId: 'root', bundleId: 'atomic', operations: [{ id: 'one', maxCostMicros: 3 }, { id: 'two', maxCostMicros: 3 }] })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await snapshot()).toEqual(before);
      const command = { ...key, accountId: 'root', bundleId: 'atomic', operations: [{ id: 'one', maxCostMicros: 2 }, { id: 'two', maxCostMicros: 3 }] };
      const pending = api.reserveBundle(command); command.operations[0]!.id = 'mutated';
      const held = await pending; expect(held.bundles[0]!.operations.map(item => item.id)).toEqual(['one', 'two']);
      await expect(api.reserveBundle({ ...key, accountId: 'root', bundleId: 'other', operations: [{ id: 'unused', maxCostMicros: 0 }, { id: 'one', maxCostMicros: 0 }] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await snapshot()).toEqual(held);
      await api.cancelReservation(ticket('one')); await api.start(ticket('two')); await api.settle({ ...ticket('two'), actualMicros: 2 });
      const settled = await snapshot();
      expect(await api.reserveBundle({ ...key, accountId: 'root', bundleId: 'atomic', operations: [{ id: 'one', maxCostMicros: 2 }, { id: 'two', maxCostMicros: 3 }] })).toEqual(settled);
      await expect(api.reserveBundle({ ...key, accountId: 'root', bundleId: 'atomic', operations: [{ id: 'two', maxCostMicros: 3 }, { id: 'one', maxCostMicros: 2 }] })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('starts a shared ticket exactly once and treats lost acknowledgements as already_started', async () => {
      await create(); await reserve(); const second = (await reopen()).durableBudgets;
      const attempts = await Promise.all([api.start(ticket()), second.start(ticket())]);
      expect(attempts.map(value => value.status).sort()).toEqual(['already_started', 'started']);
      const after = await snapshot(); expect(account(after)).toMatchObject({ calls: 1, heldCalls: 0, reservedMicros: 3 });
      // The successful response may have been lost: a retry must never grant another first start.
      expect(await second.start(ticket())).toEqual({ snapshot: after, status: 'already_started' });
      await api.markUnknown(ticket()); expect((await api.start(ticket())).status).toBe('already_started');
      await api.settle({ ...ticket(), actualMicros: 2 }); expect((await api.start(ticket())).status).toBe('already_started');
      expect(account(await snapshot()).calls).toBe(1);
    });

    it.each(['fork', 'bundle'] as const)('deduplicates concurrent identical %s admission and rejects changed immutable content', async method => {
      await create(); const second = (await reopen()).durableBudgets;
      const command = { ...key, parentId: 'root', accountId: 'race-child', maxCostMicros: 5, maxCalls: 5 };
      const replies = method === 'fork' ? await Promise.all([api.fork(command), second.fork(command)])
        : await Promise.all([reserve('root', 'race-ticket', 3), reserve('root', 'race-ticket', 3, second)]);
      expect(replies[0]).toEqual(replies[1]); expect((await snapshot()).version).toBe(2); expect(await api.events(key)).toHaveLength(2);
      const before = await snapshot();
      if (method === 'fork') await expect(second.fork({ ...command, maxCostMicros: 4 })).rejects.toMatchObject({ code: 'CONFLICT' });
      else await expect(reserve('root', 'race-ticket', 2, second)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await snapshot()).toEqual(before);
    });

    it('retains unknown funds across closure and restart and accepts exactly one late known cost', async () => {
      await create(); await child('child'); await reserve('child'); await api.start(ticket('ticket', 'child')); await api.markUnknown(ticket('ticket', 'child'));
      await api.closeSubtree({ ...key, accountId: 'root' }); const unknown = await snapshot();
      expect(account(unknown)).toMatchObject({ closed: true, reservedMicros: 3, calls: 1, heldCalls: 0 });
      await store.close(); store = await reopen(); api = store.durableBudgets; expect(await snapshot()).toEqual(unknown);
      const settled = await api.settle({ ...ticket('ticket', 'child'), actualMicros: 2 }); expect(settled.overrun).toBe(false);
      for (const id of ['root', 'child']) expect(account(settled.snapshot, id)).toMatchObject({ spentMicros: 2, reservedMicros: 0, calls: 1, heldCalls: 0 });
      expect(await api.settle({ ...ticket('ticket', 'child'), actualMicros: 2 })).toEqual(settled);
      await expect(api.settle({ ...ticket('ticket', 'child'), actualMicros: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await api.markUnknown(ticket('ticket', 'child'))).toEqual(settled.snapshot);
    });

    it('closes only the chosen subtree and cancels held tickets without refunding started or unknown usage', async () => {
      await create(); await child('a'); await child('leaf', 'a'); await child('b');
      await reserve('a', 'held', 2); await reserve('leaf', 'started', 3); await reserve('b', 'sibling', 4);
      await api.start(ticket('started', 'leaf')); await api.markUnknown(ticket('started', 'leaf'));
      const closed = await api.closeSubtree({ ...key, accountId: 'a' });
      expect(account(closed)).toMatchObject({ reservedMicros: 7, heldCalls: 1, calls: 1 });
      expect(closed.reservations.find(value => value.id === 'held')!.status).toBe('cancelled');
      expect(closed.reservations.find(value => value.id === 'started')!.status).toBe('unknown');
      await expect(reserve('leaf', 'after-close', 0)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(child('new-child', 'leaf')).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(api.cancelReservation(ticket('started', 'leaf'))).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await api.start(ticket('sibling', 'b'))).status).toBe('started');
      await api.settle({ ...ticket('started', 'leaf'), actualMicros: 2 });
      expect(account(await snapshot(), 'a')).toMatchObject({ reservedMicros: 0, spentMicros: 2, calls: 1 });
    });

    it.each(['reserve', 'start', 'fork'] as const)('serializes subtree closure against concurrent %s without surviving admission authority', async operation => {
      await create(); if (operation === 'start') await reserve();
      const second = (await reopen()).durableBudgets;
      const competing = operation === 'reserve' ? reserve('root', 'racing', 3, second)
        : operation === 'start' ? second.start(ticket()) : second.fork({ ...key, parentId: 'root', accountId: 'racing-child', maxCostMicros: 10, maxCalls: 10 });
      const results = await Promise.allSettled([competing, api.closeSubtree({ ...key, accountId: 'root' })]);
      expect(results[1]!.status).toBe('fulfilled');
      const current = await snapshot(); expect(account(current)).toMatchObject({ closed: true, heldCalls: 0 });
      expect(current.reservations.every(value => ['started', 'cancelled'].includes(value.status))).toBe(true);
      if (operation !== 'start') expect(account(current).reservedMicros).toBe(0);
      else expect(account(current)).toMatchObject(current.reservations[0]!.status === 'started'
        ? { reservedMicros: 3, calls: 1 } : { reservedMicros: 0, calls: 0 });
      await expect(reserve('root', 'new-after-close', 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('commits exact above-safe-integer overruns before blocking further admission and still accepts late evidence', async () => {
      await create(3); await child('a', 'root', 3); await child('b', 'root', 3);
      await reserve('a', 'first', 1); await reserve('b', 'second', 1); await reserve('root', 'held', 1);
      await api.start(ticket('first', 'a')); await api.start(ticket('second', 'b')); await api.markUnknown(ticket('second', 'b'));
      const first = await api.settle({ ...ticket('first', 'a'), actualMicros: Number.MAX_SAFE_INTEGER });
      expect(first.overrun).toBe(true); expect(first.snapshot.blocked).toBe(true); expect(account(first.snapshot).spentMicros).toBe(Number.MAX_SAFE_INTEGER);
      for (const action of [() => child('blocked-child', 'root', 1), () => reserve('a', 'blocked-reserve', 0), () => api.start(ticket('held'))]) {
        await expect(action()).rejects.toMatchObject({ code: 'CONFLICT' });
      }
      const second = await api.settle({ ...ticket('second', 'b'), actualMicros: Number.MAX_SAFE_INTEGER });
      expect(second.overrun).toBe(true); expect(account(second.snapshot).spentMicros).toBe((BigInt(Number.MAX_SAFE_INTEGER) * 2n).toString());
      expect(account(second.snapshot, 'a').spentMicros).toBe(Number.MAX_SAFE_INTEGER); expect(account(second.snapshot, 'b').spentMicros).toBe(Number.MAX_SAFE_INTEGER);
      await api.cancelReservation(ticket('held')); const before = await snapshot();
      await store.close(); store = await reopen(); api = store.durableBudgets; expect(await snapshot()).toEqual(before);
      expect((await api.settle({ ...ticket('second', 'b'), actualMicros: Number.MAX_SAFE_INTEGER })).snapshot).toEqual(before);
    });

    it('does not grow versions or history on historical retries and repeated cleanup', async () => {
      await create(); await child('child'); await reserve('child'); await api.closeSubtree({ ...key, accountId: 'root' });
      const before = await snapshot(); const events = await api.events(key);
      for (let index = 0; index < 4; index++) {
        expect((await api.create(rootCommand)).snapshot).toEqual(before); expect(await child('child')).toEqual(before);
        expect(await reserve('child')).toEqual(before); expect(await api.cancelReservation(ticket('ticket', 'child'))).toEqual(before);
        expect(await api.closeSubtree({ ...key, accountId: 'root' })).toEqual(before);
      }
      expect(await api.events(key)).toEqual(events);
    });

    it('rejects invalid transitions and costs without releasing uncertain reservations', async () => {
      await create(); await reserve(); const held = await snapshot();
      await expect(api.markUnknown(ticket())).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(api.settle({ ...ticket(), actualMicros: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await snapshot()).toEqual(held); await api.start(ticket()); await api.markUnknown(ticket()); const unknown = await snapshot();
      for (const actualMicros of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) await expect(api.settle({ ...ticket(), actualMicros })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(api.cancelReservation(ticket())).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await snapshot()).toEqual(unknown);
    });

    it('isolates scope, root, policy and exact ticket ownership without changing unrelated records', async () => {
      await create(); await child('a'); await child('b'); await reserve('a'); const before = await fingerprint();
      expect(await api.inspect({ ...key, scope: 'other-scope' })).toBeUndefined();
      expect(await api.inspect({ ...key, id: 'other-root' })).toBeUndefined();
      await expect(api.inspect({ ...key, policyHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(api.start(ticket('ticket', 'b'))).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(api.start(ticket('absent', 'a'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(api.closeSubtree({ ...key, accountId: 'absent' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await fingerprint()).toEqual(before);
    });

    it('bounds ancestry at sixteen without partial admission or reparenting', async () => {
      await create(); let parentId = 'root';
      for (let depth = 1; depth <= 16; depth++) { await child(`depth-${depth}`, parentId); parentId = `depth-${depth}`; }
      const before = await snapshot(); await expect(child('too-deep', parentId)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      await expect(child('depth-1', parentId)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await snapshot()).toEqual(before);
    });

    it.each(['bundles', 'reservations'] as const)('independently enforces the lifetime %s bound without consuming a rejected identity', async bound => {
      await create(0, 1024); const bundles = bound === 'bundles' ? 128 : 16; const width = bound === 'bundles' ? 1 : 32;
      for (let index = 0; index < bundles; index++) await api.reserveBundle({ ...key, accountId: 'root', bundleId: `cap-${index}`,
        operations: Array.from({ length: width }, (_, ordinal) => ({ id: `cap-${index}-${ordinal}`, maxCostMicros: 0 })) });
      const before = await snapshot();
      expect(before.bundles).toHaveLength(bundles); expect(before.reservations).toHaveLength(bundles * width);
      await expect(reserve('root', 'cap-overflow', 0)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await snapshot()).toEqual(before); await api.closeSubtree({ ...key, accountId: 'root' });
      await expect(reserve('root', 'cap-overflow', 0)).rejects.toMatchObject({ code: 'CONFLICT' });
    }, 30_000);

    it.each(['counter', 'ancestry', 'reservation-owner', 'bundle-content', 'actual', 'mode', 'row-version'] as const)('fails closed on %s corruption and does not mutate corrupted financial evidence', async mutation => {
      await create(); await child('child'); await reserve('child');
      if (mutation === 'row-version') await fixture.query(`UPDATE ${fixture.prefix}mayura_durable_budgets SET version = version + 1 WHERE scope = ? AND id = ?`, [key.scope, key.id]);
      else await mutate(value => {
        const accounts = value['accounts'] as Record<string, unknown>[]; const reservations = value['reservations'] as Record<string, unknown>[];
        if (mutation === 'counter') accounts.find(item => item['id'] === 'root')!['spentMicros'] = 1;
        if (mutation === 'ancestry') accounts.find(item => item['id'] === 'child')!['parentId'] = 'child';
        if (mutation === 'reservation-owner') reservations[0]!['accountId'] = 'root';
        if (mutation === 'bundle-content') ((value['bundles'] as Record<string, unknown>[])[0]!['operations'] as Record<string, unknown>[])[0]!['maxCostMicros'] = 2;
        if (mutation === 'actual') reservations[0]!['actualMicros'] = 0;
        if (mutation === 'mode') value['mode'] = 'SECRET_UNSUPPORTED_MODE';
      });
      const before = await fingerprint();
      const error: unknown = await api.inspect(key).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(String(error)).not.toContain('SECRET');
      await expect(api.closeSubtree({ ...key, accountId: 'root' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(await fingerprint()).toEqual(before);
    });

    it('rejects malformed stored event payloads without disclosing private fields', async () => {
      await create(); await fixture.query(`UPDATE ${fixture.prefix}mayura_durable_budget_events SET data = ? WHERE scope = ? AND budget_id = ?`, [JSON.stringify({ SECRET: 'private-financial-payload' }), key.scope, key.id]);
      const error: unknown = await api.events(key).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(String(error)).not.toContain('SECRET');
    });

    it('allows an unrelated PostgreSQL root to progress while another root row is locked', async () => {
      if (fixture.childOptions.adapter !== 'postgres') return; // SQLite deliberately serializes writers database-wide.
      await create(); const otherKey = { ...key, id: 'unrelated-root' }; await api.create({ ...otherKey, maxCostMicros: 10, maxCalls: 10 });
      const second = (await reopen()).durableBudgets; const release = await fixture.lockRoot(key.scope, key.id);
      let settled = false; const blocked = api.reserveBundle({ ...key, accountId: 'root', bundleId: 'blocked', operations: [{ id: 'blocked', maxCostMicros: 1 }] }).finally(() => { settled = true; });
      void blocked.catch(() => {});
      try {
        await bounded(second.reserveBundle({ ...otherKey, accountId: 'root', bundleId: 'independent', operations: [{ id: 'independent', maxCostMicros: 1 }] }));
        expect(settled).toBe(false);
      } finally { await release(); await bounded(blocked); }
      expect(account((await second.inspect(otherKey))!).reservedMicros).toBe(1);
    });

    it('retains the complete terminal suffix after all account, bundle and reservation admission bounds are full', async () => {
      await create(512, 2048); const owners = ['root'];
      for (let index = 0; index < 127; index++) { const id = `account-${String(index).padStart(3, '0')}`; await child(id, 'root', 512, 2048); owners.push(id); }
      const commands: { accountId: string; reservationId: string }[] = [];
      for (let index = 0; index < 128; index++) {
        const operations = Array.from({ length: 4 }, (_, ordinal) => ({ id: `ticket-${index}-${ordinal}`, maxCostMicros: 1 }));
        await api.reserveBundle({ ...key, accountId: owners[index]!, bundleId: `bundle-${index}`, operations });
        commands.push(...operations.map(operation => ({ accountId: owners[index]!, reservationId: operation.id })));
      }
      const full = await snapshot(); expect(full.accounts).toHaveLength(128); expect(full.bundles).toHaveLength(128); expect(full.reservations).toHaveLength(512);
      await expect(child('overflow-account', 'root', 0, 1)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      await expect(reserve('root', 'overflow-ticket', 0)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await snapshot()).toEqual(full);
      // A bounded batch reduces transport overhead, without exceeding adapter queues or bypassing public commits.
      const batches = async (operation: (command: typeof commands[number]) => Promise<unknown>) => {
        for (let index = 0; index < commands.length; index += 8) await Promise.all(commands.slice(index, index + 8).map(operation));
      };
      await batches(command => api.start({ ...key, ...command }));
      await batches(command => api.markUnknown({ ...key, ...command }));
      for (const accountId of [...owners.slice(1), 'root']) await api.closeSubtree({ ...key, accountId });
      expect(account(await snapshot())).toMatchObject({ reservedMicros: 512, calls: 512, heldCalls: 0 });
      await batches(command => api.settle({ ...key, ...command, actualMicros: 1 }));
      const terminal = await snapshot(); expect(account(terminal)).toMatchObject({ spentMicros: 512, reservedMicros: 0, calls: 512, heldCalls: 0 });
      expect(terminal.version).toBe(1920); expect(terminal.eventSequence).toBe(1920); expect(terminal.accounts.every(value => value.closed)).toBe(true);
      expect(terminal.reservations.every(value => value.status === 'settled')).toBe(true); expect(Buffer.byteLength(JSON.stringify(terminal))).toBeLessThanOrEqual(1_048_576);
      const first = await api.events(key); expect(first).toHaveLength(1000);
      const second = await api.events({ ...key, after: first.at(-1)!.sequence }); expect(second).toHaveLength(920);
      expect([...first, ...second].map(value => value.sequence)).toEqual(Array.from({ length: 1920 }, (_, index) => index + 1));
      expect(await api.closeSubtree({ ...key, accountId: 'root' })).toEqual(terminal);
    // This is bounded durability/headroom qualification, not a production throughput guarantee.
    // Deliberately fills every bound with hundreds of durable transactions: about 95 s on a fast local disk and more than
    // 180 s on hosted Windows runners, so it gets a longer ceiling than the default.
    }, 600_000);

    it.each(['reserve-before', 'reserve-after', 'start-before', 'start-after', 'settle-before', 'settle-after'] as const)(
      'survives an actual owned-process kill at %s without partial ancestor accounting or replay permission', async phase => {
        await create(); await child('child');
        const reserveCommand = { ...key, accountId: 'child', bundleId: 'crash-bundle', operations: [{ id: 'crash-ticket', maxCostMicros: 3 }] };
        const startCommand = ticket('crash-ticket', 'child'); const settleCommand = { ...startCommand, actualMicros: 2 };
        if (!phase.startsWith('reserve')) await api.reserveBundle(reserveCommand);
        if (phase.startsWith('settle')) { await api.start(startCommand); await api.markUnknown(startCommand); }
        const before = await snapshot(); const method = phase.startsWith('reserve') ? 'reserveBundle' : phase.startsWith('start') ? 'start' : 'settle';
        const command = method === 'reserveBundle' ? reserveCommand : method === 'start' ? startCommand : settleCommand;
        const childProcess = fork(fileURLToPath(new URL('./fixtures/durable-budget-child.mjs', import.meta.url)), [JSON.stringify({ ...fixture.childOptions, phase, method, command })],
          { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let exited = false; const exit = new Promise<void>(resolve => { childProcess.once('exit', () => { exited = true; resolve(); }); });
        const checkpoint = new Promise<void>((resolve, reject) => {
          childProcess.once('error', reject); childProcess.on('message', (message: { kind?: string; stage?: unknown }) => {
            if (message.kind === 'checkpoint') resolve(); else reject(new Error('Durable-budget child failed before its durable checkpoint.'));
          }); childProcess.once('exit', () => { reject(new Error('Durable-budget child exited before its durable checkpoint.')); });
        });
        try {
          await bounded(checkpoint); childProcess.kill('SIGKILL'); await bounded(exit);
          await store.close(); store = await reopen(); api = store.durableBudgets;
          const recovered = await snapshot();
          if (phase.endsWith('before')) expect(recovered).toEqual(before);
          else { expect(recovered.version).toBe(before.version + 1); expect(recovered.eventSequence).toBe(before.eventSequence + 1); }
          if (method === 'reserveBundle') {
            await api.reserveBundle(reserveCommand); expect(account(await snapshot())).toMatchObject({ reservedMicros: 3, heldCalls: 1, calls: 0 });
          } else if (method === 'start') {
            expect((await api.start(startCommand)).status).toBe(phase.endsWith('before') ? 'started' : 'already_started');
            expect(account(await snapshot())).toMatchObject({ reservedMicros: 3, heldCalls: 0, calls: 1 });
          } else {
            const known = await api.settle(settleCommand); expect(known.overrun).toBe(false);
            for (const id of ['root', 'child']) expect(account(known.snapshot, id)).toMatchObject({ spentMicros: 2, reservedMicros: 0, calls: 1 });
          }
          const current = await snapshot(); expect(await api.events(key)).toHaveLength(current.eventSequence);
        } finally { if (!exited) childProcess.kill('SIGKILL'); await bounded(exit); }
      }, 30_000);
  });
}
