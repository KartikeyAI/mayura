# mayura/storage-sqlite

Optional SQLite persistence for Mayura. Select this package to use SQLite without installing PostgreSQL. Packages are currently private development artifacts, not a published registry release.

```ts
import { createSqliteStore } from 'mayura/storage-sqlite';

const store = createSqliteStore({ filename: './application.sqlite' });
await store.initialize();
try {
  // Use aggregate methods or explicitly initialize a required storage capability.
} finally {
  await store.close();
}
```

The synchronous factory returns the existing driver-free aggregate contract, including scheduler, scheduled-workflow and execution-wait capabilities. Its dedicated owning worker, database implementation and package-relative worker entry stay in this archive. WAL, full synchronization, bounded IPC admission and persisted formats are unchanged.

The factory also exposes explicitly initialized `.durableBudgets`: transactional shared ancestor ceilings, atomic reservation bundles, retained unknown costs and committed overruns. This standalone financial ledger executes no actions and does not automatically enroll existing workflows. See the [durable-budget guide](../../docs/how-to/durable-budgets.md).

This package selects `better-sqlite3` **13.0.3** and the shared `mayura/storage-sql` engine. It does not select `pg`. Public factory declarations do not require consumers to install SQLite driver types. Native dependencies remain an explicit trust and platform-compatibility boundary; local qualification is not evidence for every OS, architecture or ABI.

The legacy `mayura/storage` facade re-exports this same factory while installing both adapters. Storage methods are trusted application APIs, not model tools or public authorization endpoints. See [installation guidance](../../docs/how-to/storage-installation.md) and [ADR 0006](../../docs/adr/0006-isolated-sql-installations.md).
