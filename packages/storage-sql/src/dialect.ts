import { sha256Hex } from '@mayura/core/host';
import { StorageError } from '@mayura/storage-contracts';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

/**
 * The SQL that differs between the dialects the SQL layer supports. SQLite serializes writers database-wide, so it
 * needs neither row locks nor advisory locks; PostgreSQL and MySQL lock rows with FOR UPDATE and take a named lock
 * for work that has no row to lock yet.
 */
export function rowLock(backend: SchedulerBackend, skip = false): string {
  return backend.dialect === 'sqlite' ? '' : ` FOR UPDATE${skip ? ' SKIP LOCKED' : ''}`;
}

/**
 * A lock on `key` until the transaction ends. MySQL's named locks belong to the connection, so a MySQL backend
 * releases every one when its transaction commits or rolls back.
 */
export async function advisoryLock(tx: SchedulerSession, backend: SchedulerBackend, key: string): Promise<void> {
  if (backend.dialect === 'postgres') { await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [key]); return; }
  if (backend.dialect === 'mysql') {
    // A MySQL lock name is at most 64 characters.
    const held = await tx.query<{ held: number | string | null }>('SELECT GET_LOCK(?, 10) AS held', [`mayura:${sha256Hex(key).slice(0, 57)}`]);
    if (Number(held[0]?.held) !== 1) throw new StorageError('CONFLICT', 'Another writer holds this storage lock; retry with bounded backoff.');
  }
}

/** The database's current time in milliseconds, read when the statement runs. */
export function clockSql(backend: SchedulerBackend): string {
  if (backend.dialect === 'postgres') return 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms';
  if (backend.dialect === 'mysql') return 'SELECT CAST(FLOOR(UNIX_TIMESTAMP(SYSDATE(3)) * 1000) AS SIGNED) AS now_ms';
  return "SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms";
}

/** A collation that compares text byte by byte (code point order), without padding. */
export function binaryCollation(backend: SchedulerBackend): string {
  return backend.dialect === 'postgres' ? '"C"' : backend.dialect === 'mysql' ? 'utf8mb4_0900_bin' : 'BINARY';
}

/**
 * Runs `insert` (an INSERT ... VALUES statement without a conflict clause) unless a unique key already holds the row,
 * and says whether it inserted. `noop` is a column MySQL sets to itself on a duplicate: MySQL has no ON CONFLICT DO
 * NOTHING, and INSERT IGNORE would also hide other errors. A MySQL backend's connections report a duplicate left
 * unchanged as no affected row (no CLIENT_FOUND_ROWS).
 */
export async function insertIfAbsent(tx: SchedulerSession, backend: SchedulerBackend, insert: string, parameters: readonly unknown[], noop: string, conflict = ''): Promise<boolean> {
  if (backend.dialect === 'mysql') {
    await tx.query(`${insert} ON DUPLICATE KEY UPDATE ${noop} = ${noop}`, parameters);
    const changed = await tx.query<{ changed: number | string }>('SELECT ROW_COUNT() AS changed');
    return Number(changed[0]?.changed) === 1;
  }
  return (await tx.query(`${insert} ON CONFLICT ${conflict}DO NOTHING RETURNING 1 AS inserted`, parameters)).length > 0;
}

/**
 * Runs `update` and returns the rows `select` then reads, in the same transaction. PostgreSQL and SQLite return them
 * from the UPDATE itself; MySQL has no RETURNING, and the updated rows are already locked by the UPDATE.
 */
export async function updateReturning<T>(tx: SchedulerSession, backend: SchedulerBackend, update: string, parameters: readonly unknown[],
  returning: string, select: string, selectParameters: readonly unknown[]): Promise<readonly T[]> {
  if (backend.dialect !== 'mysql') return tx.query<T>(`${update} RETURNING ${returning}`, parameters);
  await tx.query(update, parameters);
  return tx.query<T>(select, selectParameters);
}
