# @mayurajs/storage-d1

Mayura storage on Cloudflare D1, from a Worker's D1 binding: everything the SQL stores keep.

```bash
npm install mayura @mayurajs/storage-d1
```

```ts
import { createD1Store, type D1Database } from '@mayurajs/storage-d1';

export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const store = createD1Store({ database: env.DB });
    await store.initialize();
    // ...
  },
};
```

- D1 has no interactive transactions. Mayura's state machines run as optimistic transactions: each reads, holds its
  writes, and commits one `batch()` that applies only if nothing it locked or wrote changed; otherwise it runs again.
  Two writers of one record never both succeed.
- Durable workflows with their graphs, trees, waits and discovery, the leased job scheduler, durable budgets and native
  memory, passing the same conformance suites as the SQL stores, including crash tests at commit.
- Leases use the database's clock. Every call is a round trip: place your Worker near its database.

See the [storage guide](https://mayurajs.com/docs/guides/storage/). Apache-2.0.
