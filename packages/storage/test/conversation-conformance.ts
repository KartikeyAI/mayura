import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageError, type ConversationAggregateStore, type RunCheckpointStore, type ThreadStore } from '@mayura/storage-contracts';

export interface ConversationFixture { readonly store: ConversationAggregateStore; close(): Promise<void> }

const scope = 'principal/acme';
const other = 'principal/globex';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; return undefined; } catch (error) { return error instanceof StorageError ? error.storageCode : `not a StorageError: ${String(error)}`; }
}

/** The thread and run-checkpoint contract, run against every store. */
export function conversationConformance(name: string, factory: () => Promise<ConversationFixture>): void {
  describe(`${name} threads and run checkpoints`, () => {
    let fixture: ConversationFixture; let threads: ThreadStore; let checkpoints: RunCheckpointStore;
    const create = (id: string, at = scope) => threads.create({ scope: at, id, agentId: 'support', title: `Thread ${id}`, metadata: { topic: id } });
    const hold = (id: string, runId = 'run-1', holderId = 'replica-a', leaseMs = 30_000) => threads.acquire({ scope, id, runId, holderId, leaseMs });
    const append = (id: string, expectedSequence: number, texts: string[], runId = 'run-1', holderId = 'replica-a') => threads.append({
      scope, id, runId, holderId, expectedSequence, entries: texts.map(text => ({ kind: 'user' as const, data: { text } })),
    });

    beforeEach(async () => {
      fixture = await factory(); await fixture.store.initialize();
      threads = fixture.store.threads; checkpoints = fixture.store.runCheckpoints;
      await threads.initialize(); await checkpoints.initialize();
    });
    afterEach(async () => { await fixture.close(); });

    it('refuses use before its own initialization', async () => {
      const fresh = await factory();
      try {
        await fresh.store.initialize();
        expect(await code(fresh.store.threads.get({ scope, id: 'x' }))).toBe('STORE_NOT_INITIALIZED');
      } finally { await fresh.close(); }
    });

    it('creates a thread once and reads it back', async () => {
      const first = await create('t1');
      expect(first.created).toBe(true);
      expect(first.thread).toMatchObject({ scope, id: 't1', version: 1, status: 'active', agentId: 'support', title: 'Thread t1', metadata: { topic: 't1' },
        entryCount: 0, lastSequence: 0, lease: null });
      const again = await threads.create({ scope, id: 't1', agentId: null, title: null, metadata: {} });
      expect(again.created).toBe(false);
      expect(again.thread.title).toBe('Thread t1');
      expect(await threads.get({ scope, id: 't1' })).toEqual(first.thread);
      expect(await threads.get({ scope: other, id: 't1' })).toBeUndefined();
    });

    it('lists a scope newest first, page by page, with a status filter', async () => {
      for (const id of ['a', 'b', 'c', 'd']) { await create(id); await pause(3); }
      await create('elsewhere', other);
      const archived = (await threads.get({ scope, id: 'b' }))!;
      await threads.update({ scope, id: 'b', expectedVersion: archived.version, status: 'archived' });
      const first = await threads.list({ scope, statuses: ['active', 'archived'], limit: 2 });
      expect(first.threads.map(thread => thread.id)).toEqual(['b', 'd']);
      expect(first.cursor).not.toBeNull();
      const second = await threads.list({ scope, statuses: ['active', 'archived'], limit: 2, before: first.cursor! });
      expect(second.threads.map(thread => thread.id)).toEqual(['c', 'a']);
      const rest = await threads.list({ scope, statuses: ['active', 'archived'], limit: 2, before: second.cursor! });
      expect(rest).toEqual({ threads: [], cursor: null });
      expect((await threads.list({ scope, statuses: ['active'], limit: 10 })).threads.map(thread => thread.id)).toEqual(['d', 'c', 'a']);
      expect((await threads.list({ scope: other, statuses: ['active'], limit: 10 })).threads.map(thread => thread.id)).toEqual(['elsewhere']);
    });

    it('updates title, metadata and status only at the version read', async () => {
      const { thread } = await create('t1');
      const renamed = await threads.update({ scope, id: 't1', expectedVersion: 1, title: 'Billing question', metadata: { tag: 'billing' } });
      expect(renamed).toMatchObject({ version: 2, title: 'Billing question', metadata: { tag: 'billing' } });
      expect(renamed.updatedAtMs).toBeGreaterThanOrEqual(thread.updatedAtMs);
      expect(await code(threads.update({ scope, id: 't1', expectedVersion: 1, title: 'Stale' }))).toBe('CONFLICT');
      expect((await threads.update({ scope, id: 't1', expectedVersion: 2, status: 'archived' })).status).toBe('archived');
      expect(await code(threads.update({ scope, id: 'missing', expectedVersion: 1, title: 'x' }))).toBe('NOT_FOUND');
    });

    it('lets one run hold a thread at a time', async () => {
      await create('t1');
      expect((await hold('t1')).lease).toMatchObject({ runId: 'run-1', holderId: 'replica-a' });
      expect(await code(hold('t1', 'run-2', 'replica-b'))).toBe('CONFLICT');
      expect((await threads.renew({ scope, id: 't1', runId: 'run-1', holderId: 'replica-a', leaseMs: 60_000 })).lease?.runId).toBe('run-1');
      expect(await code(threads.renew({ scope, id: 't1', runId: 'run-2', holderId: 'replica-b', leaseMs: 60_000 }))).toBe('CONFLICT');
      expect((await threads.release({ scope, id: 't1', runId: 'run-1', holderId: 'replica-a' })).lease).toBeNull();
      expect((await hold('t1', 'run-2', 'replica-b')).lease?.runId).toBe('run-2');
    });

    it('lets another run take a thread whose lease expired', async () => {
      await create('t1'); await hold('t1', 'run-1', 'replica-a', 1_000);
      await pause(1_200);
      expect((await hold('t1', 'run-2', 'replica-b')).lease).toMatchObject({ runId: 'run-2', holderId: 'replica-b' });
      expect(await code(append('t1', 0, ['late']))).toBe('CONFLICT');
    });

    it('appends entries in order, only for the holder at the sequence it saw', async () => {
      await create('t1');
      expect(await code(append('t1', 0, ['no lease']))).toBe('CONFLICT');
      await hold('t1');
      const first = await append('t1', 0, ['one', 'two']);
      expect(first.entries.map(entry => [entry.sequence, entry.runId, entry.kind, entry.data])).toEqual([[1, 'run-1', 'user', { text: 'one' }], [2, 'run-1', 'user', { text: 'two' }]]);
      expect(first.thread).toMatchObject({ entryCount: 2, lastSequence: 2 });
      expect(await code(append('t1', 1, ['stale']))).toBe('CONFLICT');
      expect(await code(append('t1', 2, ['wrong holder'], 'run-1', 'replica-b'))).toBe('CONFLICT');
      await threads.append({ scope, id: 't1', runId: 'run-1', holderId: 'replica-a', expectedSequence: 2, entries: [
        { kind: 'tool_calls', data: { calls: [{ id: 'c1', toolId: 'orders.get', input: { id: 7 } }] } },
        { kind: 'tool_result', data: { callId: 'c1', toolId: 'orders.get', result: { total: 42 } } },
        { kind: 'assistant', data: { output: { reply: 'Your order is 42.' } } },
      ] });
      const all = await threads.entries({ scope, id: 't1', limit: 500 });
      expect(all.map(entry => entry.kind)).toEqual(['user', 'user', 'tool_calls', 'tool_result', 'assistant']);
      expect((await threads.entries({ scope, id: 't1', after: 3, limit: 500 })).map(entry => entry.sequence)).toEqual([4, 5]);
      expect((await threads.entries({ scope, id: 't1', before: 5, limit: 2 })).map(entry => entry.sequence)).toEqual([3, 4]);
      expect(await threads.entries({ scope: other, id: 't1', limit: 10 }).catch(error => (error as StorageError).storageCode)).toBe('NOT_FOUND');
    });

    it('lets only one of two concurrent appends at one sequence through', async () => {
      await create('t1'); await hold('t1');
      const results = await Promise.allSettled([append('t1', 0, ['left']), append('t1', 0, ['right'])]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect((failed.reason as StorageError).storageCode).toBe('CONFLICT');
      expect((await threads.get({ scope, id: 't1' }))?.lastSequence).toBe(1);
    });

    it('refuses appends over its bounds', async () => {
      await create('t1'); await hold('t1');
      expect(await code(append('t1', 0, Array.from({ length: 65 }, (_, index) => `${index}`)))).toBe('INVALID_INPUT');
      expect(await code(append('t1', 0, ['x'.repeat(300_000)]))).toBe('LIMIT_EXCEEDED');
      expect(await code(threads.append({ scope, id: 't1', runId: 'run-1', holderId: 'replica-a', expectedSequence: 0,
        entries: [{ kind: 'secret' as never, data: {} }] }))).toBe('INVALID_INPUT');
    });

    it('deletes a thread at once for readers and drains its entries in pages', async () => {
      await create('t1'); await hold('t1');
      for (let sequence = 0; sequence < 150; sequence += 50) await append('t1', sequence, Array.from({ length: 50 }, (_, index) => `${sequence + index}`));
      const first = await threads.delete({ scope, id: 't1', limit: 100 });
      expect(first.thread).toMatchObject({ status: 'deleting', agentId: null, title: null, metadata: {}, lease: null });
      expect(first.removed).toBeGreaterThan(0);
      expect(await threads.entries({ scope, id: 't1', limit: 500 })).toEqual([]);
      expect((await threads.list({ scope, statuses: ['active', 'archived'], limit: 10 })).threads).toEqual([]);
      expect(await code(append('t1', 150, ['after delete']))).toBe('NOT_FOUND');
      let result = first; let calls = 1;
      while (result.thread.status !== 'deleted') { result = await threads.delete({ scope, id: 't1', limit: 100 }); calls++; expect(calls).toBeLessThan(10); }
      expect(result.thread.entryCount).toBe(0);
      expect((await threads.delete({ scope, id: 't1', limit: 100 })).removed).toBe(0);
      expect(await code(create('t1'))).toBe('CONFLICT');
      expect((await threads.get({ scope, id: 't1' }))?.status).toBe('deleted');
    });

    it('expires threads idle since a time, in any scope', async () => {
      const old = (await create('old')).thread; const elsewhere = (await create('old-other', other)).thread;
      await pause(20);
      const fresh = (await create('fresh')).thread;
      const cutoff = Math.max(old.updatedAtMs, elsewhere.updatedAtMs) + 1;
      expect(fresh.updatedAtMs).toBeGreaterThanOrEqual(cutoff);
      const expired = await threads.expire({ idleBeforeMs: cutoff, limit: 100 });
      expect(expired.map(item => `${item.scope}:${item.id}`).sort()).toEqual([`${scope}:old`, `${other}:old-other`].sort());
      expect((await threads.get({ scope, id: 'old' }))?.status).toBe('deleted');
      expect((await threads.get({ scope, id: 'fresh' }))?.status).toBe('active');
      expect(await threads.expire({ idleBeforeMs: cutoff, limit: 100 })).toEqual([]);
    });

    it('keeps a checkpoint body exactly, across parts and characters outside the BMP', async () => {
      const body = { messages: Array.from({ length: 400 }, (_, index) => ({ role: 'user', content: `${'é😀'.repeat(400)} ${index}` })), continuation: { opaque: 'x'.repeat(5_000) } };
      const put = await checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body });
      expect(put).toMatchObject({ runId: 'run-1', scope, version: 1, status: 'waiting', holderId: null, leaseExpiresAtMs: null });
      expect((await checkpoints.get({ runId: 'run-1' }))?.body).toEqual(body);
      expect(await code(checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body: {} }))).toBe('CONFLICT');
      expect(await code(checkpoints.put({ runId: 'run-2', scope, expiresAtMs: Date.now() + 60_000, body: { big: 'y'.repeat(3_200_000) } }))).toBe('LIMIT_EXCEEDED');
      expect(await checkpoints.get({ runId: 'missing' })).toBeUndefined();
    });

    it('lets one holder claim a checkpoint, record progress, and let go', async () => {
      await checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body: { phase: 'waiting' } });
      const claimed = await checkpoints.claim({ runId: 'run-1', holderId: 'replica-a', leaseMs: 30_000 });
      expect(claimed).toMatchObject({ status: 'claimed', holderId: 'replica-a', version: 2 });
      expect(await code(checkpoints.claim({ runId: 'run-1', holderId: 'replica-b', leaseMs: 30_000 }))).toBe('CONFLICT');
      expect(await code(checkpoints.update({ runId: 'run-1', holderId: 'replica-b', expectedVersion: 2, body: {}, status: 'claimed' }))).toBe('STALE_CLAIM');
      expect(await code(checkpoints.update({ runId: 'run-1', holderId: 'replica-a', expectedVersion: 1, body: {}, status: 'claimed' }))).toBe('CONFLICT');
      const started = await checkpoints.update({ runId: 'run-1', holderId: 'replica-a', expectedVersion: 2, body: { phase: 'dispatching' }, status: 'claimed' });
      expect(started).toMatchObject({ version: 3, status: 'claimed', body: { phase: 'dispatching' } });
      const released = await checkpoints.update({ runId: 'run-1', holderId: 'replica-a', expectedVersion: 3, body: { phase: 'waiting' }, status: 'waiting' });
      expect(released).toMatchObject({ version: 4, status: 'waiting', holderId: null, leaseExpiresAtMs: null });
      expect(await code(checkpoints.delete({ runId: 'run-1', holderId: 'replica-b' }))).toBeUndefined();
      expect(await checkpoints.delete({ runId: 'run-1' })).toBe(false);
    });

    it('refuses a deletion by another holder while a claim is live', async () => {
      await checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body: {} });
      await checkpoints.claim({ runId: 'run-1', holderId: 'replica-a', leaseMs: 30_000 });
      expect(await code(checkpoints.delete({ runId: 'run-1', holderId: 'replica-b' }))).toBe('CONFLICT');
      expect(await checkpoints.delete({ runId: 'run-1', holderId: 'replica-a' })).toBe(true);
      expect(await checkpoints.get({ runId: 'run-1' })).toBeUndefined();
    });

    it('lets a new holder take a checkpoint whose claim expired', async () => {
      await checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body: {} });
      await checkpoints.claim({ runId: 'run-1', holderId: 'replica-a', leaseMs: 1_000 });
      await pause(1_200);
      expect(await code(checkpoints.update({ runId: 'run-1', holderId: 'replica-a', expectedVersion: 2, body: {}, status: 'claimed' }))).toBe('STALE_CLAIM');
      expect((await checkpoints.claim({ runId: 'run-1', holderId: 'replica-b', leaseMs: 30_000 })).holderId).toBe('replica-b');
    });

    it('lists waiting checkpoints past their expiry, earliest first', async () => {
      const now = Date.now();
      await checkpoints.put({ runId: 'late', scope, expiresAtMs: now - 1_000, body: {} });
      await checkpoints.put({ runId: 'later', scope, expiresAtMs: now - 500, body: {} });
      await checkpoints.put({ runId: 'claimed', scope, expiresAtMs: now - 2_000, body: {} });
      await checkpoints.put({ runId: 'future', scope, expiresAtMs: now + 60_000, body: {} });
      await checkpoints.claim({ runId: 'claimed', holderId: 'replica-a', leaseMs: 30_000 });
      expect(await checkpoints.due({ expiresBeforeMs: now, limit: 10 })).toEqual(['late', 'later']);
      expect(await checkpoints.due({ expiresBeforeMs: now, limit: 1 })).toEqual(['late']);
    });
  });
}
