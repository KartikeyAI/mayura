// The storage, memory and workflow conformance suites that PostgreSQL and SQLite pass, run against libSQL on a local
// file. Fixtures that expose a database file are the SQLite ones with their store swapped for libSQL on the same
// file (a libSQL database is a SQLite file), keeping their fault hooks. Crash tests' child processes open the file
// with libSQL too, except the cross-version compatibility suite, whose children are the SQLite adapter's versions.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createClient } from '@libsql/client';
import { expect, it } from 'vitest';
import type { JsonObject } from 'mayura';
import { createLibsqlStore, type LibsqlStore } from '../src/index.js';
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { durableBudgetSqliteFixture } from '../../../packages/storage/test/durable-budget-fixtures.js';
import { executionWaitConformance } from '../../../packages/storage/test/execution-waits-conformance.js';
import { executionWaitSqliteFixture } from '../../../packages/storage/test/execution-waits-fixtures.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../../packages/storage/test/scheduled-bounds-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { selectedAdapterCompatibility } from '../../../packages/storage/test/selected-adapters-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';
import { graphWorkflowConformance } from '../../../packages/workflows/test/graph-conformance.js';
import { graphDiscoveryConformance } from '../../../packages/workflows/test/graph-discovery-conformance.js';
import { graphSqliteFixture } from '../../../packages/workflows/test/graph-fixtures.js';
import { scheduledWorkflowConformance } from '../../../packages/workflows/test/scheduled-conformance.js';
import { scheduledSqliteFixture } from '../../../packages/workflows/test/scheduled-fixtures.js';

/**
 * The native libSQL driver releases a closed database's file only when its statements are garbage-collected. Linux
 * and macOS remove an open file anyway; Windows refuses, so on Windows a fixture collects garbage before removing it.
 */
const collect: () => void = process.platform === 'win32' ? (setFlagsFromString('--expose_gc'), runInNewContext('gc') as () => void) : () => undefined;
const url = (filename: string) => `file:${filename.split(sep).join('/')}`;
const opener = (filename: string) => () => createLibsqlStore({ url: url(filename) });

/** A fresh database file in its own temporary directory, removed afterwards. */
async function database(prefix: string): Promise<{ filename: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), `mayura-libsql-${prefix}-`));
  return { filename: join(directory, 'store.db'), cleanup: async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-libsql-${prefix}-`)) throw new Error('Unexpected fixture path.');
    collect(); await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } };
}
/** A SQLite fixture with its store replaced by libSQL on the same file; its fault hooks are unchanged. */
async function onLibsql<F extends { store: { close(): Promise<void> }; cleanup(): Promise<void> }>(base: F, filename: string): Promise<F & { store: LibsqlStore; reopen(): LibsqlStore }> {
  await base.store.close();
  const open = opener(filename);
  return { ...base, store: open(), reopen: open, cleanup: async () => { collect(); await base.cleanup(); } };
}
const simple = (prefix: string) => async () => {
  const { filename, cleanup } = await database(prefix);
  const open = opener(filename);
  return { store: open(), reopen: open, cleanup };
};

aggregateConformance('libSQL', simple('aggregate'));
identityIntegrityConformance('libSQL', simple('identity'));
scheduledBounds('libSQL', simple('bounds'));
memoryConformance('libSQL', simple('memory') as never);
nativeMemoryConformance('libSQL', simple('native-memory'));
workflowConformance('libSQL', simple('workflows'));

schedulerConformance('libSQL', async () => {
  const { filename, cleanup } = await database('scheduler');
  const open = opener(filename);
  return { store: open(), reopen: open, cleanup, childOptions: { adapter: 'libsql', url: url(filename) },
    holdJob: async () => {
      const client = createClient({ url: url(filename) }); const tx = await client.transaction('write');
      return { release: async () => { try { await tx.rollback(); } finally { tx.close(); client.close(); } } };
    },
    corruptJob: async mutate => {
      const client = createClient({ url: url(filename) });
      try {
        const row = (await client.execute({ sql: 'SELECT data FROM mayura_scheduler_jobs WHERE scope = ? AND job_id = ?', args: ['scheduler-a', 'job-a'] })).rows[0]!;
        const data = JSON.parse(String(row['data'])) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
        await client.execute({ sql: 'UPDATE mayura_scheduler_jobs SET data = ?, state = ?, lease_until = ? WHERE scope = ? AND job_id = ?',
          args: [JSON.stringify(data), job['state'] as string, job['leaseUntilMs'] as number, 'scheduler-a', 'job-a'] });
      } finally { client.close(); }
    } };
});
/** Crash-test children that open the same file with libSQL. */
const libsqlChildren = <F extends { childOptions: unknown }>(fixture: F, filename: string): F => ({ ...fixture, childOptions: { adapter: 'libsql', url: url(filename) } as never });
executionWaitConformance('libSQL', async () => { const base = await executionWaitSqliteFixture(); const filename = (base.childOptions as { filename: string }).filename; return libsqlChildren(await onLibsql(base, filename), filename); });
selectedAdapterCompatibility('libSQL', async () => { const base = await executionWaitSqliteFixture(); return onLibsql(base, (base.childOptions as { filename: string }).filename); });
durableBudgetConformance('libSQL', async () => { const base = await durableBudgetSqliteFixture(); const filename = (base.childOptions as { filename: string }).filename; return libsqlChildren(await onLibsql(base, filename), filename); });
scheduledWorkflowConformance('libSQL', async () => { const base = await scheduledSqliteFixture(); return onLibsql(base, (base.childConfig as { filename: string }).filename) as never; });
graphWorkflowConformance('libSQL', async () => { const base = await graphSqliteFixture(); return onLibsql(base, (base.childConfig as { filename: string }).filename) as never; });
graphDiscoveryConformance('libSQL', async () => { const base = await graphSqliteFixture(); return onLibsql(base, (base.childConfig as { filename: string }).filename) as never; });

it('keeps a local file durable: write-ahead logging, full sync and foreign keys', async () => {
  const { filename, cleanup } = await database('durability');
  const store = opener(filename)(); await store.initialize(); await store.close();
  const client = createClient({ url: url(filename) });
  try {
    const tx = await client.transaction('write');
    const value = async (pragma: string) => (await tx.execute(`PRAGMA ${pragma}`)).rows[0]![0];
    expect([await value('journal_mode'), await value('synchronous'), await value('foreign_keys')]).toEqual(['wal', 2, 1]);
    await tx.rollback(); tx.close();
  } finally { client.close(); await cleanup(); }
});

it('refuses options it cannot use, and a token or plain http to anything but a loopback address', () => {
  for (const options of [{}, { url: '' }, { url: 'file:x', client: {} }, { url: 'postgres://db.example/x' }, { url: 'http://db.example' }, { url: 'ws://db.example' },
    { url: 'https://user:pass@db.example' }, { url: 'libsql://db.example?authToken=secret' }, { url: 'libsql://db.example', authToken: '' }, { url: 'libsql://db.example', authToken: 'a\nb' },
    { client: {} }, { client: createClient({ url: ':memory:' }), authToken: 't' }, { url: 'file:x', extra: 1 }]) {
    expect(() => createLibsqlStore(options as never)).toThrow(expect.objectContaining({ storageCode: 'INVALID_INPUT' }));
  }
  for (const url of ['libsql://db.example', 'https://db.example', 'wss://db.example', 'http://127.0.0.1:8080', 'http://localhost:8080', 'ws://[::1]:8080']) {
    expect(() => createLibsqlStore({ url })).not.toThrow();
  }
});

it('uses a client you give without closing it', async () => {
  const { filename, cleanup } = await database('given');
  const client = createClient({ url: url(filename) });
  try {
    const store = createLibsqlStore({ client }); await store.initialize();
    await store.create({ scope: 's', id: 'r', idempotencyKey: 'k', definitionHash: 'h', state: {}, events: [] });
    await store.close();
    expect((await client.execute('SELECT count(*) FROM mayura_aggregates')).rows[0]![0]).toBe(1);
  } finally { client.close(); await cleanup(); }
});

it('waits for another process\'s write lock, and replaces the connection the driver leaves unusable after it', async () => {
  // The driver leaves a BEGIN that found the file locked unfinished on its connection, which then can never commit.
  const { filename, cleanup } = await database('busy');
  const store = opener(filename)(); await store.initialize();
  const other = createClient({ url: url(filename) });
  try {
    for (let round = 0; round < 3; round++) {
      const held = await other.transaction('write');
      setTimeout(() => { void held.rollback().then(() => held.close()); }, 150);
      await store.create({ scope: 's', id: `r-${round}`, idempotencyKey: `k-${round}`, definitionHash: 'h', state: {}, events: [{ type: 'run.created', data: {} }] });
      await store.update({ scope: 's', id: `r-${round}`, expectedVersion: 1, state: { round }, events: [] });
    }
    expect((await store.read('s', 'r-2'))?.version).toBe(2);
  } finally { other.close(); await store.close(); await cleanup(); }
});
