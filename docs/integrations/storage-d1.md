---
title: "Cloudflare D1 storage"
description: "Keep Mayura's workflows, jobs, memory, budgets and API keys in Cloudflare D1 from a Worker with @mayurajs/storage-d1."
package: "@mayurajs/storage-d1"
vendor: "Cloudflare"
logo: "cloudflare"
website: "https://developers.cloudflare.com/d1/"
area: "storage"
---

[Cloudflare D1](https://developers.cloudflare.com/d1/) is Cloudflare's serverless SQLite database, reached from a
Worker through a binding. `@mayurajs/storage-d1` is a Mayura [store](../guides/storage.md) on D1. It holds everything
the SQL stores hold: run records and their events (the server's submission journal and run records), durable workflows
with their graphs, trees, waits and discovery, the leased job scheduler, durable budgets, native memory and
[API keys](../guides/authentication.md#api-keys). It has no dependencies and no driver: it calls the D1 binding your
Worker receives (`env.DB`), so it runs inside a Cloudflare Worker, where that binding exists.

## Install

```bash
npm install mayura @mayurajs/storage-d1
```

## Credentials

The binding is the credential: there is no key, token or URL to pass. Create a database in the
[Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/workers/d1) or with `wrangler d1 create`, then bind it
to your Worker in its Wrangler configuration:

```toml
[[d1_databases]]
binding = "DB"
database_name = "mayura"
database_id = "<your database id>"
```

The package reads nothing from the environment.

## Use it

```ts
import { createKeyManager } from 'mayura/keys';
import { createD1Store, type D1Database } from '@mayurajs/storage-d1';

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const store = createD1Store({ database: env.DB });
    await store.initialize();

    // Check the caller's API key against the keys kept in D1.
    const keys = createKeyManager({ store, prefix: 'acme' });
    const presented = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
    const verified = await keys.verify(presented);
    return new Response(verified.ok ? 'ok' : 'unauthorized', { status: verified.ok ? 200 : 401 });
  },
};
```

`D1Database` is the part of the binding the store uses, typed by shape, so you need no Workers types for it.
Native memory, durable budgets and the scheduler each have their own `initialize()` (see
[What uses the store](../guides/storage.md#what-uses-the-store)).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `database` | required | The D1 binding from your Worker's environment, such as `env.DB`. |
| `table` | `mayura_documents` | The table that holds Mayura's documents: letters, digits and `_`, starting with a letter or `_`, at most 63 characters. |
| `retryForMs` | 30,000 | How long a transaction keeps running again after conflicts before it fails, from 0 to 600,000 ms. |

Any other option fails with `INVALID_INPUT` when you call `createD1Store()`.

## Setup and migrations

`initialize()` creates the one table the store needs (`mayura_documents`, or your `table`) when it is missing: a
`WITHOUT ROWID` table keyed by partition and sort key, with a version and a JSON body per document. Each feature's own
`initialize()` only marks it ready, since documents need no further schema. See
[Migrations](../guides/storage.md#migrations) for how layout changes ship.

## Transactions and concurrency

D1 has no interactive transactions: it commits a `batch()` of statements as one SQLite transaction, all or nothing. The
store runs Mayura's state machines as optimistic transactions over it:

- A transaction reads with plain queries and holds its writes. Reads of several keys go in one batch, so they see one
  moment.
- It commits one batch: first a guard per document it read or locked, which fails the whole batch if that document's
  version changed, then its writes.
- If a guard fails, the transaction runs again with fresh reads after a short random pause, for up to `retryForMs`.
  Two writers of one record never both succeed.
- Leases and deadlines use D1's clock, measured again every second, so every Worker agrees on when a lease ends.

Every call is a round trip to the database and a transaction makes several, so place your Worker near its database.
Under heavy contention on one record, transactions run again rather than wait; different records never contend.
Memory search scans a scope's term index and ranks it in your Worker, so it grows with the number of records in the
scope. See [D1 and DynamoDB](../guides/storage.md#d1-and-dynamodb).

## Errors

Failures reach you as a `StorageError` with a `storageCode`; messages never contain D1's text. See
[Errors](../guides/storage.md#errors) for every code.

| `storageCode` | When |
| --- | --- |
| `INVALID_INPUT` | The binding is missing or not a D1 binding, the table name is invalid, `retryForMs` is out of range, or an option is unknown. |
| `CONFLICT` | A record changed after it was read, or an id or idempotency key already holds other content. |
| `STORAGE_UNAVAILABLE` | Concurrent writers kept changing the same records for longer than `retryForMs`, D1 failed, or a stored document failed its integrity check. |
| `STORE_NOT_INITIALIZED` | A call came before `await store.initialize()`. |
| `STORE_CLOSED` | A call came after `close()`. |

## How it is tested

- Every storage, memory and workflow conformance suite the SQL stores pass, crash tests included, runs on the store's
  own D1 code over a local SQLite file (D1 is SQLite, and a batch is one transaction): records, the key manager,
  identity integrity, scheduled bounds, memory and native memory, workflows, the scheduler, scheduled workflows,
  graphs, graph discovery and coordination, execution waits, durable budgets and workflow trees.
- On Cloudflare's own D1 implementation, run locally in Miniflare (workerd), a test stores records and events and has
  eight writers race on one record, each landing exactly once.
- `scripts/live/storage-d1.mjs` checks a real D1 database from outside a Worker, with D1's HTTP API standing in for the
  binding: a failing batch rolls back, then the store migrates, writes and reads a record, and issues, verifies and
  revokes an API key. It has not passed against a real account yet.

## Related

- [Storage](../guides/storage.md#d1-and-dynamodb): how D1 and DynamoDB run optimistic transactions.
- [DynamoDB](storage-dynamodb.md): the same document store on Amazon DynamoDB.
- [Cloudflare R2 files](filestorage-r2.md): files from the same Worker.
- [Authentication](../guides/authentication.md#api-keys): API keys kept in this store.
