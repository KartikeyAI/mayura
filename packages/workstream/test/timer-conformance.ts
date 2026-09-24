import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError, type AggregateStore, type StoredRecord } from '@mayura/storage';
import { createTimerWorkStream, type TimerWorkStream, type TimerWorkStreamOptions } from '../src/timers.js';
import type { WorkStreamFixture } from './fixtures.js';

const scope = { principalId: 'operator', projectId: 'project' };

/** The same durable timer semantics run against every reference aggregate adapter. */
export function timerWorkStreamConformance(name: string, factory: () => Promise<WorkStreamFixture>): void {
  describe(`${name} timer WorkStream conformance`, () => {
    let fixture: WorkStreamFixture; let store: AggregateStore; let now: number;
    const create = (overrides: Partial<TimerWorkStreamOptions> = {}): TimerWorkStream => createTimerWorkStream({
      store, scope, streamId: 'timers', now: () => now, ...overrides,
    });
    const initialized = async (overrides: Partial<TimerWorkStreamOptions> = {}): Promise<TimerWorkStream> => {
      const value = create(overrides); await value.initialize(); return value;
    };
    beforeEach(async () => { fixture = await factory(); store = fixture.store; await store.initialize(); now = 1_000; });
    afterEach(async () => { vi.restoreAllMocks(); await store?.close(); await fixture?.cleanup(); });

    it('schedules immutable exact definitions and rejects changed retries', async () => {
      const timers = await initialized(); const scheduled = await timers.schedule({ id: 'deploy', dueAtMs: 2_000, payload: { release: 'v1' } });
      expect(scheduled).toEqual({ id: 'deploy', dueAtMs: 2_000, payload: { release: 'v1' }, status: 'scheduled' });
      expect(Object.isFrozen(scheduled)).toBe(true); expect(Object.isFrozen(scheduled.payload)).toBe(true);
      expect(await timers.schedule({ payload: { release: 'v1' }, dueAtMs: 2_000, id: 'deploy' })).toEqual(scheduled);
      await expect(timers.schedule({ id: 'deploy', dueAtMs: 2_001, payload: { release: 'v1' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('fires only due timers in deterministic due-time and ID order with bounded pages', async () => {
      const timers = await initialized();
      await timers.schedule({ id: 'later', dueAtMs: 3_000 }); await timers.schedule({ id: 'b', dueAtMs: 2_000 }); await timers.schedule({ id: 'a', dueAtMs: 2_000 });
      now = 2_500;
      expect((await timers.sweepDue({ limit: 1 })).map(timer => timer.id)).toEqual(['a']);
      expect((await timers.sweepDue({ limit: 1 })).map(timer => timer.id)).toEqual(['b']);
      expect(await timers.sweepDue()).toEqual([]);
      expect(await timers.inspect('later')).toMatchObject({ status: 'scheduled' });
      now = 3_000; expect(await timers.sweepDue()).toMatchObject([{ id: 'later', status: 'fired', firedAtMs: 3_000 }]);
    });

    it('survives close/reopen without a live timeout or worker', async () => {
      const first = await initialized(); await first.schedule({ id: 'restart', dueAtMs: 2_000 });
      await store.close(); store = fixture.reopen(); await store.initialize(); now = 2_500;
      const recovered = await initialized();
      expect(await recovered.inspect('restart')).toMatchObject({ status: 'scheduled' });
      expect(await recovered.sweepDue()).toMatchObject([{ id: 'restart', status: 'fired', firedAtMs: 2_500 }]);
    });

    it('settles cancel-versus-fire races through one aggregate transition', async () => {
      const first = await initialized(); const second = await initialized(); await first.schedule({ id: 'race', dueAtMs: 1_000 });
      const results = await Promise.all([first.cancel('race'), second.sweepDue()]);
      const terminal = await first.inspect('race'); expect(['cancelled', 'fired']).toContain(terminal?.status);
      expect(results.flatMap(value => Array.isArray(value) ? value : [value]).every(value => value.status === terminal?.status)).toBe(true);
      const events = await first.events();
      expect(events.filter(event => event.type === 'timer.cancelled' || event.type === 'timer.fired')).toHaveLength(1);
    });

    it('keeps cancellation terminal and never treats it as firing', async () => {
      const timers = await initialized(); await timers.schedule({ id: 'cancelled', dueAtMs: 2_000 });
      expect(await timers.cancel('cancelled')).toMatchObject({ status: 'cancelled' });
      now = 3_000; expect(await timers.sweepDue()).toEqual([]);
      expect(await timers.cancel('cancelled')).not.toHaveProperty('firedAtMs');
    });

    it('provides stable bounded ID pagination without changing state', async () => {
      const timers = await initialized();
      for (const id of ['c', 'a', 'b']) await timers.schedule({ id, dueAtMs: 2_000 });
      const first = await timers.list({ limit: 2 }); expect(first.items.map(timer => timer.id)).toEqual(['a', 'b']); expect(first.next).toBe('b');
      const second = await timers.list({ afterId: first.next!, limit: 2 }); expect(second.items.map(timer => timer.id)).toEqual(['c']); expect(second.next).toBeNull();
      expect((await timers.events()).filter(event => event.type === 'timer.scheduled')).toHaveLength(3);
    });

    it('separates identical stream and timer IDs by verified scope', async () => {
      const first = await initialized(); await first.schedule({ id: 'same', dueAtMs: 2_000 });
      const second = await initialized({ scope: { principalId: 'operator', projectId: 'other' } });
      expect(await second.inspect('same')).toBeUndefined(); await second.schedule({ id: 'same', dueAtMs: 3_000 });
      expect(await first.inspect('same')).toMatchObject({ dueAtMs: 2_000 }); expect(await second.inspect('same')).toMatchObject({ dueAtMs: 3_000 });
    });

    it('rejects invalid commands and clock values without transitions', async () => {
      const timers = await initialized();
      for (const input of [{ id: '../bad', dueAtMs: 1 }, { id: 'bad-time', dueAtMs: -1 }, { id: 'extra', dueAtMs: 1, extra: true }]) {
        await expect(timers.schedule(input as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      await expect(timers.sweepDue({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await timers.list()).items).toEqual([]);
      const broken = await initialized({ streamId: 'broken-clock', now: () => Number.NaN }); await broken.schedule({ id: 'valid', dueAtMs: 1 });
      await expect(broken.sweepDue()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(await broken.inspect('valid')).toMatchObject({ status: 'scheduled' });
    });

    it('bounds storage contention and safely reports uncertain writes', async () => {
      const timers = await initialized(); await timers.schedule({ id: 'busy', dueAtMs: 1_000 });
      const conflicting: AggregateStore = { ...store, update: async () => { throw new StorageError('CONFLICT', 'conflict'); } };
      const busy = await initialized({ store: conflicting });
      await expect(busy.sweepDue()).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await timers.inspect('busy')).toMatchObject({ status: 'scheduled' });
      let committed = false;
      const uncertain: AggregateStore = { ...store, update: async command => { const result = await store.update(command); committed = true; throw new Error('PRIVATE DATABASE ACK'); return result; } };
      const ambiguous = await initialized({ store: uncertain }); const error: unknown = await ambiguous.cancel('busy').catch(caught => caught);
      expect(committed).toBe(true); expect(JSON.stringify(error)).not.toContain('PRIVATE');
      expect(await timers.cancel('busy')).toMatchObject({ status: 'cancelled' });
    });

    it('rejects corrupted persisted timer state before disclosure', async () => {
      let saved: StoredRecord | undefined;
      const capturing: AggregateStore = { ...store,
        create: async command => { const result = await store.create(command); saved = result.record; return result; },
        update: async command => { const result = await store.update(command); saved = result; return result; },
      };
      const timers = await initialized({ store: capturing }); await timers.schedule({ id: 'private', dueAtMs: 2_000, payload: { secret: 'PRIVATE VALUE' } });
      if (!saved) throw new Error('fixture');
      const state = structuredClone(saved.state) as { timers: { status: string; firedAtMs?: number }[] };
      state.timers[0]!.status = 'fired'; state.timers[0]!.firedAtMs = 1_000;
      const forged = { ...saved, state }; const corrupt: AggregateStore = { ...store, create: async () => ({ record: forged, created: false }), read: async () => forged };
      const invalid = create({ store: corrupt, streamId: saved.id });
      const error: unknown = await invalid.initialize().catch(caught => caught);
      expect(error).toMatchObject({ code: 'INTEGRITY_VIOLATION' }); expect(JSON.stringify(error)).not.toContain('PRIVATE');
    });
  });
}
