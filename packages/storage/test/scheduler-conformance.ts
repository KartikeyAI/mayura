import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Claim, JobReservation, SchedulerAggregateStore, SchedulerStore } from '@mayura/storage-contracts';

export interface SchedulerFixture {
  store: SchedulerAggregateStore;
  reopen(): SchedulerAggregateStore;
  cleanup(): Promise<void>;
  corruptJob?(mutate: (data: JsonObject) => void): Promise<void>;
  readonly childOptions: JsonObject;
  holdJob(): Promise<{ release(): Promise<void> }>;
}
const key = { scope: 'scheduler-a', jobId: 'job-a' };
const candidateHash = 'a'.repeat(64);
const executionReceipt = { callId: 'call-a', toolId: 'tool-a', execution: 'succeeded', disclosure: 'withheld' } as const;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function schedulerConformance(name: string, factory: () => Promise<SchedulerFixture>): void {
  describe(`${name} leased scheduler`, () => {
    let fixture: SchedulerFixture;
    let stores: SchedulerAggregateStore[];
    let scheduler: SchedulerStore;
    const reserve = (overrides: Partial<JobReservation> = {}) => scheduler.reserve({
      ...key, reservationKey: 'reserve-a', runId: 'run-a', nodeId: 'node-a', invocationId: 'invoke-a',
      definitionHash: 'd'.repeat(64), candidateHash, intent: { toolId: 'tool-a', callId: 'call-a', source: 'safe' }, resourceKeys: [], delayMs: 0, ...overrides,
    });
    const claimOne = async (leaseMs = 10_000): Promise<Claim> => (await scheduler.claim({ scope: key.scope, workerId: 'worker-a', limit: 1, leaseMs }))[0]!.claim;
    const finish = async (claim: Claim) => {
      await scheduler.start({ claim, candidateHash });
      await scheduler.recordReceipt({ ...key, fence: claim.fence, evidenceId: 'evidence', receipt: executionReceipt });
      return scheduler.complete({ claim, commandId: 'complete', evidenceId: 'evidence', outcome: 'succeeded', output: { admitted: true } });
    };
    beforeEach(async () => {
      fixture = await factory(); stores = [fixture.store]; await fixture.store.initialize();
      scheduler = fixture.store.scheduler; await scheduler.initialize();
    });
    afterEach(async () => { for (const store of stores ?? []) await store.close(); await fixture?.cleanup(); });

    it('reserves once and checks original canonical content after execution', async () => {
      const created = await reserve(); expect(created.created).toBe(true); expect(created.job.version).toBe(1);
      const completed = await finish(await claimOne()); expect(completed.state).toBe('succeeded');
      const retry = await reserve(); expect(retry.created).toBe(false); expect(retry.job).toEqual(completed);
      await expect(reserve({ candidateHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(reserve({ reservationKey: 'different-key' })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(Object.isFrozen(retry.job)).toBe(true); expect(Object.isFrozen(retry.job.intent)).toBe(true);
    });

    it('never uses claimed ownership or duplicate start as a second dispatch permit', async () => {
      await reserve(); const claim = await claimOne();
      expect((await scheduler.read(key))?.state).toBe('leased');
      expect((await scheduler.start({ claim, candidateHash })).status).toBe('started');
      expect((await scheduler.start({ claim, candidateHash })).status).toBe('already_started');
      await expect(scheduler.start({ claim: { ...claim, workerId: 'other' }, candidateHash })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect(await scheduler.claim({ scope: key.scope, workerId: 'other', limit: 2, leaseMs: 1_000 })).toEqual([]);
    });

    it('enforces scope on all read, claim, receipt and control operations', async () => {
      await reserve(); const claim = await claimOne(); await scheduler.start({ claim, candidateHash });
      expect(await scheduler.read({ ...key, scope: 'other' })).toBeUndefined();
      expect(await scheduler.claim({ scope: 'other', workerId: 'worker', limit: 1, leaseMs: 1_000 })).toEqual([]);
      await expect(scheduler.start({ claim: { ...claim, scope: 'other' }, candidateHash })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(scheduler.recordReceipt({ ...key, scope: 'other', fence: claim.fence, evidenceId: 'evidence', receipt: executionReceipt })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(scheduler.cancel({ ...key, scope: 'other', commandId: 'cancel' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await scheduler.events({ scope: 'other', runId: 'run-a' })).toEqual([]);
    });

    it('allows only one claim across independent storage owners', async () => {
      await reserve(); const other = fixture.reopen(); stores.push(other); await other.initialize(); await other.scheduler.initialize();
      const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? scheduler : other.scheduler).claim({ scope: key.scope, workerId: `worker-${index}`, limit: 1, leaseMs: 10_000 })));
      expect(claims.flat()).toHaveLength(1);
      expect(claims.flat()[0]!.claim.fence).toBe(1);
    });

    it('serializes declared resources and leaves unrelated work eligible', async () => {
      await reserve({ resourceKeys: ['resource-b', 'resource-a', 'resource-a'] });
      await reserve({ jobId: 'job-b', reservationKey: 'reserve-b', invocationId: 'invoke-b', resourceKeys: ['resource-a', 'resource-b'] });
      await reserve({ jobId: 'job-c', reservationKey: 'reserve-c', invocationId: 'invoke-c', resourceKeys: [] });
      const claims = await scheduler.claim({ scope: key.scope, workerId: 'worker', limit: 3, leaseMs: 10_000 });
      expect(claims).toHaveLength(2); expect(claims.some(result => result.job.jobId === 'job-c')).toBe(true);
      expect(claims.find(result => result.job.jobId !== 'job-c')!.job.resourceKeys).toEqual(['resource-a','resource-b']);
      for (const item of claims) await scheduler.cancel({ scope: key.scope, jobId: item.job.jobId, commandId: 'release' });
      expect(await scheduler.claim({ scope: key.scope, workerId: 'next', limit: 3, leaseMs: 10_000 })).toHaveLength(1);
    });

    it('renews a live generation but ignores caller-supplied expiry as authority', async () => {
      await reserve(); const claim = await claimOne(1_000);
      const renewed = await scheduler.renew({ claim: { ...claim, leaseUntilMs: 0 }, leaseMs: 10_000 });
      expect(renewed.fence).toBe(claim.fence); expect(renewed.leaseUntilMs).toBeGreaterThan(claim.leaseUntilMs);
      expect((await scheduler.start({ claim, candidateHash })).status).toBe('started');
    });

    it('persists expiry observation and rejects stale control before and after pre-start recovery', async () => {
      await reserve({ resourceKeys: ['exclusive'] }); const old = await claimOne(1_000); await pause(1_050);
      await expect(scheduler.renew({ claim: old, leaseMs: 10_000 })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect((await scheduler.read(key))?.leaseRevoked).toBe(true);
      await expect(scheduler.start({ claim: { ...old, leaseUntilMs: Number.MAX_SAFE_INTEGER }, candidateHash })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      await expect(scheduler.complete({ claim: old, commandId: 'uncommitted-completion', evidenceId: 'none', outcome: 'blocked', output: null })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      const recovered = await scheduler.recover({ scope: key.scope, limit: 10 }); expect(recovered[0]?.state).toBe('ready');
      expect(await scheduler.recover({ scope: key.scope, limit: 10 })).toEqual([]);
      const current = await claimOne(); expect(current.fence).toBe(old.fence + 1);
      await expect(scheduler.start({ claim: old, candidateHash })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect((await scheduler.start({ claim: current, candidateHash })).status).toBe('started');
    });

    it('never reclaims a started effect, retaining late evidence and resource quarantine', async () => {
      await reserve({ resourceKeys: ['exclusive'] }); const claim = await claimOne(1_000); await scheduler.start({ claim, candidateHash });
      await reserve({ jobId: 'job-b', reservationKey: 'reserve-b', invocationId: 'invoke-b', resourceKeys: ['exclusive'] });
      await pause(1_050);
      expect((await scheduler.recover({ scope: key.scope, limit: 10 }))[0]?.state).toBe('outcome_unknown');
      const late = await scheduler.recordReceipt({ ...key, fence: claim.fence, evidenceId: 'late', receipt: executionReceipt });
      expect(late.disposition).toBe('late'); expect(late.job.state).toBe('outcome_unknown'); expect(late.job.output).toBeNull();
      expect((await scheduler.receipts({ ...key, fence: claim.fence }))[0]?.receipt.execution).toBe('succeeded');
      await expect(scheduler.complete({ claim, commandId: 'late-completion', evidenceId: 'late', outcome: 'succeeded', output: true })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect(await scheduler.claim({ scope: key.scope, workerId: 'next', limit: 10, leaseMs: 1_000 })).toEqual([]);
    });

    it('preserves a successful effect separately from blocked output and completion retries', async () => {
      await reserve({ resourceKeys: ['exclusive'] }); const claim = await claimOne(); await scheduler.start({ claim, candidateHash });
      const receipt = { ...key, fence: claim.fence, evidenceId: 'effect', receipt: executionReceipt };
      await scheduler.recordReceipt(receipt); await scheduler.recordReceipt(receipt);
      await expect(scheduler.recordReceipt({ ...receipt, receipt: { ...executionReceipt, execution: 'failed' } })).rejects.toMatchObject({ code: 'CONFLICT' });
      const command = { claim, commandId: 'withheld', evidenceId: 'effect', outcome: 'blocked', output: null } as const;
      const blocked = await scheduler.complete(command);
      expect(blocked.state).toBe('blocked'); expect(blocked.receipt).toEqual(executionReceipt); expect(blocked.output).toBeNull();
      expect(await scheduler.complete(command)).toEqual(blocked);
      await expect(scheduler.complete({ ...command, outcome: 'succeeded', output: true })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(scheduler.complete({ ...command, commandId: 'new' })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
    });

    it('quarantines unknown or contradictory evidence instead of fabricating completion', async () => {
      await reserve(); const claim = await claimOne(); await scheduler.start({ claim, candidateHash });
      await scheduler.recordReceipt({ ...key, fence: claim.fence, evidenceId: 'known', receipt: executionReceipt });
      const conflict = await scheduler.recordReceipt({ ...key, fence: claim.fence, evidenceId: 'contradiction', receipt: { ...executionReceipt, execution: 'failed' } });
      expect(conflict.disposition).toBe('conflicting'); expect(conflict.job.state).toBe('outcome_unknown');
      expect(conflict.job.receipt?.execution).toBe('succeeded');
      await expect(scheduler.complete({ claim, commandId: 'complete', evidenceId: 'known', outcome: 'succeeded', output: true })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect(await scheduler.receipts({ ...key, fence: claim.fence })).toHaveLength(2);
    });

    it('resolves cancellation/start races once and never replays the cancelled job', async () => {
      await reserve(); const claim = await claimOne();
      const results = await Promise.allSettled([scheduler.start({ claim, candidateHash }), scheduler.cancel({ ...key, commandId: 'cancel' })]);
      expect(results[1]?.status).toBe('fulfilled');
      const job = await scheduler.read(key); expect(['cancelled','outcome_unknown']).toContain(job?.state);
      await expect(scheduler.start({ claim, candidateHash })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect(await scheduler.claim({ scope: key.scope, workerId: 'next', limit: 10, leaseMs: 1_000 })).toEqual([]);
      expect((await scheduler.cancel({ ...key, commandId: 'cancel' })).state).toBe(job?.state);
    });

    it('keeps due jobs dormant and cancels expired ready work using the storage clock', async () => {
      // Leave enough wall-clock headroom for a parallel integration worker to
      // reach the first claim without accidentally crossing the due boundary.
      await reserve({ delayMs: 1_000, deadlineAfterMs: 2_000 });
      expect(await scheduler.claim({ scope: key.scope, workerId: 'worker', limit: 1, leaseMs: 1_000 })).toEqual([]);
      await pause(2_050);
      expect((await scheduler.recover({ scope: key.scope, limit: 10 }))[0]?.state).toBe('cancelled');
    });

    it('retains claims and receipts across a new storage owner without altering aggregate data', async () => {
      await fixture.store.create({ scope: 'legacy', id: 'format-2', idempotencyKey: 'legacy', definitionHash: 'legacy', state: { format: 2, untouched: true }, events: [] });
      await reserve(); const claim = await claimOne(); await scheduler.start({ claim, candidateHash });
      await scheduler.recordReceipt({ ...key, fence: claim.fence, evidenceId: 'known', receipt: executionReceipt });
      await fixture.store.close(); const reopened = fixture.reopen(); stores.push(reopened); await reopened.initialize(); await reopened.scheduler.initialize();
      expect((await reopened.scheduler.read(key))?.state).toBe('started');
      expect((await reopened.scheduler.receipts({ ...key, fence: claim.fence }))[0]?.receipt.execution).toBe('succeeded');
      expect((await reopened.read('legacy','format-2'))?.state).toEqual({ format: 2, untouched: true });
    });

    it('bounds commands and snapshots caller-owned inputs before asynchronous work', async () => {
      const intent = { toolId: 'tool-a', callId: 'call-a', source: 'original' };
      const pending = reserve({ intent }); intent.source = 'changed'; const created = await pending;
      expect(created.job.intent['source']).toBe('original');
      for (const leaseMs of [0, 999, 300_001, NaN]) await expect(scheduler.claim({ scope: key.scope, workerId: 'worker', limit: 1, leaseMs })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(reserve({ jobId: 'other', reservationKey: 'other', invocationId: 'other', intent: { toolId: 'tool', callId: 'call', oversized: 'x'.repeat(4096) } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(scheduler.cancel({ ...key, commandId: 'cancel', unexpected: true } as unknown as Parameters<SchedulerStore['cancel']>[0])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('returns ordered metadata-only history and inspection never renews or changes state', async () => {
      await reserve(); const claim = await claimOne(); await finish(claim);
      const before = await scheduler.read(key); const events = await scheduler.events({ scope: key.scope, runId: 'run-a' });
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
      expect(JSON.stringify(events)).not.toContain('admitted'); expect(JSON.stringify(events)).not.toContain('safe');
      expect(await scheduler.events({ scope: key.scope, runId: 'run-a', after: events[0]!.sequence, limit: 1 })).toHaveLength(1);
      expect(await scheduler.read(key)).toEqual(before);
    });

    it('rejects impossible persisted success even when SQL queue columns match', async () => {
      await reserve();
      await fixture.corruptJob!(data => {
        const job = data['job'] as JsonObject;
        job['state'] = 'succeeded'; job['output'] = { secret: 'unadmitted' };
        job['receipt'] = { ...executionReceipt, disclosure: 'released' };
      });
      await expect(scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await expect(scheduler.cancel({ ...key, commandId: 'cancel' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('commits stale observation without falsely journaling a failed completion', async () => {
      await reserve(); const claim = await claimOne(1_000); await scheduler.start({ claim, candidateHash });
      await scheduler.recordReceipt({ ...key, fence: claim.fence, evidenceId: 'known', receipt: executionReceipt });
      await pause(1_050);
      const command = { claim, commandId: 'never-committed', evidenceId: 'known', outcome: 'succeeded', output: true } as const;
      await expect(scheduler.complete(command)).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect((await scheduler.read(key))?.leaseRevoked).toBe(true);
      await expect(scheduler.complete(command)).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect((await scheduler.read(key))?.output).toBeNull();
    });

    it('retains revocation if a stored clock boundary subsequently moves backwards', async () => {
      await reserve(); const claim = await claimOne(1_000); await pause(1_050);
      await expect(scheduler.start({ claim, candidateHash })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      await fixture.corruptJob!(data => {
        // Controlled fault simulates the old expiry becoming future relative to database time.
        // The sticky revocation, not this informative timestamp, must keep the generation stale.
        const job = data['job'] as JsonObject; const expiry = Date.now() + 60_000;
        job['leaseUntilMs'] = expiry;
        const attempts = data['attempts'] as JsonObject[]; attempts.at(-1)!['leaseUntilMs'] = expiry;
      });
      await expect(scheduler.renew({ claim, leaseMs: 10_000 })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      expect((await scheduler.recover({ scope: key.scope, limit: 1 }))[0]?.state).toBe('ready');
    });

    it.each(['claim','start','receipt'] as const)('recovers truthfully after a process is killed following %s commit', async phase => {
      await reserve({ resourceKeys: ['crash-resource'] });
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/scheduler-child.mjs', import.meta.url))], {
        env: { ...process.env, MAYURA_SCHEDULER_FIXTURE: JSON.stringify({ ...fixture.childOptions, phase }) },
        stdio: ['ignore','pipe','pipe'], windowsHide: true,
      });
      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          let output = '';
          child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.includes('ready\n')) resolve(); });
          child.once('error', () => reject(new Error('Scheduler fixture process could not start.')));
          child.once('exit', () => reject(new Error('Scheduler fixture exited before its durable boundary.')));
          timer = setTimeout(() => reject(new Error('Scheduler fixture did not reach its durable boundary.')), 5_000);
        });
      } finally { if (timer) clearTimeout(timer); child.kill('SIGKILL'); await exited; }
      await pause(1_050);
      const result = await scheduler.recover({ scope: key.scope, limit: 1 });
      expect(result[0]?.state).toBe(phase === 'claim' ? 'ready' : 'outcome_unknown');
      const claims = await scheduler.claim({ scope: key.scope, workerId: 'replacement', limit: 1, leaseMs: 1_000 });
      expect(claims).toHaveLength(phase === 'claim' ? 1 : 0);
      if (phase === 'receipt') expect((await scheduler.read(key))?.receipt?.execution).toBe('succeeded');
    });

    it('samples authority time after waiting for the database job lock', async () => {
      await reserve(); const claim = await claimOne(1_000);
      const held = await fixture.holdJob();
      const checked = expect(scheduler.renew({ claim, leaseMs: 10_000 })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      try { await pause(1_050); } finally { await held.release(); }
      await checked;
      expect((await scheduler.read(key))?.leaseRevoked).toBe(true);
    });
  });
}
