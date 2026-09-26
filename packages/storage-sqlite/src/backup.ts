import { copyFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { StorageError } from '@mayura/storage-contracts';

export interface SqliteBackupReport { readonly destination: string; readonly schemaVersion: number; readonly pages: number }

const persistent = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value === ':memory:' || value.includes('\0')) throw new StorageError('INVALID_INPUT', `A persistent SQLite ${label} path is required.`);
  return value;
};
/** Open a file read-only and require a clean integrity check and the supported schema version. */
function verify(filename: string): number {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new StorageError('STORAGE_UNAVAILABLE', 'The SQLite backup failed integrity validation.');
    const versions = database.prepare('SELECT version FROM mayura_storage_meta').pluck().all();
    if (versions.length !== 1 || versions[0] !== 1) throw new StorageError('CONFLICT', 'The SQLite backup is not at the supported schema version.');
    return database.pragma('page_count', { simple: true }) as number;
  } catch (error) { if (error instanceof StorageError) throw error; throw new StorageError('STORAGE_UNAVAILABLE', 'The SQLite backup could not be verified.'); }
  finally { database.close(); }
}

/**
 * Take a consistent online backup of a live store through SQLite's backup API, from a separate read-only
 * connection, then verify the copy. The destination must not exist.
 */
export async function backupSqliteStore(options: { readonly filename: string; readonly destination: string }): Promise<SqliteBackupReport> {
  const filename = persistent(options?.filename, 'store'); const destination = persistent(options?.destination, 'backup');
  if (existsSync(destination)) throw new StorageError('CONFLICT', 'The SQLite backup destination already exists.');
  const source = new Database(filename, { readonly: true, fileMustExist: true });
  try { await source.backup(destination); }
  catch { await rm(destination, { force: true }); throw new StorageError('STORAGE_UNAVAILABLE', 'The SQLite backup did not complete.'); }
  finally { source.close(); }
  try { return Object.freeze({ destination, schemaVersion: 1, pages: verify(destination) }); }
  catch (error) { await rm(destination, { force: true }); throw error; }
}

/**
 * Replace a stopped store with a verified backup. Every process using the store must be stopped first: the
 * target's write-ahead log is discarded so that no newer uncommitted pages can be replayed over the restored state.
 */
export async function restoreSqliteBackup(options: { readonly backup: string; readonly filename: string }): Promise<{ readonly schemaVersion: number }> {
  const backup = persistent(options?.backup, 'backup'); const filename = persistent(options?.filename, 'store');
  if (backup === filename) throw new StorageError('INVALID_INPUT', 'A backup cannot be restored over itself.');
  verify(backup);
  const staging = `${filename}.restore-${process.pid}-${Date.now()}`;
  try {
    await copyFile(backup, staging); verify(staging);
    for (const suffix of ['-wal', '-shm']) await rm(`${filename}${suffix}`, { force: true });
    await rename(staging, filename);
  } catch (error) {
    await rm(staging, { force: true });
    if (error instanceof StorageError) throw error;
    throw new StorageError('STORAGE_UNAVAILABLE', 'The SQLite restore did not complete; stop every process using the store and retry.');
  }
  return Object.freeze({ schemaVersion: 1 });
}
