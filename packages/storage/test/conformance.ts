import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AggregateStore, CreateRecord } from '../src/contracts.js';
import type { JsonObject } from '@mayura/core';

export interface StoreFixture {
  readonly store: AggregateStore;
  reopen(): AggregateStore;
  cleanup(): Promise<void>;
}

/** The same public behavior is required from every persistent adapter. */
export function aggregateConformance(name: string, fixtureFactory: () => Promise<StoreFixture>): void {
  describe(`${name} aggregate conformance`, () => {
    let fixture: StoreFixture;
    let store: AggregateStore;
    const initial = (overrides: Partial<CreateRecord> = {}): CreateRecord => ({
      scope: 'tenant-a', id: 'run-1', idempotencyKey: 'submission-1', definitionHash: 'definition-sha256',
      state: { status: 'queued', nested: { b: 2, a: 1 } }, events: [{ type: 'run.created', data: { value: 1 } }], ...overrides,
    });
    beforeEach(async () => { fixture = await fixtureFactory(); store = fixture.store; await store.initialize(); });
    afterEach(async () => { await store?.close(); await fixture?.cleanup(); });

    it('creates one scoped record with ordered store-timestamped events', async () => {
      const created = await store.create(initial({ events: [
        { type: 'run.created', data: {} }, { type: 'step.ready', data: { id: 'step-1' } },
      ] }));
      expect(created.created).toBe(true);
      expect(created.record).toMatchObject({ scope: 'tenant-a', id: 'run-1', version: 1 });
      expect(await store.read('tenant-a', 'run-1')).toEqual(created.record);
      const events = await store.events('tenant-a', 'run-1');
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(events[1]?.type).toBe('step.ready');
      expect(events.every((event) => Number.isFinite(Date.parse(event.createdAt)))).toBe(true);
    });

    it('compares retries to the original canonical submission after current state mutates', async () => {
      const command = initial();
      await store.create(command);
      await store.update({ scope: 'tenant-a', id: 'run-1', expectedVersion: 1, state: { status: 'completed' }, events: [{ type: 'run.completed', data: {} }] });
      const retry = await store.create(initial({ state: { nested: { a: 1, b: 2 }, status: 'queued' } }));
      expect(retry.created).toBe(false);
      expect(retry.record.version).toBe(2);
      expect(retry.record.state).toEqual({ status: 'completed' });
      expect(await store.events('tenant-a', 'run-1')).toHaveLength(2);
      await expect(store.create(initial({ state: { status: 'completed' } }))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects changes to ID, definition, initial state or initial events under the same key', async () => {
      await store.create(initial());
      for (const overrides of [
        { id: 'other-id' }, { definitionHash: 'other-definition' }, { state: { changed: true } },
        { events: [{ type: 'other-event', data: {} }] },
      ]) await expect(store.create(initial(overrides))).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await store.read('tenant-a', 'other-id')).toBeUndefined();
      expect(await store.events('tenant-a', 'run-1')).toHaveLength(1);
      await expect(store.create(initial({ idempotencyKey: 'other-key' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('deduplicates concurrent identical submissions', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => store.create(initial())));
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.every((result) => result.record.version === 1)).toBe(true);
      expect(await store.events('tenant-a', 'run-1')).toHaveLength(1);
    });

    it('commits exactly one concurrent CAS update and no losing events', async () => {
      await store.create(initial());
      const updates = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.update({
        scope: 'tenant-a', id: 'run-1', expectedVersion: 1, state: { winner: index }, events: [{ type: 'winner', data: { index } }],
      })));
      expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = updates.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(7);
      expect(rejected.every((result) => result.status === 'rejected' && (result.reason as { code?: string }).code === 'CONFLICT')).toBe(true);
      const snapshot = await store.read('tenant-a', 'run-1');
      const events = await store.events('tenant-a', 'run-1');
      expect(snapshot?.version).toBe(2);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(events[1]?.data).toEqual({ index: snapshot?.state['winner'] });
    });

    it('preserves CAS and event atomicity across independent adapter instances', async () => {
      await store.create(initial());
      const other = fixture.reopen();
      try {
        await other.initialize();
        const updates = await Promise.allSettled([store, other].map((adapter, index) => adapter.update({
          scope: 'tenant-a', id: 'run-1', expectedVersion: 1, state: { winner: index }, events: [{ type: 'winner', data: { index } }],
        })));
        expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(updates.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect((await other.read('tenant-a', 'run-1'))?.version).toBe(2);
        expect((await store.events('tenant-a', 'run-1')).map((event) => event.sequence)).toEqual([1, 2]);
      } finally { await other.close(); }
    });

    it('isolates reads, updates, events and uniqueness by verified scope', async () => {
      await store.create(initial());
      expect(await store.read('tenant-b', 'run-1')).toBeUndefined();
      expect(await store.events('tenant-b', 'run-1')).toEqual([]);
      await expect(store.update({ scope: 'tenant-b', id: 'run-1', expectedVersion: 1, state: {}, events: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const second = await store.create(initial({ scope: 'tenant-b', state: { isolated: true } }));
      expect(second.created).toBe(true);
      expect((await store.read('tenant-a', 'run-1'))?.state['status']).toBe('queued');
      expect((await store.read('tenant-b', 'run-1'))?.state['isolated']).toBe(true);
    });

    it('returns copied JSON snapshots, preserving escaped null and Unicode content', async () => {
      const state = { text: 'hello\u0000日本語', deep: { item: 1 } };
      const created = await store.create(initial({ state }));
      state.deep.item = 99;
      (created.record.state['deep'] as JsonObject)['item'] = 77;
      expect((await store.read('tenant-a', 'run-1'))?.state).toEqual({ text: 'hello\u0000日本語', deep: { item: 1 } });
    });

    it('rejects oversized or non-JSON input without creating or updating records', async () => {
      const invalidStates: unknown[] = [[], null, { value: NaN }, { value: 1n }, { value: undefined }, { value: 'x'.repeat(1_048_577) }];
      const cycle: Record<string, unknown> = {}; cycle['self'] = cycle; invalidStates.push(cycle);
      for (const state of invalidStates) await expect(store.create(initial({ state: state as JsonObject }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await store.read('tenant-a', 'run-1')).toBeUndefined();
      await store.create(initial());
      await expect(store.update({ scope: 'tenant-a', id: 'run-1', expectedVersion: 1, state: {}, events: [{ type: 'oversize', data: { text: 'x'.repeat(65_537) } }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await store.read('tenant-a', 'run-1'))?.version).toBe(1);
      expect(await store.events('tenant-a', 'run-1')).toHaveLength(1);
    });

    it('bounds identifier and cursor values', async () => {
      await expect(store.create(initial({ scope: 'x'.repeat(257) }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.read('tenant\0a', 'run-1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.events('tenant-a', 'run-1', -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.events('tenant-a', 'run-1', 0.5)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.update({ scope: 'tenant-a', id: 'run-1', expectedVersion: 0, state: {}, events: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('paginates ordered events and never repeats the cursor event', async () => {
      await store.create(initial({ events: Array.from({ length: 1_000 }, (_, index) => ({ type: 'item', data: { index } })) }));
      await store.update({ scope: 'tenant-a', id: 'run-1', expectedVersion: 1, state: {}, events: [{ type: 'last', data: {} }] });
      const first = await store.events('tenant-a', 'run-1');
      expect(first).toHaveLength(1_000);
      const second = await store.events('tenant-a', 'run-1', first.at(-1)!.sequence);
      expect(second.map((event) => event.sequence)).toEqual([1_001]);
      expect(await store.events('tenant-a', 'run-1', 1_001)).toEqual([]);
    });

    it('persists records, original submission digests and events across adapter restart', async () => {
      await store.create(initial());
      await store.update({ scope: 'tenant-a', id: 'run-1', expectedVersion: 1, state: { recovered: true }, events: [{ type: 'updated', data: {} }] });
      await store.close();
      await expect(store.read('tenant-a', 'run-1')).rejects.toMatchObject({ code: 'STORE_CLOSED' });
      store = fixture.reopen();
      await store.initialize();
      expect((await store.read('tenant-a', 'run-1'))?.state).toEqual({ recovered: true });
      expect((await store.create(initial())).created).toBe(false);
      expect((await store.events('tenant-a', 'run-1')).map((event) => event.sequence)).toEqual([1, 2]);
    });

    it('initializes and closes idempotently', async () => {
      await Promise.all([store.initialize(), store.initialize()]);
      await store.create(initial());
      await Promise.all([store.close(), store.close()]);
      await expect(store.initialize()).rejects.toMatchObject({ code: 'STORE_CLOSED' });
    });
  });
}
