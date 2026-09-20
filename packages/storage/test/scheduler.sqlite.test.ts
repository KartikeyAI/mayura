import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { JsonObject } from '@mayura/core';
import { createSqliteStore } from '../dist/index.js';
import { schedulerConformance } from './scheduler-conformance.js';

schedulerConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-scheduler-'));
  const filename = join(directory, 'scheduler.sqlite'); const open = () => createSqliteStore({ filename });
  return { store: open(), reopen: open, childOptions: { adapter: 'sqlite', filename }, holdJob: async () => {
    const database = new Database(filename); database.exec('BEGIN IMMEDIATE');
    return { release: async () => { try { database.exec('ROLLBACK'); } finally { database.close(); } } };
  }, corruptJob: async mutate => {
    const database = new Database(filename);
    try {
      const row = database.prepare('SELECT data FROM mayura_scheduler_jobs WHERE scope = ? AND job_id = ?').get('scheduler-a', 'job-a') as { data: string };
      const data = JSON.parse(row.data) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
      database.prepare('UPDATE mayura_scheduler_jobs SET data = ?, state = ?, lease_until = ? WHERE scope = ? AND job_id = ?').run(JSON.stringify(data), job['state'], job['leaseUntilMs'], 'scheduler-a', 'job-a');
    } finally { database.close(); }
  }, cleanup: async () => {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}mayura-scheduler-`)) throw new Error('Unexpected scheduler fixture path.');
    await rm(directory, { recursive: true, force: true });
  } };
});
