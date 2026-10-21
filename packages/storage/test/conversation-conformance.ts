import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@mayura/core/host';
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

    it('journals only associated runs, refuses conflicting completions, and deletes their retained content', async () => {
      await create('recording'); await hold('recording');
      const command = { scope, id: 'recording', runtimeRunId: 'runtime-run', action: 'save' as const,
        turnId: 'run-1', startSequence: 0, body: { output: 'private completion' } };
      expect(await code(threads.recording(command))).toBe('CONFLICT');
      await threads.append({ scope, id: 'recording', runId: 'run-1', holderId: 'replica-a', expectedSequence: 0,
        entries: [{ kind: 'run', data: { runId: 'runtime-run', status: 'running', recording: true } }] });
      expect(await threads.recording(command)).toEqual(command.body);
      expect(await threads.recording(command)).toEqual(command.body);
      expect(await code(threads.recording({ ...command, body: { output: 'changed' } }))).toBe('CONFLICT');
      expect(await code(threads.recording({ ...command, scope: other }))).toBe('NOT_FOUND');
      expect(await threads.recording({ scope, id: 'recording', runtimeRunId: 'runtime-run', action: 'read' })).toEqual(command.body);
      await threads.delete({ scope, id: 'recording', limit: 32 });
      expect(await checkpoints.get({ runId: `thread-record:${sha256Hex('runtime-run')}` })).toBeUndefined();
      expect(await code(threads.recording({ scope, id: 'recording', runtimeRunId: 'runtime-run', action: 'read' }))).toBe('NOT_FOUND');
    });

    it('fences only the exact expired claim, retaining evidence and rejecting stale holders and changed retries', async () => {
      const body = { privateContinuation: 'retained evidence' };
      await checkpoints.put({ runId: 'claimed-run', scope, expiresAtMs: 100, body });
      const claimed = await checkpoints.claim({ runId: 'claimed-run', holderId: 'old-worker', leaseMs: 1000 });
      const command = { runId: claimed.runId, scope, expectedVersion: claimed.version, expectedHolderId: 'old-worker',
        commandId: 'investigation-1', actorId: 'operator', reviewDigest: 'a'.repeat(64), effect: 'unknown' as const,
        evidenceRef: 'incident/123', workerStopped: true as const };
      expect(await code(checkpoints.reconcile(command))).toBe('CONFLICT');
      expect(await code(checkpoints.reconcile({ ...command, scope: other }))).toBe('NOT_FOUND');
      await pause(1050);
      expect(await code(checkpoints.reconcile({ ...command, expectedVersion: 1 }))).toBe('CONFLICT');
      const sealed = await checkpoints.reconcile(command);
      expect(sealed.body).toMatchObject({ ...body, reconciliation: { format: 1, commandId: 'investigation-1', actorId: 'operator', effect: 'unknown', evidenceRef: 'incident/123' } });
      expect(sealed.holderId).not.toBe('old-worker'); expect(sealed.version).toBe(claimed.version + 1);
      expect(await checkpoints.reconcile(command)).toEqual(sealed);
      expect(await code(checkpoints.reconcile({ ...command, effect: 'succeeded' }))).toBe('CONFLICT');
      expect(await code(checkpoints.claim({ runId: claimed.runId, holderId: 'new-worker', leaseMs: 1000 }))).toBe('CONFLICT');
      expect(await code(checkpoints.update({ runId: claimed.runId, holderId: sealed.holderId!, expectedVersion: sealed.version, body: {}, status: 'waiting' }))).toBe('CONFLICT');
      expect(await code(checkpoints.delete({ runId: claimed.runId, holderId: 'old-worker' }))).toBe('CONFLICT');
      expect((await checkpoints.get({ runId: claimed.runId }))!.body).toEqual(sealed.body);
    });

    it('scans metadata across scopes and claimed rows with stable bounded cursors', async () => {
      for (const [runId, expiresAtMs] of [['z', 200], ['A', 100], ['a', 100], ['b', 100]] as const)
        await checkpoints.put({ runId, scope: runId === 'a' ? other : scope, expiresAtMs, body: { secret: 'not in scan' } });
      await checkpoints.claim({ runId: 'A', holderId: 'worker', leaseMs: 30_000 });
      expect(await checkpoints.scan({ limit: 2 })).toEqual([{ runId: 'A', expiresAtMs: 100 }, { runId: 'a', expiresAtMs: 100 }]);
      const after = { runId: 'a', expiresAtMs: 100 };
      expect(await checkpoints.scan({ after, limit: 2 })).toEqual([{ runId: 'b', expiresAtMs: 100 }, { runId: 'z', expiresAtMs: 200 }]);
      expect(await checkpoints.scan({ after: { runId: 'z', expiresAtMs: 200 }, limit: 2 })).toEqual([]);
      expect(await code(checkpoints.scan({ limit: 101 }))).toBe('INVALID_INPUT');
      expect(await checkpoints.due({ expiresBeforeMs: 300, limit: 1 })).toEqual(['a']);
    });

    it('reserves compaction once, stages its summary and publishes atomically without removing source entries', async () => {
      await create('compact'); await hold('compact');
      const source = [{ kind: 'user' as const, data: { content: 'Question' } }, { kind: 'assistant' as const, data: { output: 'Answer' } },
        { kind: 'run' as const, data: { runId: 'original', status: 'succeeded' } }];
      await threads.append({ scope, id: 'compact', runId: 'run-1', holderId: 'replica-a', expectedSequence: 0, entries: source });
      await threads.release({ scope, id: 'compact', runId: 'run-1', holderId: 'replica-a' });
      const reserve = { scope, id: 'compact', commandId: 'compact-1', action: 'reserve' as const, requestDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64),
        through: 3, expectedSequence: 3, sourceEntries: 3, sourceTurns: 1, maxCostMicros: 5, executorId: 'compact-worker', agentId: 'summarizer', agentVersion: '1', leaseMs: 30_000 };
      const first = await threads.compaction(reserve); expect(first?.status).toBe('pending');
      expect(await threads.compaction({ ...reserve, executorId: 'other-worker' })).toEqual(first);
      expect(await code(threads.compaction({ ...reserve, requestDigest: 'c'.repeat(64) }))).toBe('CONFLICT');
      expect(await code(threads.compaction({ scope: other, id: 'compact', commandId: 'compact-1', action: 'read' }))).toBe('NOT_FOUND');
      await threads.compaction({ scope, id: 'compact', commandId: 'compact-1', action: 'stage', executorId: 'compact-worker', content: 'A saved summary', modelRunId: 'model-run', costMicros: 3 });
      const results = await Promise.all([threads.compaction({ scope, id: 'compact', commandId: 'compact-1', action: 'commit' }), threads.compaction({ scope, id: 'compact', commandId: 'compact-1', action: 'commit' })]);
      expect(results[0]).toEqual(results[1]); expect(results[0]?.entrySequence).toBe(5);
      const entries = await threads.entries({ scope, id: 'compact', after: 0, limit: 20 });
      expect(entries.slice(0, 3).map(entry => ({ kind: entry.kind, data: entry.data }))).toEqual(source);
      expect(entries.filter(entry => entry.kind === 'summary')).toHaveLength(1);
      expect(await threads.compaction({ scope, id: 'compact', commandId: 'compact-1', action: 'fail', executorId: 'compact-worker', code: 'CANCELLED' })).toEqual(results[0]);
      for (let page = 0; page < 10; page++) { if ((await threads.delete({ scope, id: 'compact', limit: 2 })).thread.status === 'deleted') break; }
      const journal = `thread-compact:${sha256Hex(`${scope}\0compact\0compact-1`)}`;
      expect(await checkpoints.get({ runId: journal })).toBeUndefined();
    });

    it('fences cancelled compaction executors and preserves staged output while another turn owns the thread', async () => {
      await create('blocked-summary'); await hold('blocked-summary');
      await threads.append({ scope, id: 'blocked-summary', runId: 'run-1', holderId: 'replica-a', expectedSequence: 0,
        entries: [{ kind: 'user', data: { content: 'Question' } }, { kind: 'assistant', data: { output: 'Answer' } }, { kind: 'run', data: { runId: 'original', status: 'succeeded' } }] });
      await threads.release({ scope, id: 'blocked-summary', runId: 'run-1', holderId: 'replica-a' });
      const base = { scope, id: 'blocked-summary', commandId: 'compact-1' };
      await threads.compaction({ ...base, action: 'reserve', requestDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), through: 3, expectedSequence: 3,
        sourceEntries: 3, sourceTurns: 1, maxCostMicros: 5, executorId: 'compact-worker', agentId: 'summarizer', agentVersion: '1', leaseMs: 30_000 });
      await threads.compaction({ ...base, action: 'stage', executorId: 'compact-worker', content: 'Saved', modelRunId: 'model-run', costMicros: 3 });
      await threads.release({ scope, id: 'blocked-summary', runId: 'compact-worker', holderId: 'compact-worker' });
      await hold('blocked-summary', 'new-turn', 'new-worker');
      expect(await code(threads.compaction({ ...base, action: 'commit' }))).toBe('CONFLICT');
      expect((await threads.compaction({ ...base, action: 'read' }))?.status).toBe('ready');
      await threads.compaction({ ...base, action: 'fail', executorId: 'compact-worker', code: 'CANCELLED' });
      expect(await code(threads.compaction({ ...base, action: 'stage', executorId: 'compact-worker', content: 'Late', modelRunId: 'model-run', costMicros: 3 }))).toBe('CONFLICT');
      expect((await threads.get({ scope, id: 'blocked-summary' }))?.lease?.holderId).toBe('new-worker');
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
      while (result.thread.status !== 'deleted') { result = await threads.delete({ scope, id: 't1', limit: 100 }); calls++; expect(calls).toBeLessThanOrEqual(10); }
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

    it('takes a new checkpoint for a run whose earlier one was deleted', async () => {
      // A run that pauses twice saves under its id twice; deletion is real, so the id is free again.
      await checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body: { pause: 1 } });
      await checkpoints.claim({ runId: 'run-1', holderId: 'replica-a', leaseMs: 30_000 });
      expect(await checkpoints.delete({ runId: 'run-1', holderId: 'replica-a' })).toBe(true);
      const again = await checkpoints.put({ runId: 'run-1', scope, expiresAtMs: Date.now() + 60_000, body: { pause: 2 } });
      expect(again).toMatchObject({ version: 1, status: 'waiting', holderId: null, body: { pause: 2 } });
      expect((await checkpoints.get({ runId: 'run-1' }))?.body).toEqual({ pause: 2 });
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
