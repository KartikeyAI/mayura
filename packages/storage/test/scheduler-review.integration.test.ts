import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore } from '@mayura/storage-sqlite';
import type { Claim, JobReservation, SchedulerAggregateStore } from '@mayura/storage-contracts';

interface Fixture {
  readonly store: SchedulerAggregateStore;
  readonly prefix: string;
  query(sql: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  cleanup(): Promise<void>;
}
const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const key = { scope: 'review-scope', jobId: 'job-a' };
const known = { callId: 'call', toolId: 'tool', execution: 'succeeded', disclosure: 'withheld' } as const;
const candidateHash = 'a'.repeat(64);
const reservation: JobReservation = { ...key, reservationKey: 'reservation-a', runId: 'review-run', nodeId: 'node', invocationId: 'invocation-a',
  definitionHash: 'b'.repeat(64), candidateHash, intent: { callId: 'call', toolId: 'tool' }, resourceKeys: [], delayMs: 0 };

async function sqlite(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-scheduler-review-'));
  const filename = join(directory, 'review.sqlite');
  const store = createSqliteStore({ filename });
  return { store, prefix: '', async query(sql, parameters = []) {
    const database = new Database(filename); database.pragma('foreign_keys = ON');
    try { const statement = database.prepare(sql); if (statement.reader) return statement.all(...parameters) as Record<string, unknown>[];
      statement.run(...parameters); return []; } finally { database.close(); }
  }, async cleanup() {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-scheduler-review-`)) throw new Error('Unexpected fixture path.');
    await rm(directory, { recursive: true, force: true });
  } };
}
async function postgres(): Promise<Fixture> {
  const schema = `mayura_sched_review_${randomUUID().replaceAll('-', '')}`;
  const store = createPostgresStore({ connectionString: connectionString!, schema });
  const pool = new Pool({ connectionString: connectionString!, max: 2 });
  return { store, prefix: `"${schema}".`, async query(sql, parameters = []) {
    let parameter = 0;
    const result = await pool.query(sql.replace(/\?/g, () => `$${++parameter}`), [...parameters]);
    return result.rows as Record<string, unknown>[];
  }, async cleanup() {
    if (!/^mayura_sched_review_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
  } };
}

function review(name: string, factory: () => Promise<Fixture>) {
  describe(name, () => {
    let fixture: Fixture;
    beforeEach(async () => { fixture = await factory(); await fixture.store.initialize(); await fixture.store.scheduler.initialize(); });
    afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); });
    const table = (name: string) => `${fixture.prefix}mayura_scheduler_${name}`;
    const reserve = (overrides: Partial<JobReservation> = {}) => fixture.store.scheduler.reserve({ ...reservation, ...overrides });
    const claim = async (): Promise<Claim> => (await fixture.store.scheduler.claim({ scope: key.scope, workerId: 'worker', limit: 1, leaseMs: 30_000 }))[0]!.claim;
    const start = async (overrides: Partial<JobReservation> = {}): Promise<Claim> => {
      await reserve(overrides); const ownership = await claim();
      expect((await fixture.store.scheduler.start({ claim: ownership, candidateHash })).status).toBe('started'); return ownership;
    };
    const complete = async (): Promise<Claim> => {
      const ownership = await start();
      await fixture.store.scheduler.recordReceipt({ ...key, fence: ownership.fence, evidenceId: 'known', receipt: known });
      await fixture.store.scheduler.complete({ claim: ownership, commandId: 'complete', evidenceId: 'known', outcome: 'succeeded', output: { admitted: true } });
      return ownership;
    };
    // Fault injection is deliberately outside the public API and confined to a disposable database.
    const corrupt = async (mutate: (data: JsonObject) => void): Promise<void> => {
      const rows = await fixture.query(`SELECT data FROM ${table('jobs')} WHERE scope = ? AND job_id = ?`, [key.scope, key.jobId]);
      const data = JSON.parse(rows[0]!['data'] as string) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
      await fixture.query(`UPDATE ${table('jobs')} SET data = ?, state = ?, due_at = ?, deadline_at = ?, lease_until = ?, revoked = ?, version = ? WHERE scope = ? AND job_id = ?`,
        [JSON.stringify(data), job['state'], job['dueAtMs'], job['deadlineAtMs'], job['leaseUntilMs'], Number(job['leaseRevoked']), job['version'], key.scope, key.jobId]);
    };

    it('rejects a removed original deadline even when authoritative JSON and queue columns agree', async () => {
      await reserve({ deadlineAfterMs: 30_000 });
      await corrupt(data => { (data['job'] as JsonObject)['deadlineAtMs'] = null; });
      await expect(fixture.store.scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('rejects a deadline moved relative to its original due/deadline interval', async () => {
      await reserve({ delayMs: 1_000, deadlineAfterMs: 30_000 });
      await corrupt(data => { const job = data['job'] as JsonObject; job['deadlineAtMs'] = (job['deadlineAtMs'] as number) + 1_000; });
      await expect(fixture.store.scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('rejects a failed job projection backed only by successful execution evidence', async () => {
      await complete();
      await corrupt(data => { const job = data['job'] as JsonObject; job['state'] = 'failed'; job['output'] = null; (job['receipt'] as JsonObject)['disclosure'] = 'withheld'; });
      await expect(fixture.store.scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('rejects duplicate committed journal versions that no public transition can produce', async () => {
      await reserve(); await fixture.store.scheduler.cancel({ ...key, commandId: 'cancel-one' }); await fixture.store.scheduler.cancel({ ...key, commandId: 'cancel-two' });
      await corrupt(data => { const commands = data['commands'] as JsonObject[]; commands[1]!['version'] = commands[0]!['version']!; });
      await expect(fixture.store.scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('does not disclose a completed output after its successful command journal was removed', async () => {
      await complete(); await corrupt(data => { data['commands'] = []; });
      await expect(fixture.store.scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('fails closed when an active execution has lost a declared resource hold', async () => {
      await start({ resourceKeys: ['shared-resource'] });
      await fixture.query(`DELETE FROM ${table('resources')} WHERE scope = ? AND job_id = ?`, [key.scope, key.jobId]);
      await expect(fixture.store.scheduler.read(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('does not admit overlapping work after an unresolved holder row is lost', async () => {
      const ownership = await start({ resourceKeys: ['shared-resource'] });
      await fixture.store.scheduler.recordReceipt({ ...key, fence: ownership.fence, evidenceId: 'unknown', receipt: { ...known, execution: 'unknown' } });
      await reserve({ jobId: 'job-b', reservationKey: 'reservation-b', invocationId: 'invocation-b', resourceKeys: ['shared-resource'] });
      await fixture.query(`DELETE FROM ${table('resources')} WHERE scope = ? AND job_id = ?`, [key.scope, key.jobId]);
      const result = await Promise.allSettled([fixture.store.scheduler.claim({ scope: key.scope, workerId: 'other', limit: 1, leaseMs: 1_000 })]);
      const answer = result[0]!;
      if (answer.status === 'fulfilled') expect(answer.value).toEqual([]);
      else expect(answer.reason).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it.each([
      ['data', JSON.stringify({ jobId: key.jobId, fence: 0, state: 'ready', secret: 'PRIVATE_EVENT_SECRET' })],
      ['type', 'untrusted.provider.event'],
      ['created_at', 'PRIVATE_TIMESTAMP'],
    ] as const)('rejects corrupted public event %s rather than returning unsafe metadata', async (column, replacement) => {
      await reserve();
      await fixture.query(`UPDATE ${table('events')} SET ${column} = ? WHERE scope = ? AND run_id = ?`, [replacement, key.scope, reservation.runId]);
      await expect(fixture.store.scheduler.events({ scope: key.scope, runId: reservation.runId })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('keeps unrelated work eligible behind more than a candidate page of resource-blocked jobs', async () => {
      const ownership = await start({ resourceKeys: ['shared-resource'] });
      await fixture.store.scheduler.cancel({ ...key, commandId: 'cancel-started' });
      for (let index = 0; index < 129; index++) await reserve({ jobId: `blocked-${index}`, reservationKey: `reservation-${index}`, invocationId: `invocation-${index}`, resourceKeys: ['shared-resource'] });
      await reserve({ jobId: 'free-job', reservationKey: 'free-reservation', invocationId: 'free-invocation' });
      const claims = await fixture.store.scheduler.claim({ scope: key.scope, workerId: 'other', limit: 1, leaseMs: 1_000 });
      expect(claims.map(item => item.job.jobId)).toEqual(['free-job']);
      expect((await fixture.store.scheduler.read(key))?.fence).toBe(ownership.fence);
    });

    it('returns a valid bounded event page larger than one MiB after JSON identifier escaping', async () => {
      const jobId = `${'\u0001'.repeat(250)}-job`;
      await reserve({ jobId }); const ownership = await claim();
      for (let index = 0; index < 700; index++) await fixture.store.scheduler.renew({ claim: ownership, leaseMs: 300_000 });
      const page = await fixture.store.scheduler.events({ scope: key.scope, runId: reservation.runId, limit: 1_000 });
      expect(page).toHaveLength(702); expect(page.at(-1)?.sequence).toBe(702);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(1_048_576);
      expect(Object.isFrozen(page)).toBe(true); expect(Object.isFrozen(page[0]?.data)).toBe(true);
    });

    it('returns every committed recovery result when a valid bounded batch exceeds one MiB', async () => {
      const resourceKeys = Array.from({ length: 24 }, (_, index) => `resource-${index}-`.padEnd(250, 'x'));
      const intent = { callId: 'call', toolId: 'tool', metadata: 'x'.repeat(3_800) };
      for (let index = 0; index < 128; index++) await reserve({ jobId: `recover-${index}`, reservationKey: `recover-reservation-${index}`,
        invocationId: `recover-invocation-${index}`, intent, resourceKeys, deadlineAfterMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 5));
      const recovered = await fixture.store.scheduler.recover({ scope: key.scope, limit: 128 });
      expect(recovered).toHaveLength(128); expect(recovered.every(job => job.state === 'cancelled')).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(recovered))).toBeGreaterThan(1_048_576);
      expect(await fixture.store.scheduler.recover({ scope: key.scope, limit: 128 })).toEqual([]);
    });

    it('does not turn late success into output admission or release quarantined resources', async () => {
      const ownership = await start({ resourceKeys: ['shared-resource'] }); await fixture.store.scheduler.cancel({ ...key, commandId: 'cancel' });
      const result = await fixture.store.scheduler.recordReceipt({ ...key, fence: ownership.fence, evidenceId: 'late-known', receipt: known });
      expect(result.disposition).toBe('late'); expect(result.job.state).toBe('outcome_unknown'); expect(result.job.output).toBeNull();
      expect(await fixture.store.scheduler.receipts({ ...key, fence: ownership.fence })).toMatchObject([{ receipt: known, disposition: 'late' }]);
      await expect(fixture.store.scheduler.complete({ claim: ownership, commandId: 'late-complete', evidenceId: 'late-known', outcome: 'succeeded', output: 'PRIVATE' })).rejects.toMatchObject({ code: 'CONFLICT', storageCode: 'STALE_CLAIM' });
      const holds = await fixture.query(`SELECT disposition, fence FROM ${table('resources')} WHERE scope = ? AND job_id = ?`, [key.scope, key.jobId]);
      expect(holds).toHaveLength(1); expect(holds[0]!['disposition']).toBe('quarantined'); expect(Number(holds[0]!['fence'])).toBe(ownership.fence);
    });

    it('enforces resource and event foreign keys in the actual database', async () => {
      await expect(fixture.query(`INSERT INTO ${table('resources')} (scope, resource_key, job_id, fence, disposition) VALUES (?, ?, ?, ?, ?)`, ['missing', 'resource', 'missing', 1, 'held'])).rejects.toBeDefined();
      await expect(fixture.query(`INSERT INTO ${table('events')} (scope, run_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`, ['missing', 'missing', 1, 'job.reserved', '{}', new Date().toISOString()])).rejects.toBeDefined();
    });
  });
}

review('SQLite scheduler independent review', sqlite);
describe.skipIf(!connectionString)('PostgreSQL configured review fixture', () => review('PostgreSQL scheduler independent review', postgres));
