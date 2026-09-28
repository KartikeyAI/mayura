import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@mayura/core';
import { createAggregateRunRecords } from '@mayura/storage';
import { durableBudgetPostgresFixture, durableBudgetSqliteFixture, type DurableBudgetFixture } from './durable-budget-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const digest = (letter: string) => letter.repeat(64);
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner = JSON.stringify({ principalId: 'user', projectId: 'project' });
const snapshot = (status = 'running') => ({ id: runId, status, budget: { spentMicros: 0, reservedMicros: 0, calls: 0 }, evidence: [] });
const event = (sequence: number, type: RunEvent['type'] = 'step.started', metadata: RunEvent['metadata'] = { step: sequence }): RunEvent =>
  ({ runId, sequence, timestamp: '2026-09-28T00:00:00.000Z', type, metadata });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => event(from + index));

for (const [name, factory, enabled] of [['SQLite', durableBudgetSqliteFixture, true],
  ['PostgreSQL', () => durableBudgetPostgresFixture(connectionString!), connectionString !== undefined]] as const) {
  (enabled ? describe : describe.skip)(`${name} durable run records`, () => {
    const withStore = async (test: (fixture: DurableBudgetFixture) => Promise<void>) => {
      const fixture: DurableBudgetFixture = await factory();
      try { await fixture.store.initialize(); await test(fixture); } finally { await fixture.store.close().catch(() => {}); await fixture.cleanup(); }
    };

    it('claims a key once, binds it to its run, gives an unstarted claim back and isolates owners', () => withStore(async fixture => {
      const records = createAggregateRunRecords(fixture.store);
      const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => records.claim({ owner, key: 'k-1', digest: digest('a'), replicaId: `replica-${index}`, nowMs: 100 })));
      expect(claims.filter(claim => claim.status === 'claimed')).toHaveLength(1);
      expect(claims.filter(claim => claim.status === 'existing')).toEqual(Array(5).fill({ status: 'existing', digest: digest('a'), runId: null, claimedAtMs: 100 }));
      // Only the claimant may give a claim back; then the key can be claimed again, even with another payload.
      const winner = `replica-${claims.findIndex(claim => claim.status === 'claimed')}`;
      await records.release({ owner, key: 'k-1', replicaId: winner === 'replica-0' ? 'replica-1' : 'replica-0' });
      expect(await records.claim({ owner, key: 'k-1', digest: digest('b'), replicaId: 'late', nowMs: 200 })).toMatchObject({ status: 'existing', digest: digest('a') });
      await records.release({ owner, key: 'k-1', replicaId: winner });
      expect(await records.claim({ owner, key: 'k-1', digest: digest('b'), replicaId: 'second', nowMs: 300 })).toEqual({ status: 'claimed' });
      await records.start({ owner, key: 'k-1', runId, agentId: 'agent', replicaId: 'second', leaseExpiresAtMs: 1_000, snapshot: snapshot() });
      expect(await records.claim({ owner, key: 'k-1', digest: digest('b'), replicaId: 'third', nowMs: 400 })).toEqual({ status: 'existing', digest: digest('b'), runId, claimedAtMs: 300 });
      await records.release({ owner, key: 'k-1', replicaId: 'second' });
      expect(await records.claim({ owner, key: 'k-1', digest: digest('b'), replicaId: 'third', nowMs: 500 })).toMatchObject({ status: 'existing', runId });
      const other = JSON.stringify({ principalId: 'other', projectId: 'project' });
      expect(await records.read({ owner: other, runId })).toBeNull();
      expect(await records.events({ owner: other, runId, after: 0, limit: 10 })).toEqual([]);
      expect(await records.claim({ owner: other, key: 'k-1', digest: digest('c'), replicaId: 'third', nowMs: 1 })).toEqual({ status: 'claimed' });
      await expect(records.claim({ owner, key: 'bad key', digest: digest('a'), replicaId: 'r', nowMs: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }));

    it('records ordered events, snapshots, cancel requests and the outcome, and survives reopening', () => withStore(async fixture => {
      let records = createAggregateRunRecords(fixture.store);
      await records.claim({ owner, key: 'k', digest: digest('a'), replicaId: 'owner', nowMs: 1 });
      await records.start({ owner, key: 'k', runId, agentId: 'agent', replicaId: 'owner', leaseExpiresAtMs: 5_000, snapshot: snapshot() });
      expect(await records.update({ owner, runId, replicaId: 'owner', events: [event(1, 'run.started', {}), ...range(2, 4)], snapshot: snapshot(), leaseExpiresAtMs: 6_000 }))
        .toEqual({ status: 'written', cancelRequested: false });
      // Events must continue the recorded sequence; a writer that is not the owner has lost the run.
      await expect(records.update({ owner, runId, replicaId: 'owner', events: [event(6)], snapshot: snapshot(), leaseExpiresAtMs: 6_000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await records.update({ owner, runId, replicaId: 'intruder', events: [event(5)], snapshot: snapshot(), leaseExpiresAtMs: 6_000 })).toEqual({ status: 'lost' });
      expect(await records.requestCancel({ owner, runId })).toMatchObject({ cancelRequested: true, status: 'running' });
      expect(await records.update({ owner, runId, replicaId: 'owner', events: [event(5)], snapshot: snapshot(), leaseExpiresAtMs: 7_000 }))
        .toEqual({ status: 'written', cancelRequested: true });
      // The lease has not lapsed, so abandonment changes nothing.
      expect(await records.abandon({ owner, runId, nowMs: 6_999 })).toMatchObject({ status: 'running' });
      const outcome = { status: 'cancelled', error: { code: 'CANCELLED', message: 'Run cancelled.' }, evidence: [] };
      expect(await records.update({ owner, runId, replicaId: 'owner', events: [event(6, 'run.completed', { status: 'cancelled' })], snapshot: snapshot('cancelled'),
        leaseExpiresAtMs: 8_000, outcome })).toEqual({ status: 'written', cancelRequested: true });
      await fixture.store.close(); const reopened = fixture.reopen(); await reopened.initialize(); records = createAggregateRunRecords(reopened);
      try {
        expect(await records.read({ owner, runId })).toEqual({ runId, agentId: 'agent', replicaId: 'owner', status: 'cancelled', leaseExpiresAtMs: 8_000,
          cancelRequested: true, lastSequence: 6, snapshot: snapshot('cancelled'), outcome });
        expect((await records.events({ owner, runId, after: 0, limit: 100 })).map(item => item.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
        expect((await records.events({ owner, runId, after: 2, limit: 2 })).map(item => item.sequence)).toEqual([3, 4]);
        expect(await records.events({ owner, runId, after: 6, limit: 10 })).toEqual([]);
        // A finished run can no longer be written, cancelled or abandoned.
        expect(await records.update({ owner, runId, replicaId: 'owner', events: [], snapshot: snapshot(), leaseExpiresAtMs: 9_000 })).toEqual({ status: 'lost' });
        expect(await records.abandon({ owner, runId, nowMs: 1e12 })).toMatchObject({ status: 'cancelled' });
      } finally { await reopened.close(); }
    }));

    it('settles a run whose lease lapsed as outcome_unknown with a closing run.completed, and the old owner then loses it', () => withStore(async fixture => {
      const records = createAggregateRunRecords(fixture.store);
      await records.claim({ owner, key: 'k', digest: digest('a'), replicaId: 'owner', nowMs: 1 });
      await records.start({ owner, key: 'k', runId, agentId: 'agent', replicaId: 'owner', leaseExpiresAtMs: 1_000, snapshot: snapshot() });
      await records.update({ owner, runId, replicaId: 'owner', events: range(1, 3), snapshot: snapshot(), leaseExpiresAtMs: 1_000 });
      const settled = await records.abandon({ owner, runId, nowMs: 1_001 });
      expect(settled).toMatchObject({ status: 'outcome_unknown', lastSequence: 4, snapshot: { status: 'outcome_unknown' },
        outcome: { status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' }, evidence: [] } });
      expect((await records.events({ owner, runId, after: 3, limit: 10 })).map(item => [item.sequence, item.type, item.metadata])).toEqual([[4, 'run.completed', { status: 'outcome_unknown' }]]);
      expect(await records.update({ owner, runId, replicaId: 'owner', events: [event(4)], snapshot: snapshot(), leaseExpiresAtMs: 9_000 })).toEqual({ status: 'lost' });
    }));

    it('keeps a bounded history: runtime gaps map to run sequences and later events close with one gap', () => withStore(async fixture => {
      const records = createAggregateRunRecords(fixture.store, { maxEvents: 16 });
      expect(() => createAggregateRunRecords(fixture.store, { maxEvents: 8 })).toThrow();
      await records.claim({ owner, key: 'k', digest: digest('a'), replicaId: 'owner', nowMs: 1 });
      await records.start({ owner, key: 'k', runId, agentId: 'agent', replicaId: 'owner', leaseExpiresAtMs: 1e12, snapshot: snapshot() });
      const runtimeGap = { ...event(20, 'events.gap', { from: 6, to: 20 }) };
      await records.update({ owner, runId, replicaId: 'owner', events: [...range(1, 5), runtimeGap, ...range(21, 40)], snapshot: snapshot(), leaseExpiresAtMs: 1e12 });
      const outcome = { status: 'succeeded', output: 'x'.repeat(300_000), evidence: [] };
      await records.update({ owner, runId, replicaId: 'owner', events: [event(41, 'run.completed', { status: 'succeeded' })], snapshot: snapshot('succeeded'), leaseExpiresAtMs: 1e12, outcome });
      const all = await records.events({ owner, runId, after: 0, limit: 1_000 });
      expect(all.length).toBeLessThanOrEqual(16);
      expect(all.map(item => item.sequence)).toEqual([1, 2, 3, 4, 5, 20, 21, 22, 23, 24, 25, 26, 27, 28, 40, 41]);
      expect(all[5]).toMatchObject({ type: 'events.gap', metadata: { from: 6, to: 20 } });
      expect(all[14]).toMatchObject({ type: 'events.gap', metadata: { from: 29, to: 40 } });
      // Readers resume from any sequence, including inside a gap, and see a gap that starts right after their cursor.
      expect((await records.events({ owner, runId, after: 10, limit: 2 })).map(item => [item.sequence, item.metadata])).toEqual([[20, { from: 11, to: 20 }], [21, { step: 21 }]]);
      expect((await records.events({ owner, runId, after: 20, limit: 1 })).map(item => item.sequence)).toEqual([21]);
      expect((await records.events({ owner, runId, after: 33, limit: 5 })).map(item => [item.sequence, item.type])).toEqual([[40, 'events.gap'], [41, 'run.completed']]);
      expect((await records.events({ owner, runId, after: 33, limit: 1 }))[0]?.metadata).toEqual({ from: 34, to: 40 });
      // The large outcome is kept outside the record and verified when read.
      expect((await records.read({ owner, runId }))?.outcome).toEqual(outcome);
    }));
  });
}
