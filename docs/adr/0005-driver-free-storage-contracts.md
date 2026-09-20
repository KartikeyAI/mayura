# ADR 0005: Storage contracts do not install a database driver

Status: accepted for this development preview, 2026-09-20.

## Decision

Move the existing aggregate/scheduler interfaces and the single shared `StorageError` class into a small `@mayura/storage-contracts` package, depending only on core. Keep the current `@mayura/storage` public exports as re-exports of that exact package instance; existing imports and `instanceof StorageError` checks continue working. No duplicate error implementation or duck-typed error-code replacement is introduced.

Workflows, WorkStream and native memory consume only these interfaces/error values at runtime. They depend on the contract package rather than the concrete SQLite/PostgreSQL package. Their SQL conformance fixtures select `@mayura/storage` as a development dependency. Custom adapter authors can implement the contracts without installing either reference driver. Workflow composition becomes a genuinely driver-free optional import/install profile.

The existing reference-adapter package still contains both drivers; separate SQLite-only/PostgreSQL-only distributions remain a later packaging boundary. No persisted format, factory option, data, runtime policy, or schema migration changes. The base SDK and browser client dependency graphs remain unchanged.

## Verification

Strict builds and existing SQL conformance must continue passing, including safe error handling and CAS retry behavior. Check the original and new public imports share the exact error constructor. Pack/install workflow authoring and ephemeral composition into an offline clean consumer, typecheck/use the public subpath, and assert neither SQL driver is installed. Existing base/client/host packed checks remain required. This is partial V19/V21 evidence, not the complete optional-driver/platform release matrix.
