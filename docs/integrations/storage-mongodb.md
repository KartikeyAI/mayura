---
title: "MongoDB storage"
description: "Keep Mayura's workflows, jobs, memory, budgets and API keys in a MongoDB replica set or Atlas cluster with @mayurajs/storage-mongodb."
package: "@mayurajs/storage-mongodb"
vendor: "MongoDB"
logo: "mongodb"
website: "https://www.mongodb.com"
area: "storage"
---

[MongoDB](https://www.mongodb.com) is a document database, self-hosted or hosted as MongoDB Atlas.
`@mayurajs/storage-mongodb` is a Mayura [store](../guides/storage.md) on MongoDB. It holds everything the SQL stores
hold: run records and their events (the server's submission journal and run records), durable workflows with their
graphs, trees, waits and discovery, the leased job scheduler, durable budgets, native memory and
[API keys](../guides/authentication.md#api-keys). The workflow state machines are the SQL stores' own, run over MongoDB
documents. It talks to MongoDB through the official `mongodb` driver, pinned at 7.7.0, its only dependency. The driver
opens TCP connections, so use it on Node.js (22.12 or later, or 24.14.1 or later).

## Install

```bash
npm install mayura @mayurajs/storage-mongodb
```

## Credentials

The store takes a `mongodb://` or `mongodb+srv://` connection string for a replica set or sharded cluster: multi-document
transactions need one, and a single-node replica set is enough. On [Atlas](https://cloud.mongodb.com), create a
database user under **Database Access**, allow your servers' addresses under **Network Access**, and copy the
connection string from **Connect**. The user needs to read and write the database you give, and to create its
collections and indexes.

The package reads nothing from the environment: pass the connection string yourself, for example from `MONGODB_URL`,
and keep it in your secret configuration.

## Use it

```ts
import { createNativeMemory } from 'mayura/memory';
import { createMongoStore } from '@mayurajs/storage-mongodb';

const store = createMongoStore({ uri: process.env.MONGODB_URL ?? '', database: 'mayura' });
await store.initialize();          // connects and creates Mayura's indexes
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

To share a `MongoClient` with the rest of your application, pass it as `client` instead of `uri`. The store never
closes a client you gave it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `uri` | required, or `client` | A `mongodb://` or `mongodb+srv://` URL of a replica set or sharded cluster. |
| `database` | required | The database that holds Mayura's collections: letters, digits, `_` and `-`, at most 63 characters. |
| `client` | none | A `MongoClient` you create and own, instead of `uri`. |

With `uri`, the store's own client keeps up to 8 connections, waits up to 5 seconds to select a server or connect, and
keeps the driver's retryable writes on. Any other option, or both `uri` and `client`, fails with `INVALID_INPUT` when you
call `createMongoStore()`.

## Setup and migrations

`initialize()` connects and creates the indexes the store relies on: unique indexes on a record's id and idempotency
key, on an event's sequence, and on workflow ownership. Creating the same index twice changes nothing, so several
instances can start at once. Native memory, durable budgets and the scheduler each have their own `initialize()` (see
[What uses the store](../guides/storage.md#what-uses-the-store)). Collections are named `mayura_*`. See
[Migrations](../guides/storage.md#migrations) for how layout changes ship.

## Transactions and concurrency

- Every write is one multi-document transaction with snapshot reads, majority write concern, reads from the primary
  and a 10 second commit limit, so a record and its events, or a budget and its journal, change together or not at all.
- Writers that touch the same document conflict, and the driver runs the losing transaction again.
- If a process dies mid-transaction, the server keeps the transaction open until it aborts it
  (`transactionLifetimeLimitSeconds`, 60 seconds by default); until then, writes to the documents it touched wait.
- State and event data are stored as the exact JSON text given, so keys MongoDB would restrict, such as `$set` or
  `a.b`, come back unchanged.
- Scheduler leases are measured on the server's clock, so every worker agrees on when a lease ends.
- Memory search ranks with BM25 inside the database, so only the top hits leave it.
- Ids are compared exactly: keys that differ only in case, accents or trailing spaces are different keys.

## Errors

Failures reach you as a `StorageError` with a `storageCode`; messages never contain the driver's text or your
connection string. See [Errors](../guides/storage.md#errors) for every code.

| `storageCode` | When |
| --- | --- |
| `INVALID_INPUT` | An option is missing, unknown or malformed, such as a database name with spaces or a `client` that is not a `MongoClient`. |
| `CONFLICT` | A record changed after it was read, or an id or idempotency key already holds other content (duplicate key). |
| `STORAGE_UNAVAILABLE` | MongoDB could not be reached, refused the request, or a stored document failed its integrity check. |
| `STORE_NOT_INITIALIZED` | A call came before `await store.initialize()`, or native memory was used before `store.memory.initialize()`. |
| `STORE_CLOSED` | A call came after `close()`. |

## How it is tested

- In CI, against a single-node MongoDB replica set in a container (`MAYURA_TEST_MONGODB_URL`), each fixture in a
  database of its own: every storage, memory and workflow conformance suite the SQL stores pass, including crash tests
  that kill a process mid-transaction. The test server aborts abandoned transactions after 5 seconds so crash tests
  recover in time.
- The suites cover records, the key manager, identity integrity, scheduled bounds, memory and native memory,
  workflows, scheduled workflows, graphs, graph discovery and coordination, workflow trees, the scheduler, execution
  waits and durable budgets. Further tests check that tree discovery uses its index, that ids stay exact, that state
  keys such as `$set` and `a.b` round-trip, and that a client you give is never closed.
- `scripts/live/storage-mongodb.mjs` checks the store against Atlas, but it has not run successfully against Atlas yet.

## Related

- [Storage](../guides/storage.md#mongodb): the MongoDB section of the storage guide.
- [MySQL](storage-mysql.md) and [DynamoDB](storage-dynamodb.md): other databases for the same store.
- [Memory and context](../guides/memory-and-context.md): native memory on this store.
- [Durable workflows](../guides/durable-workflows.md): what runs on the store.
