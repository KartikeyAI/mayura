# @mayura/storage-postgres

Optional PostgreSQL persistence for Mayura. Select this package to use PostgreSQL without installing SQLite or its native addon. Packages are currently private development artifacts, not a published registry release.

```ts
import { createPostgresStore } from '@mayura/storage-postgres';

// Obtain the connection string from the application's protected configuration.
const store = createPostgresStore({ connectionString, schema: 'mayura' });
await store.initialize();
try {
  // Use aggregate methods or explicitly initialize a required storage capability.
} finally {
  await store.close();
}
```

The synchronous factory returns the existing driver-free aggregate contract, including scheduler, scheduled-workflow and execution-wait capabilities. Bounded pool sizing, transaction/lock timeouts, SQL clock behavior, schema names and persisted formats are unchanged. A database schema is storage separation, not application authorization.

This package selects `pg` **8.23.0** and the shared `@mayura/storage-sql` engine. It does not select `better-sqlite3` or enable `pg-native`. The PostgreSQL driver's declared transitive and optional dependencies remain part of its reviewed installation footprint. Public factory declarations do not require consumers to install PostgreSQL driver types.

The legacy `@mayura/storage` facade re-exports this same factory while installing both adapters. Storage methods are trusted application APIs, not model tools or public authorization endpoints. See [installation guidance](../../docs/how-to/storage-installation.md) and [ADR 0006](../../docs/adr/0006-isolated-sql-installations.md).
