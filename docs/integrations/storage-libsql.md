---
title: "Turso and libSQL storage"
description: "Keep Mayura's workflows, jobs, memory, budgets and API keys in Turso, a sqld server or a local libSQL file with @mayurajs/storage-libsql."
package: "@mayurajs/storage-libsql"
vendor: "Turso"
logo: "turso"
website: "https://turso.tech"
area: "storage"
---

[Turso](https://turso.tech) hosts libSQL, the open-source fork of SQLite. `@mayurajs/storage-libsql` is a Mayura
[store](../guides/storage.md) on libSQL: a Turso database, your own `sqld` server, or a local file. It holds everything
the built-in SQLite and PostgreSQL stores hold: run records and their events (the server's submission journal and run
records), durable workflows with their graphs, trees, waits and discovery, the leased job scheduler, durable budgets,
native memory and [API keys](../guides/authentication.md#api-keys). It talks to libSQL through the official
`@libsql/client`, pinned at 0.18.0, its only dependency. It uses SQLite's SQL and schema, so a local libSQL file and a
`mayura/storage-sqlite` file are interchangeable. Node.js 22.12 or later, or 24.14.1 or later, is supported; on another
runtime, pass a client you create from `@libsql/client/web`.

## Install

```bash
npm install mayura @mayurajs/storage-libsql
```

## Credentials

A Turso database has a URL (`libsql://<db>-<org>.turso.io`) and a database auth token. Create the database and its
token in the [Turso dashboard](https://app.turso.tech), or with `turso db tokens create <db>`. The token needs to read
and write: the store creates its tables and writes to them. A local file and a local `sqld` without authentication need
no token.

The package reads nothing from the environment: pass the URL and token yourself, for example from
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. A token in the URL's query string is refused, so it never lands in logs.

## Use it

```ts
import { createKeyManager } from 'mayura/keys';
import { createNativeMemory } from 'mayura/memory';
import { createLibsqlStore } from '@mayurajs/storage-libsql';

const store = createLibsqlStore({
  url: process.env.TURSO_DATABASE_URL ?? '',
  authToken: process.env.TURSO_AUTH_TOKEN ?? '',
});
await store.initialize();          // creates Mayura's tables when they are missing
await store.memory.initialize();   // native memory keeps its own tables

const memory = createNativeMemory({
  store,
  scope: { principalId: 'customer-42', projectId: 'support' },
  permissions: { allow: ['memory:read', 'memory:write'] },
});
const keys = createKeyManager({ store, prefix: 'acme' });

// Hand `store` to workflow runtimes, durable budgets and your server too; close it when the process shuts down.
await store.close();
```

For local development, use a file: `createLibsqlStore({ url: 'file:./data/app.db' })`. The directory must exist.

To use a client you create yourself, for example one from `@libsql/client/web` on an edge runtime, pass it as
`client`. The store never closes a client you gave it.

```ts
import { createClient } from '@libsql/client/web';
import { createLibsqlStore } from '@mayurajs/storage-libsql';

const client = createClient({ url: 'libsql://my-app-acme.turso.io', authToken: process.env.TURSO_AUTH_TOKEN ?? '' });
const store = createLibsqlStore({ client });
await store.initialize();
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | required, or `client` | `libsql://`, `https://` or `wss://` for a remote database; `http://` or `ws://` only on a loopback address (`localhost`, `127.0.0.1`, `[::1]`); `file:` or `:memory:` for a local database. No user name, password or fragment, and no token in the query string. |
| `authToken` | none | The remote database's token. Give it with `url`; with `client`, give the token to the client instead. |
| `client` | none | A client from `@libsql/client` you create and own, instead of `url`. `store.close()` never closes it. |

Any other option, or both `url` and `client`, fails with `INVALID_INPUT` when you call `createLibsqlStore()`.

## Setup and migrations

`initialize()` creates Mayura's tables when they are missing and checks the schema version. Mayura 1.x uses version 1;
a database at any other version is refused. Run it once per store, before anything else uses the store. Native memory,
durable budgets and the scheduler each have their own `initialize()` too (see
[What uses the store](../guides/storage.md#what-uses-the-store)). Releases that change the layout ship a migration you
run as its own step; see [Migrations](../guides/storage.md#migrations).

A local file keeps SQLite's durability settings: `initialize()` turns on write-ahead logging and a full sync on every
commit, and fails if write-ahead logging cannot be enabled. Foreign keys are enforced. A remote server's durability is
the server's to configure.

## Transactions and concurrency

- Every operation is one write transaction, so a record, its events and the scheduler state it touches change together
  or not at all.
- One store runs its write transactions one at a time, with up to 256 waiting. Beyond that a call fails with
  `QUEUE_FULL`; retry with backoff.
- When another process holds a local file's write lock, the store retries the start of its transaction for up to 5
  seconds, without blocking the event loop. On a remote server the writer waits on the server's side instead: `sqld`
  waits up to 5 seconds, then rolls back the transaction holding the lock.
- Integers are read in libSQL's `number` mode, so a value beyond 2^53 fails instead of being rounded.
- Identifiers are compared byte for byte: keys that differ only in case or accents are different keys.

## Errors

Failures reach you as a `StorageError` with a `storageCode`; messages never contain the driver's text, SQL or your
token. See [Errors](../guides/storage.md#errors) for every code.

| `storageCode` | When |
| --- | --- |
| `INVALID_INPUT` | An option is missing, unknown or malformed, such as an `http://` URL to another host or a token in the URL. |
| `CONFLICT` | A record changed after it was read, or an id or idempotency key already holds other content (a SQLite constraint violation). |
| `QUEUE_FULL` | 256 operations are already waiting for this store. |
| `STORAGE_UNAVAILABLE` | The database stayed locked by another writer, could not be reached, refused the request, or holds an unsupported schema version. |
| `STORE_NOT_INITIALIZED` | A call came before `await store.initialize()`. |
| `STORE_CLOSED` | A call came after `close()`. |

## How it is tested

- The storage, memory and workflow conformance suites that the SQLite and PostgreSQL stores pass run on a local libSQL
  file: records, the key manager, identity integrity, scheduled bounds, memory and native memory, workflows, the
  scheduler, execution waits, durable budgets, scheduled workflows, graphs and graph discovery, with crash tests that
  kill a child process mid-operation and a check that the SQLite adapter can open the same file.
- In CI, with `MAYURA_TEST_LIBSQL_URL` set, the suites run again against a real `sqld` server (the libSQL server Turso
  runs) over the network: records, identity integrity, scheduled bounds, memory and native memory, workflows, the
  scheduler, execution waits and durable budgets, plus the workflow tree suites and a check that foreign keys hold
  inside the server's transactions.
- Unit tests check the durability settings, the URL and token rules, that a client you give is never closed, and that a
  store waits out another process's write lock.
- `scripts/live/storage-libsql.mjs` ran on Turso on October 6, 2026 and passed: it migrated the database, wrote a record
  and its event and read them back, and issued, verified and revoked an API key.

## Related

- [Storage](../guides/storage.md): every store, migrations, backups and errors.
- [MySQL](storage-mysql.md) and [Cloudflare D1](storage-d1.md): other databases for the same store.
- [Authentication](../guides/authentication.md#api-keys): API keys kept in this store.
- [Durable workflows](../guides/durable-workflows.md): what runs on the store.
