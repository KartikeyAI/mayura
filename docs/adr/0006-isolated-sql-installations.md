# ADR 0006: Isolated SQL installations with one shared engine

Status: implemented; local Windows x64 / Node 24.14.1 qualification passes, with other platforms and the complete release matrix still open. See the [qualification record](../specs/storage-package-qualification.md). Extends the [driver-free contract decision](0005-driver-free-storage-contracts.md) and the framework's progressive-adoption/installation requirements. This changes package ownership, not SQL behavior, persisted formats or release readiness.

## Decision

Developers selecting SQLite must not install PostgreSQL, and developers selecting PostgreSQL must not install a SQLite/native addon. Preserve existing `@mayura/storage` imports as an explicitly both-adapter compatibility facade.

| Package | Responsibility | Runtime closure roots |
| --- | --- | --- |
| `@mayura/storage-contracts` | Existing driver-free records, capabilities, validators and shared StorageError identity | Core |
| `@mayura/storage-sql` | One implementation of shared SQL reducers, schema/control helpers and transport validation | Core, storage-contracts |
| `@mayura/storage-sqlite` | Synchronous SQLite factory, dedicated owning worker, connection/database adapter | Storage-contracts, storage-sql, existing exact better-sqlite3 pin |
| `@mayura/storage-postgres` | Synchronous PostgreSQL factory and bounded pooled connection adapter | Storage-contracts, storage-sql, existing exact pg pin |
| `@mayura/storage` | Compatibility re-exports of both factories/options and existing contracts | Storage-contracts and both adapters |

Move source implementations once; do not copy reducers or keep a second executable implementation in the compatibility facade. Shared modules are aggregate-session, contracts/scheduler-contracts re-exports, scheduler-database/validation, scheduled-database/validation, execution-completions, execution-wait-database/validation and aggregate validation. The SQLite factory, worker and database remain together so its package-relative worker URL works after a real archive installation. PostgreSQL retains its current pool/timeouts/transaction/error semantics.

The shared engine has a deliberate `@mayura/storage-sql/host` export for trusted adapter authors. It exposes only the constructors, backend/session types and validation/ownership helpers actually needed by adapters/tests. It is not part of the one-import SDK, a user tool, a sandbox or an authorization boundary. Do not expose arbitrary source/dist deep paths. Driver factory public declarations reference only driver-free contracts; consumers should not install SQL driver type packages just to compile Mayura imports.

All adapters use the identical contracts StorageError constructor. Preserve synchronous factory signatures/options, aggregate methods, scheduler/workflow/execution-wait capabilities, hashes, schema/table names, SQL clock behavior and persisted versions. Reopening existing storage through either the old facade or the selected direct adapter is required. No automatic migration, licensing change, publication, new external dependency version, cloud operation or application credential is authorized by this ADR.

## Distribution and trust

Existing `better-sqlite3` 13.0.3 and `pg` 8.23.0 stay exact. Inspect installed metadata and archives rather than assume a native build/download is needed. The locally installed SQLite version carries platform prebuilds; the qualification must actually load the installed package's matching binary from its packaged worker with lifecycle scripts disabled. PostgreSQL's existing optional `pg-cloudflare` dependency must be explicitly accounted for; `pg-native` must not be silently introduced.

SDK, runtime, workflows, WorkStream, memory, context and storage-contracts gain no production dependency on either selected adapter or the shared engine. Only explicit reference-adapter installs cross that boundary. Root workspace development links may support tests/examples without affecting consumer closures. Package source maps remain self-contained and build-machine paths, stale compiled copies, test fixtures, credentials and build metadata stay outside archives.

## Failure-first qualification

1. Add failing selected-package import/type/closure fixtures before extracting implementation. Record the missing-package baseline, then perform mechanical movement and import changes.
2. Run aggregate, scheduler, scheduled-workflow and execution-wait shared conformance against direct adapter factories. Existing workflow/WorkStream/memory integrations through the compatibility facade remain passing. Add old-facade to direct-factory reopen and identical error-constructor tests.
3. Pack actual built Mayura packages and the already installed exact third-party transitive closure. Fresh npm consumers use empty caches, offline resolution, disabled scripts and an allowlisted environment. Forbid workspace symlinks, ancestor module fallback and unreviewed packages. Preserve third-party manifests/licenses/prebuilds; no edited facsimile packages.
4. Validate SQLite-only, PostgreSQL-only and compatibility dependency graphs. Strict public/negative TypeScript fixtures run without driver ambient types. Private deep exports must fail. SQLite-only actually runs worker-owned native transactions and close/reopen; PostgreSQL-only runs real SQL if the disposable database URL is explicitly supplied. An absent database is recorded as skipped, never qualified.
5. Exercise old/new factories on the same disposable file/schema, all existing suites, packed base/optional gates and credential-free examples. Update Markdown installation guidance and explicit CI gates. CI configuration is not remote OS/architecture evidence.

## Boundaries

This slice does not qualify all database versions, native ABI/OS/architecture/package-manager combinations, multi-tenant production isolation, backup/restore or scale. Native dependencies remain an explicit installation choice and a reviewed trust boundary. Shared source extraction must not be combined with new workflow semantics; any discovered runtime defect needs its own regression and documented change. All V01–V22 enterprise gates remain open until their complete criteria are met.
