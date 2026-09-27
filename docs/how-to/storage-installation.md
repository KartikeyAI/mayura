# Choose a storage installation

Mayura's base SDK and driver-free contracts do not install SQL adapters. Select storage explicitly when an application needs the reference SQL implementations.

| Application requirement | Direct dependency | Factory import | Driver selection |
| --- | --- | --- | --- |
| SQLite only | `mayura/storage-sqlite` | `createSqliteStore` | `better-sqlite3` 13.0.3; no PostgreSQL driver |
| PostgreSQL only | `mayura/storage-postgres` | `createPostgresStore` | `pg` 8.23.0; no SQLite/native addon |
| Existing both-adapter application | `mayura/storage` | Either factory | Both selected adapters |
| Custom adapter/contracts only | `mayura/storage-contracts` | Types, validators and `StorageError` | No SQL driver or shared SQL engine |

All packages are currently private local development artifacts. This guide names the intended dependency choices; it does not claim a public npm release. Within this repository, workspace dependencies and the normal workspace install/build provide these entries. Release qualification also tests real packed archives in isolated offline consumers with lifecycle scripts disabled.

```ts
// Choose the adapter needed by this application.
import { createSqliteStore } from 'mayura/storage-sqlite';
// Alternatively:
import { createPostgresStore } from 'mayura/storage-postgres';

// Error identity is shared across direct adapters and the compatibility facade.
import { StorageError } from 'mayura/storage-contracts';
```

Creating a store remains synchronous. Await `store.initialize()` before accessing it, and have the application owner call `store.close()` when finished. Both factories retain aggregate methods and the `scheduler`, `workflows` and `executionWaits` capabilities. Higher-level workflow and WorkStream runtimes receive a store explicitly; they do not select a driver or take ownership of closing it.

The optional `.durableBudgets` capability is a separately initialized financial ledger with shared ancestor limits and retained unknown charges. It adds no driver dependency and does not automatically enroll workflow executions. See [durable budgets](durable-budgets.md) for its bounded lifecycle and integration requirements.

## Existing applications

Imports from `mayura/storage` continue to work and re-export the same factory functions. To isolate an installation, change the dependency and import to the selected direct adapter. Import common contracts and `StorageError` from `mayura/storage-contracts`. Use the same SQLite filename or PostgreSQL connection/schema; this packaging change introduces no persisted-format migration or SQL semantic change.

Consumers of the public factories do not need to add `@types/pg` or `@types/better-sqlite3` merely to type-check Mayura imports. Only the SQLite package contains its package-relative owning worker and native database adapter. PostgreSQL retains its driver's declared optional dependency footprint, including `pg-cloudflare`; this is not a claim that every optional driver integration is exercised.

## Trusted adapter authors and limits

`mayura/storage-sql/host` deliberately exposes the shared SQL engine's constructors, backend/session types and validation/ownership helpers for trusted adapter integrations. Normal applications should use the selected factory. Internal source/dist deep imports are not public APIs, and the host entry is neither a sandbox nor an authorization boundary.

The existing exact driver versions are unchanged. Native prebuild availability and successful local offline installation do not qualify every operating system, architecture, Node ABI, package manager or database version. Consult the current [development ledger](../development-status.md) for completed evidence; all enterprise release gates remain open. See [ADR 0006](../adr/0006-isolated-sql-installations.md) for the full package and archive qualification contract.
