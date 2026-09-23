import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobReservation, SchedulerAggregateStore } from '@mayura/storage-contracts';

export interface IdentityIntegrityFixture {
  readonly store: SchedulerAggregateStore;
  reopen(): SchedulerAggregateStore;
  cleanup(): Promise<void>;
}

/** Real-driver admission tests: invalid keys must never alias literal U+FFFD keys. */
export function identityIntegrityConformance(name: string, factory: () => Promise<IdentityIntegrityFixture>): void {
  describe(`${name} SQL identity integrity`, () => {
    let fixture: IdentityIntegrityFixture;
    let store: SchedulerAggregateStore;
    let stores: SchedulerAggregateStore[];
    const reservation = (): JobReservation => ({ scope: 'scope', jobId: 'alias-\ufffd', reservationKey: 'reservation', runId: 'run', nodeId: 'node', invocationId: 'invocation',
      definitionHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), intent: { toolId: 'tool', callId: 'call' }, resourceKeys: [], delayMs: 0 });

    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; stores = [store];
      await store.initialize(); await store.scheduler.initialize();
    });
    afterEach(async () => { for (const owned of stores ?? []) await owned.close(); await fixture?.cleanup(); });

    it('rejects malformed aggregate identities without reading, updating or aliasing valid records', async () => {
      const base = { scope: 'scope', id: 'alias-\ufffd', idempotencyKey: 'key', definitionHash: 'hash', state: { unchanged: true }, events: [{ type: 'created', data: {} }] };
      const created = await store.create(base); const beforeEvents = await store.events(base.scope, base.id);
      for (const value of ['alias-\ud800', 'alias-\udfff', 'alias-\udc00\ud800']) {
        for (const field of ['scope', 'id', 'idempotencyKey', 'definitionHash']) {
          await expect(store.create({ ...base, id: 'candidate', idempotencyKey: 'candidate', [field]: value })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        }
        await expect(store.create({ ...base, id: 'candidate', idempotencyKey: 'candidate', events: [{ type: value, data: {} }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(store.read('scope', value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(store.events('scope', value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(store.read(value, base.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(store.update({ scope: 'scope', id: value, expectedVersion: 1, state: { changed: true }, events: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(await store.read(base.scope, base.id)).toEqual(created.record);
        expect(await store.events(base.scope, base.id)).toEqual(beforeEvents);
      }
      expect(await store.read('scope', 'candidate')).toBeUndefined();
      expect(await store.read('alias-\ufffd', 'candidate')).toBeUndefined();
    });

    it('rejects malformed scheduler reservation identities including resource and intent keys', async () => {
      const before = await store.scheduler.reserve(reservation());
      const events = await store.scheduler.events({ scope: 'scope', runId: 'run' });
      const candidate = { ...reservation(), jobId: 'candidate', reservationKey: 'candidate', invocationId: 'candidate' };
      for (const field of ['scope', 'jobId', 'reservationKey', 'runId', 'nodeId', 'invocationId']) {
        await expect(store.scheduler.reserve({ ...candidate, [field]: 'bad-\ud800' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      for (const field of ['toolId', 'callId']) {
        await expect(store.scheduler.reserve({ ...candidate, intent: { ...candidate.intent, [field]: 'bad-\udfff' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      await expect(store.scheduler.reserve({ ...candidate, resourceKeys: ['resource-\ud800'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await store.scheduler.read({ scope: 'scope', jobId: before.job.jobId })).toEqual(before.job);
      expect(await store.scheduler.read({ scope: 'scope', jobId: 'candidate' })).toBeUndefined();
      expect(await store.scheduler.events({ scope: 'scope', runId: 'run' })).toEqual(events);
    });

    it('rejects malformed scheduler reads, controls and worker claims without changing ownership', async () => {
      const before = await store.scheduler.reserve(reservation());
      const events = await store.scheduler.events({ scope: 'scope', runId: 'run' });
      for (const jobId of ['alias-\ud800', 'alias-\udfff']) {
        await expect(store.scheduler.read({ scope: 'scope', jobId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(store.scheduler.cancel({ scope: 'scope', jobId, commandId: 'cancel' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      await expect(store.scheduler.claim({ scope: 'scope', workerId: 'worker-\ud800', limit: 1, leaseMs: 10_000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.scheduler.cancel({ scope: 'scope', jobId: before.job.jobId, commandId: 'cancel-\udfff' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.scheduler.events({ scope: 'scope', runId: 'run-\ud800' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await store.scheduler.read({ scope: 'scope', jobId: before.job.jobId })).toEqual(before.job);
      expect(await store.scheduler.events({ scope: 'scope', runId: 'run' })).toEqual(events);
      const claims = await store.scheduler.claim({ scope: 'scope', workerId: 'worker-\ufffd', limit: 1, leaseMs: 10_000 });
      expect(claims).toHaveLength(1); expect(claims[0]!.claim.fence).toBe(1);
    });

    it('preserves distinct Unicode identities and escaped payload units across reopening', async () => {
      const identities = ['\ud83d\ude80'.repeat(64), '\ud800\udc00', '\udbff\udfff', '\ufffd', 'é', 'e\u0301'];
      for (const id of identities) {
        const result = await store.create({ scope: id, id, idempotencyKey: id, definitionHash: id, state: { text: '\ud800' }, events: [{ type: id, data: { text: '\udfff' } }] });
        expect(result.created).toBe(true); expect(result.record.id).toBe(id);
      }
      // Also put canonical-equivalent forms in one scope: they must remain separate keys.
      for (const id of ['é', 'e\u0301']) await store.create({ scope: 'same-scope', id, idempotencyKey: id, definitionHash: id, state: { id }, events: [] });
      const longId = '\ud83d\ude80'.repeat(64);
      const job = await store.scheduler.reserve({ ...reservation(), jobId: longId, reservationKey: longId, invocationId: longId, nodeId: longId, runId: longId,
        intent: { toolId: '\ufffd', callId: longId, payload: '\ud800' }, resourceKeys: identities });
      await store.close(); store = fixture.reopen(); stores.push(store); await store.initialize(); await store.scheduler.initialize();
      for (const id of identities) {
        const stored = await store.read(id, id); expect(stored?.id).toBe(id); expect(stored?.definitionHash).toBe(id); expect(stored?.state).toEqual({ text: '\ud800' });
        const history = await store.events(id, id); expect(history[0]?.type).toBe(id); expect(history[0]?.data).toEqual({ text: '\udfff' });
      }
      for (const id of ['é', 'e\u0301']) expect((await store.read('same-scope', id))?.state).toEqual({ id });
      expect(await store.scheduler.read({ scope: 'scope', jobId: longId })).toEqual(job.job);
      const claimed = await store.scheduler.claim({ scope: 'scope', workerId: longId, limit: 1, leaseMs: 10_000 });
      expect(claimed[0]?.claim.workerId).toBe(longId);
    });
  });
}
