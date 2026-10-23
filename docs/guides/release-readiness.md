---
title: "V1.2 release validation status"
description: "Completed local and CI qualification, experimental surfaces and the checks still required before releasing Mayura V1.2."
---

Stable V1.2 is prepared for review and is not yet published. The implementation and full-release safeguards are
merged into `main`, whose full qualification passed on **2026-10-23** at
`a9b5c565167170e4b35b5f42cf7df58a64b485e8`. The coordinated **1.2.0** version PR needs its own qualification and
green main checks after merging. The reviewed 22-package set was previously published as
**1.2.0-rc.1 under `next`**, through trusted publishing, with all existing `latest` tags unchanged. The local and
earlier release-branch snapshots below remain historical evidence; none establishes interoperability with
unqualified real external services.

## Completed CI qualification

The [main qualification run 39903621300](https://github.com/KartikeyAI/mayura/actions/runs/39903621300) passed all
**39 jobs**, including the required **Qualification gate**: shared checks, six OS/Node consumer lanes, 12 unit-test
shards, 12 bundle shards, four database integration shards, shared runtimes and two container lanes. Linux, macOS and
Windows retain Node 22.23.2 and 24.14.1 coverage. Branch protection requires the aggregate gate. The
[main website run 39903621303](https://github.com/KartikeyAI/mayura/actions/runs/39903621303) also passed.

[PR #21](https://github.com/KartikeyAI/mayura/pull/21) passed all 39 qualification jobs before merging at the main
commit above. The full publisher now requires a committed version, exact-main qualification and source-bound
archive/receipt verification, and creates only the version tag and GitHub Release after publication. It does not
commit, rebase or push main. A local 1.2.0 rehearsal passed build, upgrade from V1.1.0, all 106 archive checks,
450-component SBOM checks with no license findings, and 106 offline npm dry runs. These local archives are rehearsal
evidence, not the final stable publication artifacts.

The [RC1 release run 39884720470](https://github.com/KartikeyAI/mayura/actions/runs/39884720470) succeeded through
`release.yml` and the protected `release` environment at `ba4a1e868904453e533e57e2876d64ab8536c454`, after
[its 39-job main qualification](https://github.com/KartikeyAI/mayura/actions/runs/39879429442). All 22 selected archives matched
their public npm integrity metadata, every version had provenance, and `next` resolved to `1.2.0-rc.1`. Existing
`latest` values remained `1.1.0` for `mayura` and the OpenAI provider, and `1.2.0-rc.0` for the 20 newly introduced
extensions. This proves OIDC publication for those 22 packages, not the full 106-package stable release.

On **2026-10-23**, read-only npm checks confirmed that all other **84 packages** have the expected trusted-publisher
configuration: `KartikeyAI/mayura`, `release.yml`, environment `release`, and direct publishing allowed. No trust
settings were changed. The CLI readback does not expose activation or expiry status and is not proof of a successful
OIDC exchange; the first live publication remains unproven for those packages. Recheck eligibility at release time
and recreate any expired configurations. Public registry preflight also found all 106 stable `1.2.0` versions unused.

### Historical release-branch run

The **Mayura qualification** workflow, run `39576846216`, completed successfully on `release-1.2` at
`f443c76e822eef27b143d318d748ed513599e00c`. All **13 configured jobs passed**, with zero failed jobs:

| Job group | Result |
| --- | --- |
| Consumers: Linux, Windows and macOS, each on Node 22.23.2 and 24.14.1 | All six passed |
| Database integration: two shards on each Node version | All four passed |
| Runtime compatibility: Node, Bun, Deno, workerd and Vercel Edge | Passed |
| Container qualification: Node 22 and 24 | Both passed |

The consumer jobs include unit tests, packed consumers, runnable examples, templates, starters, package bundles,
documentation, API/version checks, release archives and SBOM checks. Earlier failed or canceled attempts remain
historical evidence; this result is a complete successful run on the recorded commit.

The later main run above supersedes this branch-only gate for its recorded source commit. Further release-tooling,
documentation or version changes still require their own green PR and main qualification.

## Completed local qualification

The local snapshot was completed on **2026-10-21** on Windows x64, using Node 24.14.1 for core checks and
Node 24.15.0 for framework starter qualification.

| Check | Result |
| --- | --- |
| Unit suite | 5,296 passed, zero failed; six conditional PostgreSQL cases skipped |
| PostgreSQL journal profiles | 12 passed, including those six conditional cases |
| Integration, latest executed result per case | 2,338 passed, zero unresolved failures |
| Final serial integration rerun | 107 passed, clearing the remaining 52 failures |
| Client/server regressions | 261 passed |
| AG-UI native server integration | Five passed |
| Build, type checks and documentation | Passed; 451 documentation snippets checked |
| Public API report | Current at 179 entry points and 2,854 symbols |
| Edge compatibility | 62 compatible entry points; 13 explicitly Node-only |
| Shared runtime checks | Node, Bun, Deno, workerd and Vercel Edge passed |
| Offline consumers and upgrade from V1.1.0 | Passed |
| Published package bundle | 75 public entry points and 105 extensions passed |
| Release archive verification | 106 packages passed |
| Starter, template and offline example checks | 11 starters, eight templates and 18 examples passed |
| Website build and link checks | Passed; 200 pages and 45,057 links in the qualification snapshot |
| Frozen installation, secret scan and licenses/SBOM | Passed; 450 SBOM components, no license findings |

These counts describe the completed qualification snapshot before this status page was added. Documentation edits
are checked again during release preparation. The archives were staged for verification, not published; the release
workflow must generate new archives bound to the final source commit and V1.2 version.

The integration result combines the latest execution of each case. The original all-service run had 54 failures
and 313 skipped cases. Focused reruns cleared all executed failures, including a final serial run of 107 cases
that cleared the remaining 52 failures. Filtered skips never overwrite an executed result. This is not a claim that
the original full run passed or that skipped external profiles were qualified. Database stress cases passed without
concurrent builds and unit-suite load. The subsequent complete CI pass is recorded separately above.

## Remaining qualifications and limitations

- **Stable publication:** full-release safeguards passed PR and main qualification at the recorded source; scoped
  RC1 publication passed at its separately recorded source. The stable version PR still needs review, qualification
  and green main checks, then a final-source workflow rehearsal and publication approval. All other 84 publisher
  configurations matched in read-only checks, but were not exercised by RC1 and their activation/expiry status was
  not exposed by the CLI. Recheck eligibility and replace any expired configurations before full publication.
- **Providers and gateways:** offline transports and the provider harness dry run passed. Paid inference, real
  embedding endpoints, gateway accounting and remote discovery behavior have not been qualified.
- **Authorization:** OpenFGA, Cedar, Permit.io and Oso passed offline tests and package checks. Real provider/native
  engine interoperability, deployed policies and revision consistency remain host responsibilities and unqualified
  here. Amazon Verified Permissions is outside the implemented Cedar adapter.
- **RAG:** the [experimental RAG surface](rag.md) passed offline tests, including fake vector transports/SQL executors
  and local SQLite native-memory checks. This does not establish real vector/reranker service compatibility, SQL
  query plans, deployment limits or read-after-write visibility on eventually consistent services.
- **AG-UI:** the [experimental bounded profile](ag-ui.md) passed adapter and native server tests. The opt-in reference
  HttpAgent/schema harness, CopilotKit compatibility and the notebook's rendered browser flow remain unqualified.
  Arbitrary in-flight paid-operation recovery, conversation branching, audio/video media and reasoning disclosure
  remain outside the profile.
- **Frameworks and UI:** framework builds, mounted HTTP approval/worker flows and offline packed server contracts
  passed. Shared Bun/Deno/workerd checks do not qualify the Hono-specific Bun/Deno or Workers/D1 application paths.
  Rendered browser interaction, visual/accessibility checks and live deployment qualification remain outstanding.
  See [framework starters](framework-starters.md) and [copy-in UI](copy-in-ui.md).

Retain the experimental labels and these limits when publishing. Any claim of stable external interoperability
requires the corresponding real-service or reference-client qualification before release; an offline pass is not
sufficient evidence for that claim.

## Release preparation

1. Full-release publisher/recovery changes are merged and qualified on main; review these updated release records.
2. Review the prepared coordinated **1.2.0** version/changelog PR, committed without `[skip ci]`, merge through normal branch
   protection and require the pushed main commit's complete qualification to pass. The publisher does not write main.
3. Verify trusted publishing for all 106 packages, the protected `release` environment, tag creation permission and
   publishing enablement. Preserve the experimental labels and limitations above.
4. Rehearse **1.2.0** with `package_set=all` and `dry_run=true`, regenerating archives, checksums, SBOM and notes from
   the final source. Dry runs do not validate unexercised package trust.
5. Approve publication from that qualified main commit with `dry_run=false`. Verify all 106 versions, `latest` tags,
   provenance and the source-bound tag/GitHub Release. Recover partial publication from the original run's saved
   archives and receipt, without replaying accepted or uncertain uploads.

This version PR sets source manifests and version references to **1.2.0** and prepares the changelog. It does not
publish to npm, change distribution tags, create `v1.2.0` or create a stable GitHub Release. Stable publication and
deployment remain outstanding; RC1 availability is not evidence of live-service or rendered browser qualification.
