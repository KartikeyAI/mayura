import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPostgresStore, createSqliteStore } from '@mayura/storage';

export interface MemoryFixture { readonly store: ReturnType<typeof createSqliteStore>; reopen(): ReturnType<typeof createSqliteStore>; cleanup(): Promise<void> }
export async function sqliteFixture(): Promise<MemoryFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-memory-')); const filename = join(directory, 'memory.sqlite');
  const open = () => createSqliteStore({ filename });
  return { store: open(), reopen: open, cleanup: async () => {
    const safe = resolve(directory); const prefix = `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}mayura-memory-`;
    if (!safe.startsWith(prefix)) throw new Error('Unexpected memory fixture directory.');
    await rm(safe, { recursive: true, force: true });
  } };
}
export async function postgresFixture(connectionString: string): Promise<MemoryFixture> {
  const schema = `mayura_memory_test_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema });
  return { store: open(), reopen: open, cleanup: async () => {
    if (!/^mayura_memory_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected memory fixture schema.');
    const { Pool } = await import('pg'); const pool = new Pool({ connectionString });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
  } };
}
