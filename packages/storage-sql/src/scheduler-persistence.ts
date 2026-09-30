import { StorageError } from './contracts.js';
import { loadAggregate, lockRunIdentity, ownedRun } from './aggregate-session.js';
import { advisoryLock, clockSql, insertIfAbsent, rowLock } from './dialect.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';
import type { JobKey } from './scheduler-contracts.js';
import { nextCounter } from './validation.js';

/** A stored job: its queue projection and the authoritative JSON state (`data`), as the state machine reads and writes it. */
export interface SchedulerJobRow {
  scope: string; job_id: string; reservation_key: string; invocation_id: string; run_id: string;
  digest: string; state: string; due_at: number | string; lease_until: number | string | null;
  deadline_at: number | string | null; revoked: number; version: number | string; data: string;
}
export interface SchedulerHeldRow { resource_key: string; fence: number | string; disposition: string }
export interface SchedulerEventRow { sequence: number | string; type: string; data: string; created_at: string }
/** Which jobs a claim or recovery may consider: those of one run (and job) inside a workflow, otherwise every unowned run. */
export interface SchedulerCandidateFilter { readonly scope: string; readonly now: number; readonly runId?: string; readonly jobId?: string }

/**
 * The reads and writes the scheduler state machine makes inside one transaction. Everything that decides what a job
 * may do lives in the state machine; an implementation only stores and finds rows, and locks what it is asked to lock.
 * `lock` on a job read means: hold it until the transaction ends (`'skip'`: or return nothing if another holds it).
 */
export interface SchedulerTransaction {
  /** The store's current time in milliseconds. */
  clock(): Promise<number>;
  /** Serializes reservations for one run identity, even before its aggregate exists. */
  lockRunIdentity(scope: string, runId: string): Promise<void>;
  /** Locks the run's aggregate (aggregate first, then jobs), when it exists. */
  lockAggregate(scope: string, runId: string): Promise<void>;
  /** Whether a scheduled workflow writer owns the run. */
  ownedRun(scope: string, runId: string): Promise<boolean>;
  jobRunId(key: JobKey): Promise<string | undefined>;
  job(key: JobKey, lock: 'none' | 'lock' | 'skip'): Promise<SchedulerJobRow | undefined>;
  /** The job holding a reservation key, locked. */
  jobByReservation(scope: string, reservationKey: string): Promise<SchedulerJobRow | undefined>;
  /** The job's requested resource keys. */
  requests(key: JobKey): Promise<string[]>;
  /** The resources the job holds or has quarantined; ordered by key when `ordered`. */
  held(key: JobKey, ordered: boolean): Promise<SchedulerHeldRow[]>;
  /** Inserts a new job unless its identity (job id, reservation key or invocation id) is taken; true when inserted. */
  insertJob(row: SchedulerJobRow): Promise<boolean>;
  insertRequests(scope: string, jobId: string, resourceKeys: readonly string[]): Promise<void>;
  /** Writes the job's queue projection and state. */
  updateJob(row: SchedulerJobRow): Promise<void>;
  /** Appends one event to the run's scheduler journal, numbering it after the last. */
  appendEvent(scope: string, runId: string, type: string, data: string, createdAt: string): Promise<void>;
  releaseResources(scope: string, jobId: string, fence: number, quarantine: boolean): Promise<void>;
  /** Takes a resource for a job unless another job holds it; true when taken. */
  holdResource(scope: string, resourceKey: string, jobId: string, fence: number): Promise<boolean>;
  /** Whether another leased, started or unknown job requested one of this job's resources. */
  resourceOwnedElsewhere(scope: string, jobId: string): Promise<boolean>;
  /** Up to 128 ready, due, unexpired jobs whose resources are free, in due order. */
  claimCandidates(filter: SchedulerCandidateFilter): Promise<string[]>;
  /** Up to `limit` live jobs whose lease was revoked or expired, or whose deadline passed, in id order. */
  recoverCandidates(filter: SchedulerCandidateFilter & { readonly limit: number }): Promise<string[]>;
  events(scope: string, runId: string, after: number, limit: number): Promise<SchedulerEventRow[]>;
}
export interface SchedulerPersistence {
  initialize(): Promise<void>;
  transaction<T>(body: (tx: SchedulerTransaction) => Promise<T>): Promise<T>;
}

/** The scheduler's rows in the SQL layer's tables: the SQL every SQL adapter has always run for it. */
export function sqlSchedulerTransaction(backend: SchedulerBackend, tx: SchedulerSession): SchedulerTransaction {
  const table = (name: string) => `${backend.prefix}mayura_scheduler_${name}`;
  const lock = (skip = false) => rowLock(backend, skip);
  const scopeFilter = (filter: SchedulerCandidateFilter) => filter.runId !== undefined
    ? { sql: 'AND j.run_id = ?' + (filter.jobId === undefined ? '' : ' AND j.job_id = ?'), values: [filter.runId, ...(filter.jobId === undefined ? [] : [filter.jobId])] }
    : { sql: `AND NOT EXISTS (SELECT 1 FROM ${backend.prefix}mayura_workflow_owners w WHERE w.scope = j.scope AND w.aggregate_id = j.run_id)`, values: [] };
  return {
    clock: async () => Number((await tx.query<{ now_ms: number | string }>(clockSql(backend)))[0]?.now_ms),
    lockRunIdentity: (scope, runId) => lockRunIdentity(tx, backend, scope, runId),
    lockAggregate: async (scope, runId) => { await loadAggregate(tx, backend, scope, runId); },
    ownedRun: (scope, runId) => ownedRun(tx, backend, scope, runId),
    jobRunId: async key => (await tx.query<{ run_id: string }>(`SELECT run_id FROM ${table('jobs')} WHERE scope = ? AND job_id = ?`, [key.scope, key.jobId]))[0]?.run_id,
    job: async (key, locking) => (await tx.query<SchedulerJobRow>(`SELECT * FROM ${table('jobs')} WHERE scope = ? AND job_id = ?${locking === 'none' ? '' : lock(locking === 'skip')}`, [key.scope, key.jobId]))[0],
    jobByReservation: async (scope, reservationKey) => (await tx.query<SchedulerJobRow>(`SELECT * FROM ${table('jobs')} WHERE scope = ? AND reservation_key = ?${lock()}`, [scope, reservationKey]))[0],
    requests: async key => (await tx.query<{ resource_key: string }>(`SELECT resource_key FROM ${table('requests')} WHERE scope = ? AND job_id = ? ORDER BY resource_key`, [key.scope, key.jobId])).map(row => row.resource_key),
    held: async (key, ordered) => [...await tx.query<SchedulerHeldRow>(`SELECT resource_key, fence, disposition FROM ${table('resources')} WHERE scope = ? AND job_id = ?${ordered ? ' ORDER BY resource_key' : ''}`, [key.scope, key.jobId])],
    insertJob: row => insertIfAbsent(tx, backend, `INSERT INTO ${table('jobs')} (scope, job_id, reservation_key, invocation_id, run_id, digest, state, due_at, deadline_at, lease_until, revoked, version, data)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL, 0, 1, ?)`, [row.scope, row.job_id, row.reservation_key, row.invocation_id, row.run_id, row.digest, row.due_at, row.deadline_at, row.data], 'job_id'),
    insertRequests: async (scope, jobId, resourceKeys) => { for (const resource of resourceKeys) await tx.query(`INSERT INTO ${table('requests')} (scope, job_id, resource_key) VALUES (?, ?, ?)`, [scope, jobId, resource]); },
    updateJob: async row => { await tx.query(`UPDATE ${table('jobs')} SET state = ?, lease_until = ?, revoked = ?, version = ?, data = ? WHERE scope = ? AND job_id = ?`, [row.state, row.lease_until, row.revoked, row.version, row.data, row.scope, row.job_id]); },
    appendEvent: async (scope, runId, type, data, createdAt) => {
      await insertIfAbsent(tx, backend, `INSERT INTO ${table('heads')} (scope, run_id, sequence) VALUES (?, ?, 0)`, [scope, runId], 'sequence');
      const rows = await tx.query<{ sequence: number | string }>(`SELECT sequence FROM ${table('heads')} WHERE scope = ? AND run_id = ?${lock()}`, [scope, runId]);
      const current = Number(rows[0]?.sequence); if (!Number.isSafeInteger(current) || current < 0) failure();
      const sequence = nextCounter(current, 1);
      await tx.query(`UPDATE ${table('heads')} SET sequence = ? WHERE scope = ? AND run_id = ?`, [sequence, scope, runId]);
      await tx.query(`INSERT INTO ${table('events')} (scope, run_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [scope, runId, sequence, type, data, createdAt]);
    },
    releaseResources: async (scope, jobId, fence, quarantine) => {
      if (quarantine) await tx.query(`UPDATE ${table('resources')} SET disposition = 'quarantined' WHERE scope = ? AND job_id = ? AND fence = ?`, [scope, jobId, fence]);
      else await tx.query(`DELETE FROM ${table('resources')} WHERE scope = ? AND job_id = ? AND fence = ?`, [scope, jobId, fence]);
    },
    holdResource: (scope, resourceKey, jobId, fence) => insertIfAbsent(tx, backend, `INSERT INTO ${table('resources')} (scope, resource_key, job_id, fence, disposition) VALUES (?, ?, ?, ?, 'held')`, [scope, resourceKey, jobId, fence], 'resource_key'),
    resourceOwnedElsewhere: async (scope, jobId) => (await tx.query<{ job_id: string }>(`SELECT owner.job_id FROM ${table('requests')} wanted
            JOIN ${table('requests')} owned ON owned.scope = wanted.scope AND owned.resource_key = wanted.resource_key
            JOIN ${table('jobs')} owner ON owner.scope = owned.scope AND owner.job_id = owned.job_id
            WHERE wanted.scope = ? AND wanted.job_id = ? AND owner.job_id <> ? AND owner.state IN ('leased','started','outcome_unknown') LIMIT 1`, [scope, jobId, jobId])).length > 0,
    claimCandidates: async filter => {
      const owned = scopeFilter(filter);
      return (await tx.query<{ job_id: string }>(`SELECT j.job_id FROM ${table('jobs')} j WHERE j.scope = ? AND j.state = 'ready' AND j.due_at <= ?
        AND (j.deadline_at IS NULL OR j.deadline_at > ?) AND NOT EXISTS (SELECT 1 FROM ${table('requests')} r JOIN ${table('resources')} h ON h.scope = r.scope AND h.resource_key = r.resource_key WHERE r.scope = j.scope AND r.job_id = j.job_id)
        AND NOT EXISTS (SELECT 1 FROM ${table('requests')} wanted JOIN ${table('requests')} owned ON owned.scope = wanted.scope AND owned.resource_key = wanted.resource_key
          JOIN ${table('jobs')} owner ON owner.scope = owned.scope AND owner.job_id = owned.job_id
          WHERE wanted.scope = j.scope AND wanted.job_id = j.job_id AND owner.job_id <> j.job_id AND owner.state IN ('leased','started','outcome_unknown'))
        ${owned.sql}
        ORDER BY j.due_at, j.job_id LIMIT 128`, [filter.scope, filter.now, filter.now, ...owned.values])).map(row => row.job_id);
    },
    recoverCandidates: async filter => {
      const owned = scopeFilter(filter);
      return (await tx.query<{ job_id: string }>(`SELECT j.job_id FROM ${table('jobs')} j WHERE j.scope = ? AND j.state IN ('ready','leased','started')
        AND (j.revoked = 1 OR j.lease_until <= ? OR j.deadline_at <= ?)
        ${owned.sql}
        ORDER BY j.job_id LIMIT ?`, [filter.scope, filter.now, filter.now, ...owned.values, filter.limit])).map(row => row.job_id);
    },
    events: async (scope, runId, after, limit) => [...await tx.query<SchedulerEventRow>(`SELECT sequence, type, data, created_at FROM ${table('events')} WHERE scope = ? AND run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, [scope, runId, after, limit])],
  };
}

/** The SQL layer's scheduler tables on a backend. */
export function sqlSchedulerPersistence(backend: SchedulerBackend): SchedulerPersistence {
  return {
    transaction: body => backend.transaction(tx => body(sqlSchedulerTransaction(backend, tx))),
    initialize: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:scheduler-schema:${backend.prefix}`);
      const t = (name: string) => `${backend.prefix}mayura_scheduler_${name}`;
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('meta')} (version INTEGER PRIMARY KEY CHECK(version = 1))`);
      await insertIfAbsent(tx, backend, `INSERT INTO ${t('meta')} (version) VALUES (1)`, [], 'version');
      const versions = await tx.query<{ version: number }>(`SELECT version FROM ${t('meta')}`);
      if (versions.length !== 1 || versions[0]?.version !== 1) failure();
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('jobs')} (
        scope TEXT NOT NULL, job_id TEXT NOT NULL, reservation_key TEXT NOT NULL, invocation_id TEXT NOT NULL, run_id TEXT NOT NULL,
        digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','leased','started','succeeded','failed','blocked','cancelled','outcome_unknown')),
        due_at BIGINT NOT NULL CHECK(due_at >= 0), deadline_at BIGINT, lease_until BIGINT,
        revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), version BIGINT NOT NULL CHECK(version > 0), data TEXT NOT NULL,
        PRIMARY KEY(scope, job_id), UNIQUE(scope, reservation_key), UNIQUE(scope, invocation_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('requests')} (scope TEXT NOT NULL, job_id TEXT NOT NULL, resource_key TEXT NOT NULL,
        PRIMARY KEY(scope, job_id, resource_key), FOREIGN KEY(scope, job_id) REFERENCES ${t('jobs')}(scope, job_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('resources')} (scope TEXT NOT NULL, resource_key TEXT NOT NULL, job_id TEXT NOT NULL,
        fence BIGINT NOT NULL CHECK(fence > 0), disposition TEXT NOT NULL CHECK(disposition IN ('held','quarantined')),
        PRIMARY KEY(scope, resource_key), FOREIGN KEY(scope, job_id) REFERENCES ${t('jobs')}(scope, job_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('heads')} (scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence >= 0), PRIMARY KEY(scope, run_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('events')} (scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence > 0),
        type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, run_id, sequence), FOREIGN KEY(scope, run_id) REFERENCES ${t('heads')}(scope, run_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_ready ON ${t('jobs')} (scope, due_at, job_id) WHERE state = 'ready'`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_expired ON ${t('jobs')} (scope, lease_until, job_id) WHERE state IN ('leased','started')`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_deadline ON ${t('jobs')} (scope, deadline_at, job_id) WHERE state IN ('ready','leased','started')`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_held_job ON ${t('resources')} (scope, job_id)`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_requested_resource ON ${t('requests')} (scope, resource_key, job_id)`);
    }),
  };
}

function failure(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored scheduler state failed integrity validation.'); }
