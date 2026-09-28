---
title: "Versioning"
description: "What Mayura keeps stable, how versions follow SemVer, how APIs are deprecated, and how release candidates and npm tags work."
---

Mayura follows [Semantic Versioning](https://semver.org/). From 1.0.0, every public entry point of the `mayura`
package is stable: an upgrade within the same major version does not break code that uses the documented API. This
page explains what that promise covers, how deprecations work and how to install pre-releases.

## What is stable

Every entry point listed in [Entry points](../reference/entry-points.md) is stable from 1.0.0. There are no
experimental entry points. The three host entry points (`mayura/core/host`, `mayura/tools/host` and
`mayura/storage-sql/host`) are stable under the same rules for people who write adapters and hosts.

The promise covers more than function names:

- the exported names and their TypeScript declarations;
- `MayuraError` codes, and the error behaviour documented for each API;
- run, workflow and hook event types, and their metadata keys;
- the HTTP protocol served by `mayura/server`;
- the CLI's commands and flags;
- stored data formats, under the separate rules below;
- documented behaviour, such as failing closed and at-least-once execution of tool effects.

**Deep imports are not covered.** Import only the paths in the package's `exports` map, such as `mayura/workflows`.
A path into the package's internal files (for example `mayura/lib/...`) can change in any release.

## Code Mode

Code Mode (`mayura/code-mode`, `mayura/code-mode-workflows` and both sandbox adapters) is stable under the same rules.
Within a major version:

- `defineCodeProgram` gives the same `digest` for the same definition, so approvals and audit records that name a
  digest stay valid across upgrades.
- The failure reasons a sandbox reports (`program_error`, `cpu_limit`, `memory_limit`, `invalid_output`,
  `unsupported_program`, `sandbox_error`) and the error code each becomes do not change.
- The built-in adapters stay qualified `production`, and the guarantees listed in [Security](security.md#code-mode-sandboxing)
  are only ever tightened. The `test` qualification and `allowTestAdapter` keep their meaning for your own adapters.
- The protocol between an adapter and its QuickJS worker is internal: the worker must come from the same `mayura`
  version as the adapter. Rebuild the Docker sandbox image whenever you upgrade.

## How changes map to versions

| Change | Release |
|---|---|
| Removing or incompatibly changing a stable export, error code, event, protocol field or documented behaviour | major |
| Adding an entry point, an export, an optional field, an event type or a capability | minor |
| A fix that restores documented behaviour | patch |

Strict clients reject event types they do not know. When a release adds a new run event type, the changelog says so,
and `mayura/client` and `mayura/observability` accept it in that same release. Upgrade your clients together with your
server.

## The API report

Every export of every entry point is recorded, with a digest of its type declaration, in
[compatibility/api-report.json](https://github.com/KartikeyAI/mayura/blob/main/compatibility/api-report.json). CI
compares the built package against this report on every change, and any difference fails the build until a maintainer
reviews it. The review decides the version: a removed or changed export means a major release (or a deprecation), and
an added export means a minor release. This is how accidental breaking changes are caught before they ship.

The list of stable entry points is kept in
[compatibility/api-stability.json](https://github.com/KartikeyAI/mayura/blob/main/compatibility/api-stability.json).

## Deprecation

A stable API is deprecated before it is removed. Every deprecation comes with:

1. a `@deprecated` note in the type declarations that names the replacement, so your editor shows it;
2. an entry in the [changelog](https://github.com/KartikeyAI/mayura/blob/main/CHANGELOG.md);
3. a migration note in these docs.

A deprecated API stays for at least one minor release **and** at least 6 months, and is removed only in a major
release. Deprecations never change runtime behaviour and never log warnings at runtime.

## Support window

- The **latest major version** receives features, fixes and security fixes.
- The **previous major version** receives security fixes for 12 months after the next major's first release.
- Each supported **Node.js line** is supported while it is in active or maintenance LTS: Node.js 22 until
  2027-04-30 and Node.js 24 until 2028-04-30. Dropping a Node.js line is a major change.

These lengths are proposed defaults that the maintainers confirm before 1.0.0 is published. A security release never
widens permissions, changes where data is sent or turns on telemetry. See [Security](security.md).

## Stored data and durable runs

Storage schemas and durable workflow formats are versioned separately from the package version:

- Mayura refuses to read a stored format it does not know, instead of guessing.
- Schema changes are explicit, one-way migrations that you run with `mayura migrate` (see
  [Serve, worker and migrate](../cli/run.md)).
- A durable run stays pinned to the exact definition it started with. Upgrading the `mayura` package never, by itself,
  moves an in-flight run to a different definition; see [Workflow operations](../guides/workflow-operations.md).
- Every release is checked to resume runs that the previous release started.

## Pre-releases and npm tags

Before a stable version, Mayura publishes release candidates such as `1.0.0-rc.1`, `1.0.0-rc.2`. Release candidates
(and any `0.x` release) are pre-releases: they get best-effort support only, and a later candidate may still change
the API, with each change recorded in the changelog.

Releases are published to npm under two tags:

| Tag | Contains | Install with |
|---|---|---|
| `latest` | The newest stable version. A pre-release is never published here. | `npm install mayura` |
| `next` | The newest pre-release. | `npm install mayura@next` |

To test a release candidate without surprises, pin the exact version in `package.json` (for example
`"mayura": "1.0.0-rc.2"`) rather than a range. Projects created by `mayura init` are pinned this way already.

## Related

- [Entry points](../reference/entry-points.md)
- [Support](support.md)
- [Security](security.md)
- [Workflow operations](../guides/workflow-operations.md)
