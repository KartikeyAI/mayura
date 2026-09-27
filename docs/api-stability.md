# Public API stability, support and deprecation policy

Status: **adopted for 1.0** (E2 in the [v1 release plan](v1-release-plan.md)). Owner decision (2026-09-27): every package is stable at v1. The support-window lengths below are proposed defaults; the owner confirms them before the first release (F12).

## What is stable

Every package entry point listed in `compatibility/api-stability.json` → `stableEntryPoints` is stable from 1.0.0. That is all 47 application-facing entry points. There are no experimental entry points at 1.0.

The stable contract is more than function names. It covers:

- the exported symbols and their TypeScript declarations;
- the `MayuraError` codes, and the error behavior documented for each API;
- run, workflow and hook event types, and their metadata keys;
- the HTTP protocol served by `mayura/server`, and the CLI commands and flags;
- persisted storage formats, under the separate rules below;
- documented behavior, including fail-closed and at-least-once guarantees.

The three **trusted-host** entry points are stable for authors of adapters and hosts, under the same versioning rules:

- `mayura/core/host`
- `mayura/storage-sql/host`
- `mayura/tools/host`

They are not an application-facing surface. They grant integration capabilities that must never reach model or guard contexts.

Deep imports, meaning any path not in a package's `exports` map, are unsupported and may change in any release.

## How changes are versioned

Mayura follows [Semantic Versioning](https://semver.org/).

| Change | Release |
|---|---|
| Removing or incompatibly changing a stable symbol, error code, event, protocol field or documented behavior | major |
| Adding an entry point, a symbol, an optional field, an event type or a capability | minor |
| A fix that restores documented behavior | patch |

`compatibility/api-report.json` records every exported symbol with a digest of its declaration. CI runs `node scripts/api-report.mjs`, and any difference fails the build until someone reviews it and regenerates the report with `--update`. The review decides the version bump:

- a removed or changed symbol means a major release, or a deprecation;
- an added symbol means a minor release.

Strict clients reject unknown event types. Adding a run event type is therefore announced in the changelog, and the reference clients (`mayura/client`, `mayura/observability`) accept it in the same release.

## Deprecation

A stable API is deprecated before it is removed. Deprecation requires three things:

1. A `@deprecated` JSDoc tag naming the replacement.
2. A changelog entry.
3. A migration note in the docs.

A deprecated API stays for at least one minor release **and** at least 6 months. It is removed only in a major release. Deprecations never change runtime behavior and never log at runtime; Mayura emits no telemetry.

## Support window (proposed defaults)

- The **latest major** receives features, fixes and security fixes.
- The **previous major** receives security fixes for **12 months** after the next major's first release.
- **Node.js:** each supported release line is supported while it is in active or maintenance LTS: 22 until 2027-04-30 and 24 until 2028-04-30. Dropping a Node.js line is a major change.
- **Security fixes** follow [SECURITY.md](../SECURITY.md). A security release never widens grants, changes data destinations or enables telemetry.

## Persisted formats

Storage schemas and durable workflow formats are versioned separately from package SemVer.

- A runtime refuses an unknown format.
- Schema migrations are explicit (`mayura migrate`), one-way, reviewed and tested ([storage operations](how-to/storage-operations.md)).
- A durable run stays pinned to its definition digest ([workflow versions](how-to/workflow-versions.md)).
- `pnpm upgrade:compat` proves on every release that runs started by the previous release resume on the new one.
- Changing a package version never, by itself, makes an old run resumable under a different definition.
