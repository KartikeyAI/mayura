# Local artifact boundary

Status: **experimental; not release-qualified**.

## Scope

`@mayura/artifacts` provides an optional Node.js local-filesystem adapter for bounded, immutable artifacts. It is independent of workflows, servers and Arth. Applications remain responsible for persisting returned references alongside their own authoritative records. The buffering adapter rejects artifacts above 64 MiB, shared mutable input and configured staging populations above 4,096; applications normally select substantially smaller limits.

The adapter stages bytes under a store-owned directory, computes a SHA-256 content identity, verifies the staged file immediately before promotion and atomically renames it into a scope-partitioned content-addressed location. A committed reference binds the store format, verified scope, digest, byte length, media type, classification and optional expiry. Reads revalidate the complete reference, exact scope, file size and digest; a missing or changed object fails closed with a stable integrity error. A genuine staged handle can be explicitly discarded; discard is idempotent for that issued handle and cannot target a forged path.

## Disclosure

Disclosure requires a separate explicit policy containing an exact classification allow-list and maximum response size. It always returns an attachment with a sanitized filename, `X-Content-Type-Options: nosniff`, a bounded byte length and a normalized registered media type. Active HTML, SVG and XML types are rejected by default even when their classification is allowed. The adapter never executes content, sniffs a type, renders markup, follows a URL or performs a network request.

The application must still authenticate the caller, derive the verified scope, authorize access to the owning record and run any content-specific malware/DLP policy required by its deployment. Possession of an artifact reference is not authorization.

## Recovery and retention

Staging and application metadata are not one transaction. `reconcileStaging` removes only bounded, validated staging files older than the caller-selected cutoff; it does not infer whether a committed object is referenced. Deleting committed objects requires an exact verified scope and reference. Applications must track retention/deletion jobs and reconcile missing references or unreferenced committed objects from their authoritative database.

`audit` accepts a bounded complete list of exact references for one verified scope and a caller-selected cumulative byte ceiling. It prevalidates every reference before filesystem access, then reports immutable `ok`, `missing`, `expired` or `integrity_failed` observations without returning content. It is an integrity/availability check, not authorization, malware inspection or proof against an administrator controlling both the application database and filesystem.

Committed-object cleanup is an explicit two-phase operation. `planReconciliation` requires the application's complete authoritative retained-reference set for the scope, a past age cutoff and finite examination/deletion bounds. It enumerates only canonical content-addressed filenames in the exact scope partition, does not follow links and returns metadata-only candidates plus a context-bound continuation cursor. The plan is an opaque capability issued by that store instance. `applyReconciliation` consumes it once, rechecks each candidate's identity, size and modification time, and skips changed objects. It never recursively deletes, never deletes a retained reference and never infers authority from possession of a digest.

The retained set must be complete for the scope, not one database page. Applications should generate and review all finite plans before applying any of them when they need a whole-scope deletion preview. A process restart invalidates unapplied plans; the application must plan again from current authoritative state. This intentionally separates discovery from deletion and prevents a stale plan from silently removing a changed object.

The initial adapter is same-host storage, not a shared network filesystem, object store, encrypted vault, malware scanner or backup system. Symlink/reparse-point hardening, multi-process promotion races, crash injection, disk-full behavior, backup/restore and supported-host qualification remain required before V10, V17 or V18 can close.

## Required evidence for this slice

- immutable same-content promotion and exact scope separation;
- hostile identifiers, filenames, references and media types cannot escape the store or become inline active content;
- tampered, missing, expired, oversized and unauthorized content releases no bytes;
- bounded staging cleanup cannot traverse outside the owned staging directory;
- bounded audit distinguishes available, missing, expired and tampered objects without releasing bytes;
- two-phase committed reconciliation is scope-bound, one-use, link-averse, change-detecting and retains every authoritative digest;
- an isolated packed consumer uses only public exports and performs stage, commit, disclosure, audit and dry-run reconciliation paths.
