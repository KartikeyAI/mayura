# @mayurajs/storage-mysql

Mayura storage on MySQL 8.0.19 or later (InnoDB), through `mysql2`.

```bash
npm install mayura @mayurajs/storage-mysql
```

```ts
import { createMysqlStore } from '@mayurajs/storage-mysql';

const store = createMysqlStore({ uri: process.env.DATABASE_URL!, tls: true });
await store.initialize();
// Hand `store` to workflow runtimes, memory, budgets and your server; close it on shutdown.
```

- The same store as `mayura/storage-sqlite` and `mayura/storage-postgres`, with the same SQL layer: durable workflows, scheduled jobs, execution waits, durable budgets, workflow trees and native memory. It passes the same storage, memory and workflow conformance suites against a real MySQL, including crash tests that kill a process mid-transaction.
- Every operation is one transaction at `READ COMMITTED`; rows are locked with `FOR UPDATE`, and work with no row to lock yet takes a named lock (`GET_LOCK`). A deadlock or a lock that could not be taken reports a retryable `CONFLICT`.
- Identifiers are bytes (`VARBINARY`) and text is `utf8mb4` compared by code point, so keys differing only in case, accents or trailing spaces stay different.
- `tls: true` requires TLS and verifies the server; `{ ca }` verifies against your CA.
- Pass `driver` instead of `uri` to use a `mysql2/promise` pool you own, created with `flags: ['-FOUND_ROWS']`; `initialize()` checks, and the store never ends it.

See the [storage guide](https://mayurajs.com/docs/guides/storage/). Apache-2.0.
