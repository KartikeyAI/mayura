# @mayurajs/storage-mongodb

Mayura storage on MongoDB, through the official `mongodb` driver: everything the SQL stores keep.

```bash
npm install mayura @mayurajs/storage-mongodb
```

```ts
import { createMongoStore } from '@mayurajs/storage-mongodb';

const store = createMongoStore({ uri: process.env.MONGODB_URL!, database: 'mayura' });
await store.initialize();
await store.memory.initialize();
```

- Holds aggregates (what the server's submission journal and run records use), native memory, durable budgets, the leased job scheduler, and durable workflows with their graphs, trees, execution waits and discovery, passing the same conformance suites as the SQL stores, including crash tests that kill a process mid-transaction. The workflow state machines are the SQL stores' own, run over MongoDB documents.
- Needs a replica set or sharded cluster, for multi-document transactions (a single-node replica set is enough). Every write is one transaction with majority write concern; the driver retries a transaction that lost a write conflict.
- A process that dies mid-transaction leaves it open until the server aborts it (`transactionLifetimeLimitSeconds`, 60 s by default); writes to the documents it touched wait until then.
- State and event data are stored as exact JSON text, so keys such as `$set` or `a.b` round-trip unchanged. Budget arithmetic is the SQL stores' own.
- Pass `client` instead of `uri` to use a `MongoClient` you own; the store never closes it.

See the [storage guide](https://mayurajs.com/docs/guides/storage/). Apache-2.0.
