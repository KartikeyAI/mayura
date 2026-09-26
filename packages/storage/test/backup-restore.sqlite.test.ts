import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupSqliteStore, createSqliteStore, restoreSqliteBackup } from '@mayura/storage';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const record = (id: string) => ({ scope: 'drill', id, idempotencyKey: id, definitionHash: 'a'.repeat(64), state: { value: id }, events: [{ type: 'created', data: {} }] });

describe('SQLite backup and restore drill', () => {
  it('backs up a live store consistently and restores exactly the backed-up state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mayura-backup-')); directories.push(root);
    const filename = join(root, 'store.sqlite'); const backup = join(root, 'backup.sqlite');
    let store = createSqliteStore({ filename }); await store.initialize();
    await store.create(record('before-backup'));
    // The store is open with committed pages still in its write-ahead log.
    expect(await backupSqliteStore({ filename, destination: backup })).toMatchObject({ destination: backup, schemaVersion: 1 });
    await store.create(record('after-backup'));
    await expect(backupSqliteStore({ filename, destination: backup })).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.close();
    expect(await restoreSqliteBackup({ backup, filename })).toEqual({ schemaVersion: 1 });
    store = createSqliteStore({ filename }); await store.initialize();
    expect((await store.read('drill', 'before-backup'))?.state).toEqual({ value: 'before-backup' });
    expect(await store.read('drill', 'after-backup')).toBeUndefined();
    expect((await store.create(record('after-restore'))).created).toBe(true); await store.close();
  });

  it('refuses corrupt backups and ambiguous paths without touching the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mayura-backup-')); directories.push(root);
    const filename = join(root, 'store.sqlite'); const corrupt = join(root, 'corrupt.sqlite');
    const store = createSqliteStore({ filename }); await store.initialize(); await store.create(record('kept')); await store.close();
    await writeFile(corrupt, 'not a database');
    await expect(restoreSqliteBackup({ backup: corrupt, filename })).rejects.toBeDefined();
    await expect(restoreSqliteBackup({ backup: filename, filename })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(backupSqliteStore({ filename: ':memory:', destination: join(root, 'x.sqlite') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const reopened = createSqliteStore({ filename }); await reopened.initialize();
    expect((await reopened.read('drill', 'kept'))?.state).toEqual({ value: 'kept' }); await reopened.close();
  });
});
