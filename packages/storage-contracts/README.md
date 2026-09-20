# @mayura/storage-contracts

Driver-free aggregate and scheduler contracts for trusted custom adapter authors. Depends only on core; no connections, filesystem access or environment lookup on import.

The reference SQLite/PostgreSQL implementations are selected explicitly from `@mayura/storage`, which re-exports these same interfaces and `StorageError` constructor. Contracts are not authentication, a transaction engine, or proof that an arbitrary adapter is conformant. See `docs/specs/storage-aggregate.md` and `docs/specs/leased-scheduler.md` in the repository for required lifecycle and atomicity semantics.

Private development preview; not yet published or enterprise-qualified.
