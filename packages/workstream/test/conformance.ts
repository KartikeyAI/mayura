import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type JsonObject } from '@mayura/core';
import { StorageError, type AggregateStore, type CreateRecord, type StoredRecord } from '@mayura/storage';
import { createWorkStream, type SignalRecord, type WaitDefinition, type WorkStream, type WorkStreamOptions } from '../src/index.js';
import type { WorkStreamFixture } from './fixtures.js';

/** The same evidence must pass for each persistence adapter; no backend-specific weaker assertions. */
export function workstreamConformance(name: string, factory: () => Promise<WorkStreamFixture>): void {
  describe(`${name} WorkStream conformance`, () => {
    let fixture: WorkStreamFixture;
    let store: AggregateStore;
    const stream = (overrides: Partial<WorkStreamOptions> = {}): WorkStream => createWorkStream({
      store, scope: { principalId: 'developer-a', projectId: 'project-a' }, streamId: 'stream-a', ...overrides,
    });
    const initialized = async (overrides: Partial<WorkStreamOptions> = {}): Promise<WorkStream> => {
      const value = stream(overrides); await value.initialize(); return value;
    };
    const wait = (overrides: Partial<WaitDefinition> = {}): WaitDefinition => ({
      id: 'wait-a', mode: 'all', conditions: [{ id: 'ready', name: 'ready' }], ...overrides,
    });
    const wrappedStore = (overrides: Partial<AggregateStore>): AggregateStore => ({
      initialize: () => store.initialize(), create: command => store.create(command), read: (scope, id) => store.read(scope, id),
      update: command => store.update(command), events: (scope, id, after) => store.events(scope, id, after), close: () => store.close(), ...overrides,
    });
    const allSignals = async (value: WorkStream): Promise<SignalRecord[]> => {
      const result: SignalRecord[] = []; let after = 0;
      for (let page = 0; page < 20; page++) {
        const next = await value.signals({ after, limit: 16 });
        result.push(...next.items);
        if (next.items.length < 16) return result;
        expect(next.next).toBeGreaterThan(after); after = next.next;
      }
      throw new Error('Signal paging did not terminate within the retained signal bound.');
    };
    beforeEach(async () => { fixture = await factory(); store = fixture.store; await store.initialize(); });
    afterEach(async () => { vi.restoreAllMocks(); await store?.close(); await fixture?.cleanup(); });

    it('reopens initialization idempotently without resetting signals or waits', async () => {
      const first = stream(); const second = stream();
      await Promise.all([first.initialize(), second.initialize()]);
      await first.register(wait());
      const signal = await second.signal({ id: 'signal-a', name: 'ready', value: { value: 1 } });
      await Promise.all([first.initialize(), second.initialize()]);
      expect((await first.inspect('wait-a'))?.status).toBe('succeeded');
      expect((await second.signals()).items).toEqual([signal]);
    });

    it('returns waiting immediately, then resolves with a later signal', async () => {
      const value = await initialized();
      expect(await value.register(wait())).toMatchObject({ id: 'wait-a', status: 'waiting' });
      const signal = await value.signal({ id: 'signal-a', name: 'ready', value: { result: 7 } });
      expect(await value.inspect('wait-a')).toMatchObject({ status: 'succeeded', matches: [{ conditionId: 'ready', signal }] });
    });

    it('observes an event that arrived before registration without a lost-wakeup window', async () => {
      const value = await initialized();
      const signal = await value.signal({ id: 'before', name: 'ready', value: 'available' });
      expect(await value.register(wait())).toMatchObject({ status: 'succeeded', matches: [{ conditionId: 'ready', signal }] });
    });

    it('uses exclusive sequence cursors and the earliest qualifying signal', async () => {
      const value = await initialized();
      const excluded = await value.signal({ id: 'excluded', name: 'ready', value: 1 });
      await value.register(wait({ conditions: [{ id: 'ready', name: 'ready', after: excluded.sequence }] }));
      expect((await value.inspect('wait-a'))?.status).toBe('waiting');
      const included = await value.signal({ id: 'included', name: 'ready', value: 2 });
      await value.signal({ id: 'later', name: 'ready', value: 3 });
      expect((await value.inspect('wait-a'))?.matches).toEqual([{ conditionId: 'ready', signal: included }]);
    });

    it('matches all conditions in declared order, allowing a shared broadcast signal', async () => {
      const value = await initialized();
      const right = await value.signal({ id: 'right', name: 'right', value: 2 });
      await value.register(wait({ conditions: [{ id: 'left-a', name: 'left' }, { id: 'right', name: 'right' }, { id: 'left-b', name: 'left' }] }));
      expect((await value.inspect('wait-a'))?.status).toBe('waiting');
      const left = await value.signal({ id: 'left', name: 'left', value: 1 });
      expect((await value.inspect('wait-a'))?.matches).toEqual([
        { conditionId: 'left-a', signal: left }, { conditionId: 'right', signal: right }, { conditionId: 'left-b', signal: left },
      ]);
    });

    it('chooses any by lowest signal sequence, then by declared condition order', async () => {
      const value = await initialized();
      const earliest = await value.signal({ id: 'second-name-first', name: 'second', value: 1 });
      await value.signal({ id: 'first-name-later', name: 'first', value: 2 });
      expect(await value.register(wait({ mode: 'any', conditions: [{ id: 'first', name: 'first' }, { id: 'second', name: 'second' }] }))).toMatchObject({
        status: 'succeeded', matches: [{ conditionId: 'second', signal: earliest }],
      });
      expect(await value.register(wait({ id: 'tie', mode: 'any', conditions: [{ id: 'declared-first', name: 'second' }, { id: 'declared-second', name: 'second' }] }))).toMatchObject({
        status: 'succeeded', matches: [{ conditionId: 'declared-first', signal: earliest }],
      });
    });

    it('does not overwrite completed any/all results after further matching signals', async () => {
      const value = await initialized();
      await value.register(wait({ mode: 'any', conditions: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] }));
      await value.signal({ id: 'a1', name: 'a', value: 'first' });
      const completed = await value.inspect('wait-a');
      await value.signal({ id: 'b1', name: 'b', value: 'other branch' });
      await value.signal({ id: 'a2', name: 'a', value: 'later' });
      expect(await value.inspect('wait-a')).toEqual(completed);
      expect(await value.cancel('wait-a')).toEqual(completed);
    });

    it('V04 closes restart-safe deadlines, losing-branch disposal and cancellation/deadline races', async () => {
      let time = 1_000;
      const first = await initialized({ now: () => time });
      await first.register(wait({
        id: 'restart-deadline', mode: 'any', deadlineAtMs: 2_000,
        conditions: [{ id: 'winner', name: 'winner' }, { id: 'loser', name: 'loser' }],
      }));
      expect(await first.sweepDeadlines()).toEqual([]);

      await store.close(); store = fixture.reopen(); await store.initialize();
      time = 2_000;
      const reopened = await initialized({ now: () => time });
      expect(await reopened.sweepDeadlines()).toMatchObject([{ id: 'restart-deadline', status: 'timed_out' }]);
      expect(await reopened.sweepDeadlines()).toEqual([]);
      expect((await reopened.events()).filter(event => event.type === 'wait.subscriptions.disposed' && event.data['waitId'] === 'restart-deadline')).toEqual([
        expect.objectContaining({ data: { waitId: 'restart-deadline', reason: 'timed_out', count: 2 } }),
      ]);

      await reopened.register(wait({
        id: 'winner-disposes-loser', mode: 'any',
        conditions: [{ id: 'winner', name: 'winner' }, { id: 'loser', name: 'loser' }],
      }));
      await reopened.signal({ id: 'winner-signal', name: 'winner', value: 1 });
      const won = await reopened.inspect('winner-disposes-loser');
      await reopened.signal({ id: 'loser-signal', name: 'loser', value: 2 });
      expect(await reopened.inspect('winner-disposes-loser')).toEqual(won);
      expect((await reopened.events()).filter(event => event.type === 'wait.subscriptions.disposed' && event.data['waitId'] === 'winner-disposes-loser')).toEqual([
        expect.objectContaining({ data: { waitId: 'winner-disposes-loser', reason: 'succeeded', count: 1 } }),
      ]);

      await reopened.register(wait({ id: 'race', deadlineAtMs: time }));
      const otherStore = fixture.reopen();
      try {
        await otherStore.initialize();
        const other = await initialized({ store: otherStore, now: () => time });
        await Promise.all([reopened.cancel('race'), other.sweepDeadlines()]);
        const settled = await reopened.inspect('race');
        expect(['cancelled', 'timed_out']).toContain(settled?.status);
        expect(await other.cancel('race')).toEqual(settled);
        expect(await other.sweepDeadlines()).toEqual([]);
        const terminal = (await other.events()).filter(event => ['wait.cancelled', 'wait.timed_out'].includes(event.type) && event.data['waitId'] === 'race');
        expect(terminal).toHaveLength(1);
        expect((await other.events()).filter(event => event.type === 'wait.subscriptions.disposed' && event.data['waitId'] === 'race')).toHaveLength(1);
      } finally { await otherStore.close(); }
    });

    it('deduplicates identical signal retries and rejects conflicting content', async () => {
      const value = await initialized();
      const first = await value.signal({ id: 'signal-a', name: 'ready', value: { a: 1, b: 2 } });
      const events = await value.events();
      expect(await value.signal({ id: 'signal-a', name: 'ready', value: { b: 2, a: 1 } })).toEqual(first);
      for (const command of [{ id: 'signal-a', name: 'other', value: { a: 1, b: 2 } }, { id: 'signal-a', name: 'ready', value: { a: 2, b: 2 } }]) {
        await expect(value.signal(command)).rejects.toMatchObject({ code: 'CONFLICT' });
      }
      expect(await value.events()).toEqual(events);
      expect(await allSignals(value)).toEqual([first]);
    });

    it('deduplicates wait registration at its current state without changing its definition', async () => {
      const value = await initialized(); const definition = wait();
      await value.register(definition);
      await value.signal({ id: 'signal-a', name: 'ready', value: 1 });
      const completed = await value.inspect(definition.id); const events = await value.events();
      expect(await value.register(definition)).toEqual(completed);
      for (const other of [wait({ mode: 'any' }), wait({ conditions: [{ id: 'other', name: 'ready' }] }), wait({ conditions: [{ id: 'ready', name: 'ready', after: 1 }] })]) {
        await expect(value.register(other)).rejects.toMatchObject({ code: 'CONFLICT' });
      }
      expect(await value.events()).toEqual(events);
    });

    it('atomically deduplicates concurrent identical signals and registrations', async () => {
      const value = await initialized();
      const registered = await Promise.all(Array.from({ length: 8 }, () => value.register(wait())));
      expect(registered.every(snapshot => snapshot.status === 'waiting')).toBe(true);
      const records = await Promise.all(Array.from({ length: 8 }, () => value.signal({ id: 'same', name: 'ready', value: 1 })));
      expect(records.every(record => record.sequence === records[0]?.sequence)).toBe(true);
      expect(await allSignals(value)).toHaveLength(1);
      expect((await value.inspect('wait-a'))?.status).toBe('succeeded');
      const events = await value.events();
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    });

    it('resolves concurrent event/registration races across independent storage clients', async () => {
      const value = await initialized(); const otherStore = fixture.reopen();
      try {
        await otherStore.initialize(); const other = await initialized({ store: otherStore });
        const operations: Promise<unknown>[] = [];
        for (let index = 0; index < 8; index++) {
          operations.push(value.register(wait({ id: `wait-${index}`, conditions: [{ id: 'ready', name: `name-${index}` }] })));
          operations.push(other.signal({ id: `signal-${index}`, name: `name-${index}`, value: index }));
        }
        await Promise.all(operations);
        for (let index = 0; index < 8; index++) expect(await other.inspect(`wait-${index}`)).toMatchObject({ status: 'succeeded', matches: [{ conditionId: 'ready', signal: { id: `signal-${index}`, value: index } }] });
        const signals = await allSignals(value);
        expect(signals.map(signal => signal.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      } finally { await otherStore.close(); }
    });

    it('settles cancellation/completion races once and preserves the winning terminal state', async () => {
      const value = await initialized(); const otherStore = fixture.reopen();
      try {
        await otherStore.initialize(); const other = await initialized({ store: otherStore });
        await value.register(wait());
        await Promise.all([value.cancel('wait-a'), other.signal({ id: 'signal-a', name: 'ready', value: 1 })]);
        const settled = await value.inspect('wait-a');
        expect(['cancelled', 'succeeded']).toContain(settled?.status);
        expect(await other.cancel('wait-a')).toEqual(settled);
        await value.signal({ id: 'signal-b', name: 'ready', value: 2 });
        expect(await other.inspect('wait-a')).toEqual(settled);
      } finally { await otherStore.close(); }
    });

    it('persists waits, cursor exclusions, signals and metadata events across adapter restart', async () => {
      const original = await initialized();
      const first = await original.signal({ id: 'first', name: 'ready', value: 1 });
      await original.register(wait({ conditions: [{ id: 'ready', name: 'ready', after: first.sequence }] }));
      const events = await original.events();
      await store.close(); store = fixture.reopen(); await store.initialize();
      const reopened = await initialized();
      expect((await reopened.inspect('wait-a'))?.status).toBe('waiting');
      expect(await reopened.events()).toEqual(events);
      const next = await reopened.signal({ id: 'second', name: 'ready', value: 2 });
      expect(next.sequence).toBe(first.sequence + 1);
      expect((await reopened.inspect('wait-a'))?.matches).toEqual([{ conditionId: 'ready', signal: next }]);
    });

    it('isolates principal, project and stream identities, ignoring scope-like payload fields', async () => {
      const first = await initialized();
      const others = await Promise.all([
        initialized({ scope: { principalId: 'developer-b', projectId: 'project-a' } }),
        initialized({ scope: { principalId: 'developer-a', projectId: 'project-b' } }), initialized({ streamId: 'stream-b' }),
      ]);
      await first.register(wait());
      await first.signal({ id: 'private', name: 'ready', value: { principalId: 'developer-b', projectId: 'project-b', secret: 'scope-a-only' } });
      for (const other of others) {
        expect(await other.inspect('wait-a')).toBeUndefined();
        expect((await other.signals()).items).toEqual([]);
        expect((await other.register(wait())).status).toBe('waiting');
        expect(JSON.stringify(await other.events())).not.toContain('scope-a-only');
      }
    });

    it('keeps inspect, signal pages and events read-only and omits raw values from audit events', async () => {
      let writes = 0;
      const observedStore = wrappedStore({ create: async command => { writes++; return store.create(command); }, update: async command => { writes++; return store.update(command); } });
      const value = await initialized({ store: observedStore });
      await value.register(wait()); await value.signal({ id: 'signal-a', name: 'ready', value: { nested: 'PRIVATE-SIGNAL-PAYLOAD' } });
      const before = writes;
      await value.inspect('wait-a'); await value.inspect('absent'); await value.signals();
      const events = await value.events();
      expect(writes).toBe(before);
      expect(JSON.stringify(events)).not.toContain('PRIVATE-SIGNAL-PAYLOAD');
      expect(await value.events(events.at(-1)?.sequence ?? 0)).toEqual([]);
      expect(writes).toBe(before);
    });

    it('returns immutable snapshots and snapshots caller-owned commands before asynchronous writes', async () => {
      const value = await initialized();
      const supplied = { nested: { value: 1 } };
      const pending = value.signal({ id: 'signal-a', name: 'ready', value: supplied });
      supplied.nested.value = 999;
      const signal = await pending;
      expect(signal.value).toEqual({ nested: { value: 1 } });
      expect(Object.isFrozen(signal)).toBe(true); expect(Object.isFrozen(signal.value)).toBe(true);
      const snapshot = await value.register(wait());
      expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.matches)).toBe(true);
      expect(Object.isFrozen(snapshot.conditions)).toBe(true);
      expect(Object.isFrozen(snapshot.matches[0]?.signal)).toBe(true);
      expect(() => { (signal.value as JsonObject)['changed'] = true; }).toThrow();
      expect((await value.inspect('wait-a'))?.matches[0]?.signal.value).toEqual({ nested: { value: 1 } });
    });

    it('paginates signals with exclusive monotonic cursors and no silent truncation', async () => {
      const value = await initialized();
      for (let index = 1; index <= 5; index++) await value.signal({ id: `signal-${index}`, name: 'ready', value: index });
      const first = await value.signals({ limit: 2 });
      expect(first.items.map(signal => signal.sequence)).toEqual([1, 2]); expect(first.next).toBe(2);
      const second = await value.signals({ after: first.next, limit: 2 });
      expect(second.items.map(signal => signal.sequence)).toEqual([3, 4]); expect(second.next).toBe(4);
      const last = await value.signals({ after: second.next, limit: 2 });
      expect(last.items.map(signal => signal.sequence)).toEqual([5]); expect(last.next).toBe(5);
      expect(await value.signals({ after: last.next, limit: 2 })).toEqual({ items: [], next: 5 });
    });

    it('rejects invalid definitions, commands, and cursors before changing durable state', async () => {
      const value = await initialized(); const before = await value.events();
      const invalidWaits: WaitDefinition[] = [
        wait({ id: '' }), wait({ conditions: [] }), wait({ conditions: [{ id: 'a', name: 'ready' }, { id: 'a', name: 'other' }] }),
        wait({ conditions: [{ id: 'a', name: '', after: 0 }] }), wait({ conditions: [{ id: 'a', name: 'ready', after: -1 }] }),
        wait({ conditions: [{ id: 'a', name: 'ready', after: 0.5 }] }),
        wait({ conditions: [{ id: 'a', name: 'ready', after: null as unknown as number }] }),
        wait({ deadlineAtMs: -1 }), wait({ deadlineAtMs: 0.5 }), wait({ deadlineAtMs: null as unknown as number }),
        wait({ conditions: Array.from({ length: 33 }, (_, index) => ({ id: `c-${index}`, name: 'ready' })) }),
      ];
      for (const definition of invalidWaits) await expect(value.register(definition)).rejects.toThrow();
      for (const command of [{ id: '', name: 'ready', value: 1 }, { id: 'signal', name: '', value: 1 }, { id: 'signal', name: 'ready', value: 'x'.repeat(4097) }]) await expect(value.signal(command)).rejects.toThrow();
      for (const query of [{ after: -1 }, { after: 0.5 }, { after: null as unknown as number }, { limit: 0 }, { limit: 1.5 }, { limit: null as unknown as number }]) await expect(value.signals(query)).rejects.toThrow();
      for (const query of [{ limit: 0 }, { limit: 129 }, { limit: 1.5 }, { unknown: true }]) await expect(value.sweepDeadlines(query as { limit?: number })).rejects.toThrow();
      await expect(value.events(-1)).rejects.toThrow();
      await expect(value.cancel('missing')).rejects.toThrow();
      expect(await value.events()).toEqual(before);
      expect(await allSignals(value)).toEqual([]);
    });

    it('enforces 256 retained signals without evicting old values or rejecting identical retries', async () => {
      const value = await initialized();
      for (let index = 0; index < 256; index++) await value.signal({ id: `signal-${index}`, name: 'ready', value: index });
      const before = await value.events();
      await expect(value.signal({ id: 'overflow', name: 'ready', value: 256 })).rejects.toThrow();
      expect(await value.signal({ id: 'signal-0', name: 'ready', value: 0 })).toMatchObject({ sequence: 1, value: 0 });
      expect(await allSignals(value)).toHaveLength(256);
      expect(await value.events()).toEqual(before);
    // This correctness fixture intentionally commits/fsyncs all 256 public transitions.
    // Allow shared CI disk contention; this is not a throughput qualification benchmark.
    }, 30_000);

    it('enforces 128 retained waits, preserving completed and cancelled definitions', async () => {
      const value = await initialized();
      for (let index = 0; index < 128; index++) await value.register(wait({ id: `wait-${index}` }));
      await value.cancel('wait-0'); await value.signal({ id: 'complete', name: 'ready', value: 1 });
      const before = await value.events();
      await expect(value.register(wait({ id: 'overflow' }))).rejects.toThrow();
      expect((await value.register(wait({ id: 'wait-0' }))).status).toBe('cancelled');
      expect((await value.register(wait({ id: 'wait-1' }))).status).toBe('succeeded');
      expect(await value.events()).toEqual(before);
    });

    it('enforces the aggregate byte cap before the signal-count cap with large valid values', async () => {
      // Seed the bounded wire fixture once instead of repeatedly fsyncing/copying ~1 MiB 250 times.
      // The separate retention test exercises all 256 public insertion transitions.
      let record: StoredRecord | undefined;
      const observedStore = wrappedStore({ create: async command => { const result = await store.create(command); record = result.record; return result; } });
      const value = await initialized({ store: observedStore });
      if (!record) throw new Error('Fixture did not capture its initialized aggregate.');
      const text = 'x'.repeat(4090);
      const signals: JsonObject[] = [];
      for (let index = 0; index < 256; index++) {
        signals.push({ id: `signal-${index}`, name: 'ready', value: text, sequence: index + 1 });
        if (Buffer.byteLength(JSON.stringify({ ...record.state, signals })) > 1_048_576) { signals.pop(); break; }
      }
      expect(signals.length).toBeGreaterThan(0); expect(signals.length).toBeLessThan(256);
      await store.update({ scope: record.scope, id: record.id, expectedVersion: record.version, state: { ...record.state, signals }, events: [] });
      expect(await allSignals(value)).toHaveLength(signals.length);
      const before = await value.events();
      await expect(value.signal({ id: 'overflow-extra-long-id', name: 'ready', value: text })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await value.events()).toEqual(before);
      expect(await allSignals(value)).toHaveLength(signals.length);
    });

    it('bounds repeated CAS conflicts without persisting a losing event or signal', async () => {
      let attempts = 0;
      const conflicting = wrappedStore({ update: async () => { attempts++; throw new StorageError('CONFLICT', 'PRIVATE DRIVER DETAILS'); } });
      const value = await initialized({ store: conflicting });
      const before = await value.events();
      const error: unknown = await value.signal({ id: 'signal-a', name: 'ready', value: 1 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error); expect(attempts).toBeGreaterThan(0); expect(attempts).toBeLessThanOrEqual(32);
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
      expect(await allSignals(value)).toEqual([]); expect(await value.events()).toEqual(before);
    });

    it('recovers an uncertain committed response through the same stable command identity', async () => {
      let loseOnce = true;
      const uncertain = wrappedStore({ update: async command => {
        const result = await store.update(command);
        if (loseOnce) { loseOnce = false; throw new StorageError('STORAGE_UNAVAILABLE', 'PRIVATE CONNECTION FAILURE'); }
        return result;
      } });
      const value = await initialized({ store: uncertain });
      await expect(value.signal({ id: 'stable', name: 'ready', value: 1 })).rejects.toThrow();
      expect(await value.signal({ id: 'stable', name: 'ready', value: 1 })).toMatchObject({ sequence: 1 });
      expect(await allSignals(value)).toHaveLength(1);
    });

    it('fails closed on unsupported stored formats without leaking content or writing repairs', async () => {
      let saved: StoredRecord | undefined;
      const capturing = wrappedStore({ create: async (command: CreateRecord) => { const created = await store.create(command); saved = created.record; return created; } });
      await initialized({ store: capturing });
      if (!saved) throw new Error('Fixture did not capture initialized state.');
      const changed: StoredRecord = { ...saved, state: { format: 'unsupported-future-format', secret: 'PRIVATE CORRUPT STATE' } };
      const update = vi.fn<AggregateStore['update']>(command => store.update(command));
      const invalidStore = wrappedStore({ read: async () => changed, create: async () => ({ record: changed, created: false }), update });
      const corrupted = stream({ store: invalidStore });
      const error: unknown = await (async () => { await corrupted.initialize(); return corrupted.inspect('missing'); })().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects forged match state, unknown persisted fields and misrouted record identities', async () => {
      let saved: StoredRecord | undefined;
      const capturing = wrappedStore({
        create: async command => { const result = await store.create(command); saved = result.record; return result; },
        update: async command => { const result = await store.update(command); saved = result; return result; },
      });
      const value = await initialized({ store: capturing });
      await value.register(wait()); await value.signal({ id: 'signal-a', name: 'other', value: 1 });
      if (!saved) throw new Error('Fixture did not capture its persisted aggregate.');
      const invalidRecords: StoredRecord[] = [
        { ...saved, scope: 'wrong-principal-scope' },
        { ...saved, id: 'wrong-stream' },
        { ...saved, state: { ...saved.state, unrecognized: 'PRIVATE UNKNOWN FIELD' } },
      ];
      const corruptions: ((state: JsonObject) => void)[] = [
        state => { (state['signals'] as JsonObject[])[0]!['sequence'] = 999; },
        state => { (state['signals'] as JsonObject[]).push({ id: 'signal-a', name: 'other', value: 2, sequence: 2 }); },
        state => { (state['waits'] as JsonObject[])[0]!['status'] = 'succeeded'; },
        state => { (state['waits'] as JsonObject[])[0]!['status'] = ['waiting']; },
        state => { (state['waits'] as JsonObject[])[0]!['status'] = ['cancelled']; },
        state => { (state['signals'] as JsonObject[])[0]!['name'] = 'ready'; },
        state => {
          (state['signals'] as JsonObject[])[0]!['name'] = 'ready';
          const completed = (state['waits'] as JsonObject[])[0]!;
          completed['status'] = 'succeeded';
          completed['matches'] = [{ conditionId: 'ready', signal: { id: 'signal-a', name: 'ready', value: 'PRIVATE FORGED MATCH', sequence: 1 } }];
        },
      ];
      for (const corrupt of corruptions) {
        const state = structuredClone(saved.state); corrupt(state); invalidRecords.push({ ...saved, state });
      }
      const update = vi.fn<AggregateStore['update']>(command => store.update(command));
      for (const record of invalidRecords) {
        const invalidStore = wrappedStore({ read: async () => record, create: async () => ({ record, created: false }), update });
        const invalid = stream({ store: invalidStore });
        const error: unknown = await invalid.initialize().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error)).not.toContain('PRIVATE');
      }
      expect(update).not.toHaveBeenCalled();
    });

    it('does not expose raw storage failures through command errors', async () => {
      for (const failure of [new Error('PRIVATE DATABASE PASSWORD'), new MayuraError('CONFLICT', 'PRIVATE FRAMEWORK-SHAPED ERROR')]) {
        const failedStore = wrappedStore({ read: async () => { throw failure; } });
        const value = stream({ store: failedStore });
        const error: unknown = await (async () => { await value.initialize(); return value.inspect('wait-a'); })().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(JSON.stringify(error)).not.toContain('PRIVATE');
        if (error instanceof Error) expect(error.message).not.toContain('PRIVATE');
      }
    });
  });
}
