import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAggregateFrontendToolStore } from '../src/frontend-tools.js';
let directory: string; let store: ReturnType<typeof createSqliteStore>;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-recovery-fence-')); store = createSqliteStore({ filename: join(directory, 'store.sqlite') }); await store.initialize(); await store.runCheckpoints.initialize(); });
afterEach(async () => { await store.close(); if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-recovery-fence-`)) throw new Error('Unsafe cleanup path'); await rm(directory, { recursive: true, force: true }); });
it('cannot consume a later checkpoint epoch even when its run id, holder and version repeat', async () => {
  const saved = async (digest: string) => { await store.runCheckpoints.put({ runId: 'run-1', scope: 'scope-1', expiresAtMs: Date.now() + 10_000, body: { waitKind: 'frontend', pending: { digest } } });
    return store.runCheckpoints.claim({ runId: 'run-1', holderId: 'owner', leaseMs: 10_000 }); };
  const first = await saved('a'.repeat(64));
  const command = { runId: 'run-1', holderId: 'owner', expectedVersion: first.version, expectedDigest: 'a'.repeat(64) };
  expect(await store.runCheckpoints.delete({ ...command, expectedVersion: first.version + 1 })).toBe(false);
  expect(await store.runCheckpoints.delete(command)).toBe(true);
  const next = await saved('b'.repeat(64)); expect(next.version).toBe(first.version);
  await expect(store.runCheckpoints.claim({ runId: 'run-1', holderId: 'stale-owner', leaseMs: 10_000, expectedDigest: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await store.runCheckpoints.get({ runId: 'run-1' }))?.holderId).toBe('owner');
  expect(await store.runCheckpoints.delete(command)).toBe(false);
  expect(await store.runCheckpoints.delete({ ...command, expectedDigest: 'b'.repeat(64) })).toBe(true);
});
it('keeps a prepared browser call non-executable until its native checkpoint is published', async () => {
  const journal = createAggregateFrontendToolStore(store, { permissions: { allow: ['frontend-tools:store'] } });
  const scope = { principalId: 'alice', projectId: 'shop' }; const agentId = 'support'; const digest = 'a'.repeat(64);
  await journal.bind({ scope, agentId, runId: 'run-1', threadId: 'thread-1', tools: [{ id: 'ui.select', version: '1', digest }], expiresAtMs: Date.now() + 10_000 });
  const call = await journal.register({ scope, agentId, runId: 'run-1', callId: 'c1', toolId: 'ui.select', toolVersion: '1', definitionDigest: digest,
    input: { item: 7 }, timeoutMs: 1000, retentionMs: 1000, recoverable: true });
  const key = { scope, agentId, token: call.token };
  await expect(journal.dispatch(key, 'ui-1')).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(journal.claim(key, 'b'.repeat(43))).rejects.toMatchObject({ code: 'CONFLICT' });
  await journal.park!(key); await journal.dispatch(key, 'ui-1'); await journal.claim(key, 'b'.repeat(43));
  await journal.park!(key); await expect(journal.claim(key, 'c'.repeat(43))).rejects.toMatchObject({ code: 'CONFLICT' });
});
