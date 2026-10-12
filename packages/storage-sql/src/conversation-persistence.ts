import { advisoryLock, binaryCollation, clockSql } from './dialect.js';
import { lockSql } from './aggregate-session.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

/** A thread as stored: JSON fields as text, times in milliseconds. */
export interface ThreadRow {
  scope: string; id: string; version: number | string; status: string; agent_id: string | null; title: string | null; metadata: string;
  created_at_ms: number | string; updated_at_ms: number | string; entry_count: number | string; last_sequence: number | string;
  lease_run_id: string | null; lease_holder_id: string | null; lease_expires_at_ms: number | string | null;
}
export interface ThreadEntryRow { sequence: number | string; run_id: string; kind: string; data: string; created_at_ms: number | string }
export interface CheckpointRow {
  run_id: string; scope: string; version: number | string; status: string; holder_id: string | null; lease_expires_at_ms: number | string | null;
  created_at_ms: number | string; updated_at_ms: number | string; expires_at_ms: number | string; parts: number | string;
}

/** The reads and writes the conversation reducer makes inside one transaction. */
export interface ConversationTransaction {
  /** The store's current time in milliseconds. */
  clock(): Promise<number>;
  /** Serializes one thread, even before its row exists. */
  lockThread(scope: string, id: string): Promise<void>;
  /** The thread's row, locked until the transaction ends. */
  thread(scope: string, id: string): Promise<ThreadRow | undefined>;
  insertThread(row: ThreadRow): Promise<void>;
  /** Replaces the thread's row; `previous` is the row it replaces, for stores that keep their own indexes. */
  updateThread(row: ThreadRow, previous: ThreadRow): Promise<void>;
  /** A scope's threads with these statuses, newest `updated_at_ms` first (then `id` descending), strictly below `before`. */
  listThreads(scope: string, statuses: readonly string[], before: readonly [number, string] | undefined, limit: number): Promise<ThreadRow[]>;
  insertEntries(scope: string, threadId: string, rows: readonly ThreadEntryRow[]): Promise<void>;
  /** Entries in sequence order: after `after`, or the newest ones below `before`. */
  entries(scope: string, threadId: string, range: { after?: number; before?: number }, limit: number): Promise<ThreadEntryRow[]>;
  /** Removes up to `limit` of the thread's oldest entries; returns how many. */
  deleteEntries(scope: string, threadId: string, limit: number): Promise<number>;
  /** Active or archived threads last updated before `idleBeforeMs`, oldest first. */
  idleThreads(idleBeforeMs: number, limit: number): Promise<{ scope: string; id: string }[]>;

  /** Serializes one checkpoint, even before its row exists. */
  lockCheckpoint(runId: string): Promise<void>;
  checkpoint(runId: string): Promise<CheckpointRow | undefined>;
  /** The checkpoint body's parts, in order. */
  checkpointParts(runId: string): Promise<string[]>;
  insertCheckpoint(row: CheckpointRow, parts: readonly string[]): Promise<void>;
  /** Replaces the row, and the body's parts when `parts` is given. */
  updateCheckpoint(row: CheckpointRow, parts: readonly string[] | undefined, previous: CheckpointRow): Promise<void>;
  deleteCheckpoint(row: CheckpointRow): Promise<void>;
  /** Waiting checkpoints that expired before `expiresBeforeMs`, earliest first. */
  dueCheckpoints(expiresBeforeMs: number, limit: number): Promise<string[]>;
}
export interface ConversationPersistence {
  initialize(): Promise<void>;
  transaction<T>(body: (tx: ConversationTransaction) => Promise<T>): Promise<T>;
}

/** The conversation tables of the SQL layer (SQLite, PostgreSQL, libSQL, MySQL). */
export function sqlConversationPersistence(backend: SchedulerBackend): ConversationPersistence {
  const t = (name: string) => `${backend.prefix}mayura_${name}`;
  // An index lives in its table's schema: PostgreSQL and MySQL take its name unqualified.
  const i = (name: string) => `${backend.dialect === 'sqlite' ? backend.prefix : ''}mayura_${name}`;
  const big = backend.dialect === 'sqlite' ? 'INTEGER' : 'BIGINT';
  // Ids are ASCII; byte order is the order the contract checks, whatever the database's default collation.
  const byId = `id COLLATE ${binaryCollation(backend)}`;
  const threadColumns = 'scope,id,version,status,agent_id,title,metadata,created_at_ms,updated_at_ms,entry_count,last_sequence,lease_run_id,lease_holder_id,lease_expires_at_ms';
  const threadValues = (row: ThreadRow) => [row.scope, row.id, row.version, row.status, row.agent_id, row.title, row.metadata, row.created_at_ms, row.updated_at_ms,
    row.entry_count, row.last_sequence, row.lease_run_id, row.lease_holder_id, row.lease_expires_at_ms];
  const checkpointColumns = 'run_id,scope,version,status,holder_id,lease_expires_at_ms,created_at_ms,updated_at_ms,expires_at_ms,parts';
  const checkpointValues = (row: CheckpointRow) => [row.run_id, row.scope, row.version, row.status, row.holder_id, row.lease_expires_at_ms, row.created_at_ms,
    row.updated_at_ms, row.expires_at_ms, row.parts];
  const transaction = (tx: SchedulerSession): ConversationTransaction => ({
    clock: async () => Number((await tx.query<{ now_ms: number | string }>(clockSql(backend)))[0]?.now_ms),
    lockThread: (scope, id) => advisoryLock(tx, backend, JSON.stringify(['mayura:thread:v1', backend.prefix, scope, id])),
    thread: async (scope, id) => (await tx.query<ThreadRow>(`SELECT ${threadColumns} FROM ${t('threads')} WHERE scope = ? AND id = ?${lockSql(backend)}`, [scope, id]))[0],
    insertThread: async row => { await tx.query(`INSERT INTO ${t('threads')} (${threadColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, threadValues(row)); },
    updateThread: async row => {
      await tx.query(`UPDATE ${t('threads')} SET version = ?,status = ?,agent_id = ?,title = ?,metadata = ?,updated_at_ms = ?,entry_count = ?,last_sequence = ?,
        lease_run_id = ?,lease_holder_id = ?,lease_expires_at_ms = ? WHERE scope = ? AND id = ?`,
      [row.version, row.status, row.agent_id, row.title, row.metadata, row.updated_at_ms, row.entry_count, row.last_sequence, row.lease_run_id,
        row.lease_holder_id, row.lease_expires_at_ms, row.scope, row.id]);
    },
    listThreads: async (scope, statuses, before, limit) => {
      const marks = statuses.map(() => '?').join(',');
      const page = before ? ` AND (updated_at_ms < ? OR (updated_at_ms = ? AND ${byId} < ?))` : '';
      return [...await tx.query<ThreadRow>(`SELECT ${threadColumns} FROM ${t('threads')} WHERE scope = ? AND status IN (${marks})${page}
        ORDER BY updated_at_ms DESC, ${byId} DESC LIMIT ?`, [scope, ...statuses, ...(before ? [before[0], before[0], before[1]] : []), limit])];
    },
    insertEntries: async (scope, threadId, rows) => {
      for (const row of rows) {
        await tx.query(`INSERT INTO ${t('thread_entries')} (scope,thread_id,sequence,run_id,kind,data,created_at_ms) VALUES (?,?,?,?,?,?,?)`,
          [scope, threadId, row.sequence, row.run_id, row.kind, row.data, row.created_at_ms]);
      }
    },
    entries: async (scope, threadId, range, limit) => {
      const columns = 'sequence,run_id,kind,data,created_at_ms';
      if (range.before !== undefined) {
        const newest = await tx.query<ThreadEntryRow>(`SELECT ${columns} FROM ${t('thread_entries')} WHERE scope = ? AND thread_id = ? AND sequence < ?
          ORDER BY sequence DESC LIMIT ?`, [scope, threadId, range.before, limit]);
        return [...newest].reverse();
      }
      return [...await tx.query<ThreadEntryRow>(`SELECT ${columns} FROM ${t('thread_entries')} WHERE scope = ? AND thread_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?`, [scope, threadId, range.after ?? 0, limit])];
    },
    deleteEntries: async (scope, threadId, limit) => {
      const oldest = await tx.query<{ sequence: number | string }>(`SELECT sequence FROM ${t('thread_entries')} WHERE scope = ? AND thread_id = ? ORDER BY sequence LIMIT ?`,
        [scope, threadId, limit]);
      if (!oldest.length) return 0;
      const last = oldest[oldest.length - 1]!.sequence;
      await tx.query(`DELETE FROM ${t('thread_entries')} WHERE scope = ? AND thread_id = ? AND sequence <= ?`, [scope, threadId, last]);
      return oldest.length;
    },
    idleThreads: async (idleBeforeMs, limit) => [...await tx.query<{ scope: string; id: string }>(`SELECT scope,id FROM ${t('threads')}
      WHERE status IN ('active','archived') AND updated_at_ms < ? ORDER BY updated_at_ms, scope, id LIMIT ?`, [idleBeforeMs, limit])],

    lockCheckpoint: runId => advisoryLock(tx, backend, JSON.stringify(['mayura:run-checkpoint:v1', backend.prefix, runId])),
    checkpoint: async runId => (await tx.query<CheckpointRow>(`SELECT ${checkpointColumns} FROM ${t('run_checkpoints')} WHERE run_id = ?${lockSql(backend)}`, [runId]))[0],
    checkpointParts: async runId => (await tx.query<{ data: string }>(`SELECT data FROM ${t('run_checkpoint_parts')} WHERE run_id = ? ORDER BY part`, [runId])).map(row => row.data),
    insertCheckpoint: async (row, parts) => {
      await tx.query(`INSERT INTO ${t('run_checkpoints')} (${checkpointColumns}) VALUES (?,?,?,?,?,?,?,?,?,?)`, checkpointValues(row));
      for (const [part, data] of parts.entries()) await tx.query(`INSERT INTO ${t('run_checkpoint_parts')} (run_id,part,data) VALUES (?,?,?)`, [row.run_id, part, data]);
    },
    updateCheckpoint: async (row, parts) => {
      await tx.query(`UPDATE ${t('run_checkpoints')} SET version = ?,status = ?,holder_id = ?,lease_expires_at_ms = ?,updated_at_ms = ?,parts = ? WHERE run_id = ?`,
        [row.version, row.status, row.holder_id, row.lease_expires_at_ms, row.updated_at_ms, row.parts, row.run_id]);
      if (!parts) return;
      await tx.query(`DELETE FROM ${t('run_checkpoint_parts')} WHERE run_id = ?`, [row.run_id]);
      for (const [part, data] of parts.entries()) await tx.query(`INSERT INTO ${t('run_checkpoint_parts')} (run_id,part,data) VALUES (?,?,?)`, [row.run_id, part, data]);
    },
    deleteCheckpoint: async row => {
      await tx.query(`DELETE FROM ${t('run_checkpoint_parts')} WHERE run_id = ?`, [row.run_id]);
      await tx.query(`DELETE FROM ${t('run_checkpoints')} WHERE run_id = ?`, [row.run_id]);
    },
    dueCheckpoints: async (expiresBeforeMs, limit) => (await tx.query<{ run_id: string }>(`SELECT run_id FROM ${t('run_checkpoints')}
      WHERE status = 'waiting' AND expires_at_ms < ? ORDER BY expires_at_ms, run_id LIMIT ?`, [expiresBeforeMs, limit])).map(row => row.run_id),
  });
  return {
    transaction: body => backend.transaction(tx => body(transaction(tx))),
    initialize: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:conversation-schema:${backend.prefix}`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('threads')} (
        scope TEXT NOT NULL, id TEXT NOT NULL, version ${big} NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','archived','deleting','deleted')),
        agent_id TEXT, title TEXT, metadata TEXT NOT NULL, created_at_ms ${big} NOT NULL, updated_at_ms ${big} NOT NULL,
        entry_count ${big} NOT NULL, last_sequence ${big} NOT NULL, lease_run_id TEXT, lease_holder_id TEXT, lease_expires_at_ms ${big},
        PRIMARY KEY(scope, id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${i('threads_recent')} ON ${t('threads')} (scope, updated_at_ms, id)`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${i('threads_idle')} ON ${t('threads')} (status, updated_at_ms)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('thread_entries')} (
        scope TEXT NOT NULL, thread_id TEXT NOT NULL, sequence ${big} NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
        created_at_ms ${big} NOT NULL, PRIMARY KEY(scope, thread_id, sequence))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('run_checkpoints')} (
        run_id TEXT NOT NULL, scope TEXT NOT NULL, version ${big} NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','claimed')),
        holder_id TEXT, lease_expires_at_ms ${big}, created_at_ms ${big} NOT NULL, updated_at_ms ${big} NOT NULL, expires_at_ms ${big} NOT NULL,
        parts INTEGER NOT NULL, PRIMARY KEY(run_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${i('run_checkpoints_due')} ON ${t('run_checkpoints')} (status, expires_at_ms)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('run_checkpoint_parts')} (
        run_id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, part))`);
    }),
  };
}
