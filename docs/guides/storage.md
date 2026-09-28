---
title: "Storage"
description: "Persist durable workflows, memory, budgets and jobs in SQLite or PostgreSQL, run migrations, and back the store up."
---

Agents and ephemeral runs need no database. You add storage when something has to survive a restart: durable
workflows, native memory, durable budgets, scheduled jobs and the server's submission journal. One store object holds
all of them. Mayura ships two adapters, SQLite and PostgreSQL, with the same API and the same on-disk format version, so
you can develop on SQLite and deploy on PostgreSQL without changing application code.

```ts
import { createSqliteStore } from 'mayura/storage-sqlite';

const store = createSqliteStore({ filename: './data/app.sqlite' });
await store.initialize();
try {
  // Hand `store` to workflow runtimes, memory, budgets and your server.
} finally {
  await store.close();
}
```

Creating a store is synchronous and opens nothing. `initialize()` connects, creates Mayura's tables if they are
missing and checks the schema version; call it once before anything uses the store. `close()` is yours to call when the
process shuts down. Runtimes and memory that receive the store never close it for you.

## Choose a database

| You need | Import | Install alongside `mayura` |
| --- | --- | --- |
| SQLite: local development, tests, a single host | `mayura/storage-sqlite` | `better-sqlite3` |
| PostgreSQL: several servers and workers sharing state | `mayura/storage-postgres` | `pg` |
| Both factories from one import (existing apps) | `mayura/storage` | `better-sqlite3` and `pg` |
| Your own adapter, types and `StorageError` only | `mayura/storage-contracts` | nothing |

The database drivers are optional peer dependencies: install only the one you use.

```bash
npm install mayura better-sqlite3
```

## SQLite

`createSqliteStore({ filename })` takes one option, the database file path. The parent directory must already exist.
The store runs the database on its own worker thread, uses write-ahead logging with full synchronization, and queues up
to 256 pending requests; beyond that a call fails with `QUEUE_FULL` and you should retry with backoff.

Use `filename: ':memory:'` for tests and throwaway scripts. Everything disappears when the store closes, and an
in-memory store cannot be backed up.

## PostgreSQL

```ts
import { createPostgresStore } from 'mayura/storage-postgres';

const store = createPostgresStore({ connectionString: process.env.DATABASE_URL ?? '', schema: 'mayura' });
await store.initialize();
```

| Option | Default | Notes |
| --- | --- | --- |
| `connectionString` | required | A standard PostgreSQL connection URL. Keep it in your secret configuration. |
| `schema` | `mayura` | Lowercase identifier, at most 63 characters. All of Mayura's tables live in this schema. |

The adapter keeps a pool of up to 8 connections and sets a 10 second statement timeout and a 5 second lock timeout on
every transaction. `initialize()` takes an advisory lock, so several instances can start at the same time safely. A
schema keeps one application's data apart from another's; it is not an authorization boundary.

## What uses the store

| Feature | How it uses the store | Extra setup |
| --- | --- | --- |
| [Durable workflows](durable-workflows.md) | `createScheduledWorkflowRuntime({ store })` and the lifecycle hosts | None: the runtime creates its tables on first use |
| [Native memory](memory-and-context.md) | `createNativeMemory({ store })` | `await store.memory.initialize()` once |
| [Durable budgets](../concepts/costs-and-budgets.md) | `store.durableBudgets` | `await store.durableBudgets.initialize()` once |
| Scheduled jobs | `store.scheduler`, a low-level leased job queue | `await store.scheduler.initialize()` once |
| [Server](server-and-client.md) submission journal | `createAggregateSubmissionJournal(store)` from `mayura/storage-contracts` | None |
| [Server](server-and-client.md#several-server-replicas) run records, for several server replicas | `createAggregateRunRecords(store)` from `mayura/storage-contracts` | None |

A typical application opens one store and shares it:

```ts
import { createNativeMemory } from 'mayura/memory';
import { createSqliteStore } from 'mayura/storage-sqlite';

const store = createSqliteStore({ filename: './data/app.sqlite' });
await store.initialize();
// Native memory keeps its own tables; create them after the base schema.
await store.memory.initialize();

const memory = createNativeMemory({
  store,
  scope: { principalId: 'customer-42', projectId: 'support' },
  permissions: { allow: ['memory:read', 'memory:write'] },
});
```

Workflow runtimes and memory take a scope (a principal and a project), so one store can serve many users and
projects.

## Migrations

Every store records a schema version. Version 1 is the baseline for Mayura 1.x. Both adapters refuse to open a store at
any other version, so an older release can never write into a newer layout, and upgrading the package never rewrites
your data by itself. A release that changes the layout ships an explicit, one-way migration that you run as its own
deployment step, before any new server or worker starts.

Your application module owns that step. `mayura serve`, `mayura worker` and `mayura migrate` all load the same module,
which default-exports its entry points:

```ts
import { defineMayuraApplication } from 'mayura/cli';
import { createPostgresStore } from 'mayura/storage-postgres';

const store = createPostgresStore({ connectionString: process.env.DATABASE_URL ?? '' });
let ready: Promise<void> | undefined;
const open = () => (ready ??= store.initialize());

export default defineMayuraApplication({
  // Bring the store to the version this release needs and return a JSON report.
  async migrate() { await open(); return { schemaVersion: 1 }; },
  async shutdown() { await store.close(); },
});
```

```bash
npx mayura migrate --app ./dist/app.js
```

The CLI calls `migrate()` once, reports its result, then calls `shutdown()`. Nothing else starts. Take and verify a
backup before migrating: migrations cannot be reversed. See [CLI: serve, worker and migrate](../cli/run.md) for the
server and worker entry points.

Workflow runs are a separate concern from the storage layout. Changing a workflow definition needs its own migration
policy; see [workflow operations](workflow-operations.md).

## Back up and restore

### SQLite

`backupSqliteStore` copies a live store through SQLite's online backup API from a separate read-only connection. The
copy is consistent while the application keeps writing, and it is checked (integrity and schema version) before the call
succeeds. The destination must not exist yet.

```ts
import { backupSqliteStore, restoreSqliteBackup } from 'mayura/storage-sqlite';

const report = await backupSqliteStore({ filename: '/data/app.sqlite', destination: '/backups/app-2026-09-28.sqlite' });
console.log(report.pages, report.schemaVersion);

// Later, with every process that uses the store stopped:
await restoreSqliteBackup({ backup: '/backups/app-2026-09-28.sqlite', filename: '/data/app.sqlite' });
```

Stop every process that uses the store before you restore. The restore verifies the backup again, discards the
target's write-ahead log so no newer pages can replay over the restored state, and atomically replaces the file.

### PostgreSQL

Each store lives in one schema, so back it up with a custom-format dump of that schema and restore it with
`pg_restore`. `pg_dump` takes a consistent snapshot without stopping the application.

```bash
pg_dump -Fc -n mayura -f mayura.dump "$DATABASE_URL"
createdb mayura_restored
pg_restore --exit-on-error -d mayura_restored mayura.dump
```

Point the application at the restored database, run `mayura migrate`, then start servers and workers.

After any restore, work that happened after the backup is missing from the store. If a run had external effects in
that window (sent an email, charged a card), reconcile them from the external system rather than replaying the run.
Test your restores on a schedule: a backup you have never restored is not a backup yet.

## Errors

Stores throw `StorageError`, which is a `MayuraError`: one `catch (error) { if (error instanceof MayuraError) ... }`
handles storage and workflow failures alike. `code` is the general code every Mayura API uses, and `storageCode` names
the exact storage condition. Messages never contain driver text, SQL or credentials.

| `storageCode` | `code` | What happened, and what to do |
|---|---|---|
| `CONFLICT` | `CONFLICT` | The record changed after it was read, or an id or idempotency key already holds other content. Read it again and retry, or use a new key. |
| `NOT_FOUND` | `NOT_FOUND` | No such record in this scope. |
| `INVALID_INPUT` | `INVALID_INPUT` | The command was malformed or out of bounds. |
| `STORE_NOT_INITIALIZED` | `INVALID_CONFIG` | Call `await store.initialize()` before using the store. |
| `STORE_CLOSED` | `STORAGE_UNAVAILABLE` | The store was closed. Open a new one. |
| `QUEUE_FULL`, `LIMIT_EXCEEDED` | `LIMIT_EXCEEDED` | Too much at once. Retry with backoff. |
| `STALE_CLAIM` | `CONFLICT` | A worker's lease on a job expired or moved to another worker. |
| `SCHEDULED_WRITER_REQUIRED` | `CONFLICT` | The run belongs to its scheduled workflow writer; change it through that runtime. |
| `STORAGE_UNAVAILABLE` | `STORAGE_UNAVAILABLE` | The database could not confirm the operation. Check the run before retrying anything with effects. |

```ts
import { MayuraError } from 'mayura';
import { isStorageError } from 'mayura/storage-contracts';

try {
  await store.initialize();
} catch (error) {
  if (isStorageError(error, 'STORAGE_UNAVAILABLE')) {
    // The database is unreachable.
  } else if (error instanceof MayuraError) {
    console.error(error.code, error.message);
  }
  throw error;
}
```

Workflow runtimes keep these codes. They report a race they lost as `CONFLICT` (read the run and retry), pass a closed,
uninitialized or busy store through unchanged, and report any other storage failure as `STORAGE_UNAVAILABLE`, telling
you to inspect the run before retrying.

## Custom adapters

`mayura/storage-contracts` holds the driver-free contracts: the `AggregateStore` interface (`initialize`, `create`,
`read`, `update`, `events`, `close`, optional `migrate`), the per-feature capability interfaces, their validators and
`StorageError`. Import types and `StorageError` from here when your code should not depend on a specific database. An
adapter throws `new StorageError(storageCode, message)` with one of the storage codes above.

A new adapter must implement every capability the features you use rely on (durable workflows need the scheduler and
workflow capabilities, native memory needs `memory`), with the same transactional guarantees. That is a substantial
piece of work. For another SQL database, start from the shared SQL engine in `mayura/storage-sql/host`, which both
built-in adapters use.

## The both-adapter facade

`mayura/storage` re-exports `createSqliteStore`, `createPostgresStore`, the SQLite backup helpers and everything in
`mayura/storage-contracts`. It exists for applications written before the adapters were split and requires both
drivers to be installed. New applications should import the one adapter they use. Switching imports needs no data
migration: the same file or schema works with either import.

## Good to know

- Storage methods are application APIs. Never expose them directly to a model or an untrusted client.
- If a SQLite worker stops unexpectedly, pending calls fail with `STORAGE_UNAVAILABLE`. Reopen the store and check any
  writes whose result you did not see.
- Calls after `close()` fail with `storageCode` `STORE_CLOSED`; calls before `initialize()` fail with
  `STORE_NOT_INITIALIZED`.

## Related

- [Durable workflows](durable-workflows.md)
- [Memory and context](memory-and-context.md)
- [Deployment](deployment.md)
- [CLI: serve, worker and migrate](../cli/run.md)
