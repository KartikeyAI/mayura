---
title: "Storage"
description: "Persist durable workflows, memory, budgets and jobs in SQLite, PostgreSQL, libSQL (Turso), MySQL or MongoDB; run migrations, and back the store up."
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
| libSQL: Turso, a `sqld` server, or a local file | `@mayurajs/storage-libsql` | the package itself |
| MySQL 8.0.19 or later | `@mayurajs/storage-mysql` | the package itself |
| A MongoDB replica set or sharded cluster | `@mayurajs/storage-mongodb` | the package itself |
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
| `pool` | see below | `{ max, connectionTimeoutMs, idleTimeoutMs }` for the connection pool. |

The pool keeps up to `max` connections (default 8, at most 100), waits up to `connectionTimeoutMs` for one (default
5,000) and closes one that has been idle for `idleTimeoutMs` (default 10,000). On serverless functions, where each
instance has its own pool, use `pool: { max: 1 }` or `2` and connect through your provider's pooler. Mayura keeps no
session state between transactions: each operation is one transaction, with `SET LOCAL` settings and
transaction-scoped locks only, which is what transaction-mode poolers need.

The adapter sets a 10 second statement timeout and a 5 second lock timeout on every transaction. `initialize()` takes an advisory lock, so several instances can start at the same time safely. A
schema keeps one application's data apart from another's; it is not an authorization boundary.

### A pool you own

`mayura/storage-postgres/driver` runs the same store on a pg-compatible pool that you create: a `pg` Pool that the
rest of your application shares, or, on runtimes without TCP sockets, a driver that connects another way, such as the
WebSocket `Pool` of `@neondatabase/serverless`. This entry point does not import `pg`, so it bundles for any runtime.

```ts
import { Pool } from 'pg';
import { createPostgresStore } from 'mayura/storage-postgres/driver';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const store = createPostgresStore({ driver: pool, schema: 'mayura' });
await store.initialize();
```

| Option | Default | Notes |
| --- | --- | --- |
| `driver` | required | A pool with `connect()`, returning a client with `query()` and `release()`, and `query()`. |
| `schema` | `mayura` | As above. |

The pool is yours: `store.close()` stops the store but never ends the pool, so end it when your application, or your
request, is done with it. The pool must hand out real sessions, because each operation runs as one transaction on a
client from `connect()`; single-query HTTP drivers do not work. The data, the schema and the migrations are the same as
with a connection string, so both entry points can share a database.

## libSQL and Turso

`@mayurajs/storage-libsql` runs the same store on libSQL, the SQLite fork behind Turso: a remote database such as Turso
or your own `sqld` server, or a local file. It uses SQLite's SQL and schema, so a local libSQL file and a
`mayura/storage-sqlite` file are interchangeable.

```bash
npm install mayura @mayurajs/storage-libsql
```

```ts
import { createLibsqlStore } from '@mayurajs/storage-libsql';

const store = createLibsqlStore({ url: 'libsql://my-app.turso.io', authToken: process.env.TURSO_AUTH_TOKEN ?? '' });
await store.initialize();
```

| Option | Notes |
| --- | --- |
| `url` | `libsql://`, `https://` or `wss://` for a remote database; `http://` or `ws://` only on a loopback address, such as a local `sqld`; `file:` for a local file. Give this or `client`. |
| `authToken` | The remote database's token. It is never read from the environment, and a token in the URL is refused. |
| `client` | A client from `@libsql/client` you create and own, for example one from `@libsql/client/web`. `store.close()` never closes it. |

Every operation is one write transaction, so a record, its events and the scheduler state it touches change together
or not at all. A store runs its write transactions one at a time. When another process holds a local file's write
lock, the store retries for up to 5 seconds, waiting without blocking the event loop. A remote server makes the
writer wait on its side instead: `sqld` waits up to 5 seconds, then rolls back the transaction holding the lock.

A local file keeps SQLite's durability settings: write-ahead logging, a full sync on every commit, and foreign keys.
A remote server's durability is the server's to configure.

## MySQL

`@mayurajs/storage-mysql` runs the same store on MySQL 8.0.19 or later (InnoDB), through `mysql2`, with the same SQL
layer as SQLite and PostgreSQL.

```bash
npm install mayura @mayurajs/storage-mysql
```

```ts
import { createMysqlStore } from '@mayurajs/storage-mysql';

const store = createMysqlStore({ uri: process.env.DATABASE_URL ?? '', tls: true });
await store.initialize();
```

| Option | Notes |
| --- | --- |
| `uri` | A `mysql://` URL with the user, password, host, port and database; the database holds Mayura's tables. Keep it in your secret configuration. Give this or `driver`. |
| `tls` | `true` to require TLS and verify the server's certificate, or `{ ca }` to verify it against your CA. Most hosted MySQL needs this. |
| `pool` | `{ max, connectionTimeoutMs, idleTimeoutMs }`, as for PostgreSQL. |
| `driver` | A `mysql2/promise` pool you create and own. It must not set the `CLIENT_FOUND_ROWS` flag, which `mysql2` sets by default: create it with `flags: ['-FOUND_ROWS']`. `initialize()` checks, and `store.close()` never ends it. |

Every operation is one transaction at `READ COMMITTED`, with a 5 second lock wait; rows are locked with `FOR UPDATE`,
and work that has no row to lock yet takes a named lock (`GET_LOCK`), released when the transaction ends. A deadlock or
a lock that could not be taken reports a `CONFLICT` to retry. Identifiers are stored as bytes (`VARBINARY`) and text as
`utf8mb4` compared by code point, so keys that differ only in case, accents or trailing spaces stay different keys, as
on SQLite and PostgreSQL. MySQL commits a transaction before any change to a table's definition, so `initialize()`
creates Mayura's tables under a named lock rather than in one transaction; every step can safely run again.

## MongoDB

`@mayurajs/storage-mongodb` stores aggregates (the records and events the server's submission journal and run records
use), [native memory](memory-and-context.md), durable budgets, the leased job scheduler, and
[durable workflows](durable-workflows.md) with their graphs, trees, waits and discovery in MongoDB, through the
official `mongodb` driver: everything the SQL stores keep.

```bash
npm install mayura @mayurajs/storage-mongodb
```

```ts
import { createMongoStore } from '@mayurajs/storage-mongodb';

const store = createMongoStore({ uri: process.env.MONGODB_URL ?? '', database: 'mayura' });
await store.initialize();
await store.memory.initialize();
```

| Option | Notes |
| --- | --- |
| `uri` | A `mongodb://` or `mongodb+srv://` URL of a replica set or sharded cluster: multi-document transactions need one, and a single-node replica set is enough. Keep it in your secret configuration. Give this or `client`. |
| `database` | The database that holds Mayura's collections. |
| `client` | A `MongoClient` you create and own, instead of `uri`. `store.close()` never closes it. |

Every write is one multi-document transaction with majority write concern, so a record and its events, or a budget and
its journal, change together or not at all. Writers that touch the same document conflict, and the driver runs the
losing transaction again. If a process dies in the middle of a transaction, the server keeps it open until it aborts
it (`transactionLifetimeLimitSeconds`, 60 seconds by default); until then, writes to the documents it touched wait. State
and event data are stored as the exact JSON text given, so keys MongoDB would restrict, such as `$set` or `a.b`, come
back unchanged. Scheduler leases are measured on the server's clock, so every worker agrees on when a lease ends.

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
