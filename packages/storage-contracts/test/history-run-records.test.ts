import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAggregateRunRecords } from '../src/run-records.js';
import type { RunEvent } from '@mayura/core';
const stores: ReturnType<typeof createSqliteStore>[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

describe('durable history application events', () => {
  it('round-trips exact counts and refuses a forged content-bearing history event', async () => {
    const store = createSqliteStore({ filename: ':memory:' }); stores.push(store); await store.initialize();
    const records = createAggregateRunRecords(store); const owner = 'alice'; const key = 'history'; const replicaId = 'worker';
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const leaseExpiresAtMs = Date.now() + 60000;
    const snapshot = { id: runId, status: 'running', budget: { spentMicros: 0, reservedMicros: 0, calls: 0 }, evidence: [] };
    await records.claim({ owner, key, digest: 'a'.repeat(64), replicaId, nowMs: Date.now() });
    await records.start({ owner, key, runId, agentId: 'support', replicaId, leaseExpiresAtMs, snapshot });
    const event: RunEvent = { runId, sequence: 1, timestamp: new Date(0).toISOString(), type: 'history.applied',
      metadata: { entries: 2, omitted: 3, bytes: 100, scanTruncated: true } };
    expect(await records.update({ owner, runId, replicaId, leaseExpiresAtMs, snapshot, events: [event] })).toMatchObject({ status: 'written' });
    expect(await records.events({ owner, runId, after: 0, limit: 10 })).toEqual([event]);
    await expect(records.update({ owner, runId, replicaId, leaseExpiresAtMs, snapshot,
      events: [{ ...event, sequence: 2, metadata: { ...event.metadata, input: 'PRIVATE' } }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await records.events({ owner, runId, after: 0, limit: 10 })).toEqual([event]);
  });
});
