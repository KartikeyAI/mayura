# @mayurajs/storage-libsql

Mayura storage on [libSQL](https://github.com/tursodatabase/libsql): Turso, your own `sqld` server, or a local file, through the official `@libsql/client`.

```bash
npm install mayura @mayurajs/storage-libsql
```

```ts
import { createLibsqlStore } from '@mayurajs/storage-libsql';

const store = createLibsqlStore({ url: 'libsql://my-app.turso.io', authToken: process.env.TURSO_AUTH_TOKEN! });
await store.initialize();
// Hand `store` to workflow runtimes, memory, budgets and your server; close it on shutdown.
```

- The same store as `mayura/storage-sqlite` and `mayura/storage-postgres`: durable workflows, scheduled jobs, execution waits, durable budgets, workflow trees and native memory. It passes the same conformance suites, on a local file and against a `sqld` server.
- SQLite's SQL and schema: a local libSQL file and a `mayura/storage-sqlite` file are interchangeable.
- Every operation is one write transaction. Writes run one at a time per store; a local file locked by another process is retried for up to 5 seconds without blocking the event loop.
- The URL and token are options, never read from the environment. Plain `http://` and `ws://` are accepted only for loopback addresses, and a token in the URL is refused.
- Pass `client` instead of `url` to use a client you create and own; the store never closes it.

See the [storage guide](https://mayurajs.com/docs/guides/storage/). Apache-2.0.
