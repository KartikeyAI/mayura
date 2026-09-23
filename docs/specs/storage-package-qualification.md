# Selected storage package qualification

Status: local Windows x64 / Node 24.14.1 evidence for the package boundary in [ADR 0006](../adr/0006-isolated-sql-installations.md), not a complete enterprise/platform qualification.

Run `pnpm test:consumer:storage` after building. For real PostgreSQL execution, explicitly provide the disposable `MAYURA_TEST_POSTGRES_URL` described in [Docker testing](../testing-docker.md). Without it, PostgreSQL database checks are reported as skipped. Never use a production database.

## Independent installations

The gate packs the actual built Mayura packages and the existing exact third-party dependency closure. Each profile installs archives into a fresh application with an empty npm cache, offline resolution, lifecycle scripts disabled and an allowlisted environment. No registry access, native rebuild, provider call, publication or user configuration rewrite occurs.

| Profile | Installed packages | Runtime evidence |
| --- | --- | --- |
| SQLite only | 6: core, contracts, shared SQL engine, selected adapter, better-sqlite3 and node-addon-api | Real worker-owned native loading, transactions and three storage owners across close/reopen |
| PostgreSQL only | 18: four Mayura packages plus the pinned driver closure, including optional pg-cloudflare | Real PostgreSQL transactions when explicitly configured; no SQLite, node-addon-api or pg-native |
| Compatibility | 22: both selected adapters, shared engine/contracts/core, compatibility facade and both driver closures | Exact factory/error identity and old/direct-factory reopen on each database |
| Workflow tree + SQLite | 9: core, tools, runtime, workflows, contracts, shared SQL engine, SQLite adapter and native driver pair | Public format-4 authoring/runtime submission, process-local runtime close, database close/reopen, narrowed child execution and validated terminal output |

The installed graph is checked against the qualified exact versions, not only against dependency names. Mayura archives permit only reviewed exports, implementation/declaration maps and included source/doc files. The compatibility archive contains only its index barrel and documentation, never another executable copy of reducers or adapters.

Third-party manifests, license notices and native prebuild bytes remain unchanged. Some existing dependencies carry the full license notice inside their README rather than a dedicated LICENSE file; those specific notices are verified and preserved. The SQLite driver ships eight platform prebuilds, but only the current host's actual loaded binary is qualified by this run. Preserved license bytes are not a complete license/compliance audit.

## Runtime and type isolation

Strict positive/negative consumer types require no `@types/node`, `@types/pg` or `@types/better-sqlite3` installation. All four profiles audit the compiler's actual input-file list: only the canonical installed application and the selected compiler's standard libraries are permitted. `types: []` alone would not prevent ancestor workspace declarations from masking a broken package. Regression tests include parent declaration leakage, junction escapes, missing graph evidence and arbitrary compiler implementation files.

Native TypeScript's standard library is resolved from its exact matching platform package. Runtime module-resolution hooks separately reject ancestor workspace/source fallback. SQLite workers inherit those test-only hooks; `process.dlopen` instrumentation records the actual worker thread, contained installed prebuild path and binary digest. Windows extended-path spelling is normalized only for canonical containment/evidence checks; the real loader argument is unchanged. This is qualification instrumentation, not a production sandbox.

Fixture children receive no ambient `PG*` settings. `PGPASSFILE` points to an explicitly created empty fixture file, so a passwordless test URL cannot consult saved home/application credentials. Connection strings and driver exception details are withheld from reports and errors. PostgreSQL cleanup removes only each generated, validated `mayura_packed_…` schema. SQLite artifacts stay in the generated application for inspection.

## Behavior exercised

The packed fixtures exercise aggregate create retries, compare-and-set updates and event persistence; scheduler claim/start/receipt/completion; scheduled workflow terminal publication; completion-wait registration, drain and immutable observation; and two-way close/reopen. Format-3 graph fixtures additionally reopen while waiting, resolve from the original target facts with zero jobs, enforce profile isolation and expose graph completion to an external join. Discovery initializes after the parent already exists, finds it after reopen, advances a full-page cursor and omits the terminal parent without losing cursor progress. Public factory declarations must provide `WorkflowGraphDiscoveryAggregateStore`, not merely a legacy aggregate type. They preserve unknown/failure distinctions and do not simulate real infrastructure effects.

Separate source-level suites run aggregate, scheduler, scheduled and completion-wait conformance through the direct adapters. Existing higher-level workflow, signal WorkStream and memory suites continue to use the compatibility facade. Seven new compatibility tests cover exact constructor/factory identity and bidirectional persisted-state/history reuse. The SQL extraction itself is verified unchanged apart from imports; no schema/data migration is introduced.

All installed storage profiles exercise the optional durable budget capability without adding packages: account/bundle admission, distinct first/repeated starts, unknown usage, subtree held cleanup, late known settlement after reopen and committed overrun closure. A second reopen preserves blocked status and financial evidence; exact root retries never reset the ledger. Direct and compatibility factory declarations expose this optional capability. The separate nine-package profile additionally compiles the public workflow-tree types without ambient driver declarations and runs a genuine required child after close/reopen from packed artifacts. Other scheduled profiles do not automatically gain child ownership.

## Retained evidence and limits

Each run retains a report, original archives, installed consumers, native-load evidence and fixture files under an ignored `.artifacts/storage-consumer-*` directory. No generated consumer replaces an existing one. Current report paths and full-suite totals are maintained in the [development ledger](../development-status.md).

The base SDK and driver-free workflow/WorkStream profiles remain unchanged. CI is configured to exercise selected storage, but remote jobs and other operating systems/architectures/package managers are not represented as passed. Production performance, backup/restore, disk-full behavior, migrations, native supply-chain review and the complete V01–V22 release criteria remain open.
