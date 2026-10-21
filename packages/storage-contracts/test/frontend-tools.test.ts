import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAggregateFrontendToolStore } from '../dist/index.js';
const scope = { principalId: 'alice', projectId: 'shop' }; const agentId = 'support'; const runId = 'native-1';
let directory: string; let store: ReturnType<typeof createSqliteStore>;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-frontend-journal-')); store = createSqliteStore({ filename: join(directory, 'journal.sqlite') }); await store.initialize(); });
afterEach(async () => { vi.useRealTimers(); await store.close();
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-frontend-journal-`)) throw new Error('Unsafe cleanup path'); await rm(directory, { recursive: true, force: true }); });
const journal = () => createAggregateFrontendToolStore(store, { permissions: { allow: ['frontend-tools:store'] } });
async function registered() {
  const a = journal(); const b = journal(); const definitionDigest = 'a'.repeat(64);
  await a.bind({ scope, agentId, runId, threadId: 'thread-1', tools: [{ id: 'ui.choose', version: '1+build', digest: definitionDigest }], expiresAtMs: Date.now() + 60_000 });
  const input = { scope, agentId, runId, callId: 'provider@call', toolId: 'ui.choose', toolVersion: '1+build', definitionDigest, input: { item: 7 }, timeoutMs: 1000, retentionMs: 5000 };
  const [first, second] = await Promise.all([a.register(input), b.register(input)]); expect(first.token).toBe(second.token);
  const key = { scope, agentId, token: first.token }; await a.dispatch(key, 'ui-1'); return { a, b, key, input };
}
describe('durable frontend claim and result journal', () => {
  it('requires storage permission before accessing the backend', () => { expect(() => createAggregateFrontendToolStore(store, { permissions: { allow: [] } })).toThrow(); });
  it('pins a call once and admits only one racing browser claim across store instances', async () => {
    const { a, b, key } = await registered();
    const claims = await Promise.allSettled([a.claim(key, 'b'.repeat(43)), b.claim(key, 'c'.repeat(43))]);
    expect(claims.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const restarted = journal(); expect((await restarted.read(key))?.status).toBe('claimed');
    await expect(restarted.claim(key, 'd'.repeat(43))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await restarted.read({ ...key, scope: { ...scope, projectId: 'other' } })).toBeNull();
    expect(await restarted.read({ ...key, agentId: 'other-agent' })).toBeNull();
  });
  it('atomically stores an immutable outbox, permits exact retries, and reserves it to one native consumer permanently', async () => {
    const { a, b, key } = await registered(); const claimId = 'b'.repeat(43); await a.claim(key, claimId);
    const result = { claimId, threadId: 'thread-1', continuationRunId: 'ui-2', requestDigest: 'e'.repeat(64), value: { selected: 7 }, failed: false };
    const saved = await b.accept(key, result); expect(saved.outbox).toMatchObject({ value: { selected: 7 }, consumerId: null });
    expect((await journal().accept(key, result)).outbox).toEqual(saved.outbox);
    await expect(b.accept(key, { ...result, requestDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
    const reserved = await a.reserveResult(key, 'owner-a'); expect(reserved.outbox?.consumerId).toBe('owner-a');
    expect((await a.reserveResult(key, 'owner-a')).outbox).toEqual(reserved.outbox);
    await expect(journal().reserveResult(key, 'owner-b')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await journal().read(key))?.outbox?.value).toEqual({ selected: 7 });
  });
  it('retains an accepted result even when the accepting process loses its commit reply', async () => {
    const { a, key } = await registered(); const claimId = 'b'.repeat(43); await a.claim(key, claimId);
    const failing = createAggregateFrontendToolStore({ ...store, update: async command => { await store.update(command); throw new Error('lost reply'); } }, { permissions: { allow: ['frontend-tools:store'] } });
    const result = { claimId, threadId: 'thread-1', continuationRunId: 'ui-2', requestDigest: 'e'.repeat(64), value: { selected: 7 }, failed: false };
    await expect(failing.accept(key, result)).rejects.toThrow();
    expect((await journal().read(key))?.outbox?.requestDigest).toBe(result.requestDigest);
    expect((await journal().accept(key, result)).status).toBe('settled');
  });
  it('does not reopen expired claims, accepts late claimed evidence within retention, and redacts content without deleting tombstones', async () => {
    vi.useFakeTimers(); const { a, b, key, input } = await registered(); const claimId = 'b'.repeat(43); await a.claim(key, claimId);
    await vi.advanceTimersByTimeAsync(1001); await expect(b.claim(key, 'c'.repeat(43))).rejects.toMatchObject({ code: 'CONFLICT' });
    await b.accept(key, { claimId, threadId: 'thread-1', continuationRunId: 'ui-2', requestDigest: 'e'.repeat(64), value: { selected: 7 }, failed: false });
    await vi.advanceTimersByTimeAsync(5000); expect(await a.purgeExpired(scope, agentId, runId)).toBe(1);
    expect(await b.read(key)).toMatchObject({ purged: true, input: null, status: 'settled', outbox: { value: null, requestDigest: 'e'.repeat(64) } });
    expect((await b.register(input)).token).toBe(key.token); await expect(b.claim(key, 'c'.repeat(43))).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects changed bindings, tools, inputs, claim proofs and continuation identities', async () => {
    const { a, key, input } = await registered(); await expect(a.register({ ...input, input: { item: 99 } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(a.bind({ scope, agentId, runId, threadId: 'other', tools: [], expiresAtMs: Date.now() + 60_000 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await a.claim(key, 'b'.repeat(43));
    const result = { claimId: 'b'.repeat(43), threadId: 'thread-1', continuationRunId: 'ui-2', requestDigest: 'e'.repeat(64), value: null, failed: true };
    for (const changes of [{ claimId: 'x'.repeat(43) }, { threadId: 'other' }, { continuationRunId: 'ui-1' }]) await expect(a.accept(key, { ...result, ...changes })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await a.read(key))?.outbox).toBeNull();
  });
});
