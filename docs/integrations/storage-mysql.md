---
title: "MySQL storage"
description: "Keep Mayura's workflows, jobs, memory, budgets and API keys in MySQL 8.0.19 or later with @mayurajs/storage-mysql, through mysql2."
package: "@mayurajs/storage-mysql"
vendor: "MySQL"
logo: "mysql"
website: "https://www.mysql.com"
area: "storage"
---

[MySQL](https://www.mysql.com) is the open-source relational database, offered hosted by most clouds.
`@mayurajs/storage-mysql` is a Mayura [store](../guides/storage.md) on MySQL 8.0.19 or later with InnoDB, with the same
SQL layer as the SQLite and PostgreSQL stores. It holds run records and their events (the server's submission journal
and run records), durable workflows with their graphs, trees, waits and discovery, the leased job scheduler, durable
budgets, native memory and [API keys](../guides/authentication.md#api-keys). It talks to MySQL through `mysql2`, pinned
at 3.24.4, its only dependency. `mysql2` opens TCP connections, so use it on Node.js (22.12 or later, or 24.14.1 or
later).

## Install

```bash
npm install mayura @mayurajs/storage-mysql
```

## Credentials

The store takes a `mysql://user:password@host:port/database` URL. Create the database and a user for it in your MySQL
host's console. The database holds Mayura's tables, so the user needs, on that database: `SELECT`, `INSERT`, `UPDATE`,
`DELETE`, `CREATE`, `INDEX` and `REFERENCES` (the events table has a foreign key), and `CREATE TEMPORARY TABLES`, which
`initialize()` uses for a one-off check of the connection's settings.

The package reads nothing from the environment: pass the URL yourself, for example from `MYSQL_URL`, and keep it in your
secret configuration. Most hosted MySQL needs `tls: true`.

## Use it

```ts
import { createNativeMemory } from 'mayura/memory';
import { createMysqlStore } from '@mayurajs/storage-mysql';

const store = createMysqlStore({ uri: process.env.MYSQL_URL ?? '', tls: true, pool: { max: 8 } });
await store.initialize();          // creates Mayura's tables when they are missing
await store.memory.initialize();
await store.durableBudgets.initialize();

const memory = createNativeMemory({
  store,
  scope: { principalId: 'customer-42', projectId: 'support' },
  permissions: { allow: ['memory:read', 'memory:write'] },
});

// Hand `store` to workflow runtimes, the key manager and your server too; close it when the process shuts down.
await store.close();
```

To share a `mysql2/promise` pool with the rest of your application, pass it as `driver`. Create it with
`flags: ['-FOUND_ROWS']`: `mysql2` sets `CLIENT_FOUND_ROWS` by default, which makes a duplicate write look like an
insert, and `initialize()` refuses such a pool. The store never ends a pool you gave it.

```ts
import { createPool } from 'mysql2/promise';
import { createMysqlStore } from '@mayurajs/storage-mysql';

const pool = createPool({ uri: process.env.MYSQL_URL, connectionLimit: 4, flags: ['-FOUND_ROWS'] });
const store = createMysqlStore({ driver: pool });
await store.initialize();
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `uri` | required, or `driver` | A `mysql://` URL naming a host and a database (letters, digits, `_` and `$`, at most 64 characters). |
| `tls` | off | `true` requires TLS and verifies the server's certificate; `{ ca }` verifies it against your CA. |
| `pool.max` | 8 | The most connections, from 1 to 100. |
| `pool.connectionTimeoutMs` | 5,000 | How long to wait to connect, from 100 to 120,000 ms. |
| `pool.idleTimeoutMs` | 10,000 | When an idle connection is closed, from 100 to 3,600,000 ms. |
| `driver` | none | A `mysql2/promise` pool you create and own, instead of `uri`. `tls` and `pool` go to that pool, not here. |

The store's own pool queues up to 256 requests for a connection. Any other option, or both `uri` and `driver`, fails
with `INVALID_INPUT` when you call `createMysqlStore()`.

## Setup and migrations

`initialize()` checks that the server is MySQL 8.0.19 or later, checks that the pool does not report found rows, then
creates Mayura's tables when they are missing and checks the schema version (version 1 for Mayura 1.x). MySQL commits
before any change to a table's definition, so `initialize()` creates the tables under a named lock rather than in one
transaction; every step can safely run again, and several instances can start at once. See
[Migrations](../guides/storage.md#migrations) for how layout changes ship.

Tables use InnoDB and `utf8mb4` compared by code point (`utf8mb4_0900_bin`). Identifier columns are `VARBINARY(256)`,
so ids are at most 256 bytes of UTF-8, and keys that differ only in case, accents or trailing spaces stay different
keys, as on SQLite and PostgreSQL. State and event data are `LONGTEXT`.

## Transactions and concurrency

- Every operation is one transaction at `READ COMMITTED`, with strict SQL mode, UTC and a 5 second lock wait.
- Rows are locked with `FOR UPDATE`. Work that has no row to lock yet takes a named lock (`GET_LOCK`), released when
  the operation ends.
- A deadlock, or a lock not taken within 5 seconds, rolls the transaction back and reports `CONFLICT`: retry with
  backoff.
- Event times come from the server's clock.

## Errors

Failures reach you as a `StorageError` with a `storageCode`; messages never contain the driver's text, SQL or your
credentials. See [Errors](../guides/storage.md#errors) for every code.

| `storageCode` | When |
| --- | --- |
| `INVALID_INPUT` | An option is missing, unknown or malformed, or `initialize()` found a pool that reports found rows. |
| `CONFLICT` | A record changed after it was read, an id or idempotency key already holds other content (duplicate key), or a deadlock or lock wait timeout. |
| `STORAGE_UNAVAILABLE` | The server is older than 8.0.19, could not be reached, refused the request, or holds an unsupported schema version. |
| `STORE_NOT_INITIALIZED` | A call came before `await store.initialize()`. |
| `STORE_CLOSED` | A call came after `close()`. |

## How it is tested

- In CI, against a MySQL 8.4 container (`MAYURA_TEST_MYSQL_URL`), each fixture in a database of its own: every
  storage, memory and workflow conformance suite the SQL stores pass, including crash tests that kill a process
  mid-transaction. That is records, the key manager, identity integrity, scheduled bounds, memory and native memory,
  workflows, scheduled workflows, graphs, graph discovery and coordination, workflow trees, the scheduler, execution
  waits and durable budgets.
- Tests check that a pool reporting found rows is refused, that malformed options are refused, and that ids differing
  only in case, accents or trailing spaces stay separate records.
- It has not been run against a hosted MySQL account yet.

## Related

- [Storage](../guides/storage.md#mysql): the MySQL section of the storage guide.
- [Turso and libSQL](storage-libsql.md) and [MongoDB](storage-mongodb.md): other databases for the same store.
- [Durable workflows](../guides/durable-workflows.md): what runs on the store.
- [Deployment](../guides/deployment.md): running servers and workers against one database.
