---
title: "V1.2 release validation status"
description: "Published V1.2 stable release, verified trusted publishing for all 106 packages, preserved next tags and remaining interoperability limits."
---

Stable **1.2.0 was published on 2026-10-23** for `mayura` and all **105 extensions** under `latest`, through
`release.yml` and the protected `release` environment using npm trusted publishing. All **106 packages** have
verified archive integrity and provenance, and every existing `next` tag was preserved. The
[stable GitHub Release and v1.2.0 tag](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.0) identify the qualified
source commit, `ac32daa412d7209066530cfdc9542d820d054b86`.
The local and earlier release-branch snapshots below remain historical evidence; publication does not establish
interoperability with unqualified real external services.

## Completed CI qualification

The [main qualification run 39928903180](https://github.com/KartikeyAI/mayura/actions/runs/39928903180) passed all
**39 jobs**, including the required **Qualification gate**: shared checks, six OS/Node consumer lanes, 12 unit-test
shards, 12 bundle shards, four database integration shards, shared runtimes and two container lanes. Linux, macOS and
Windows retain Node 22.23.2 and 24.14.1 coverage. Branch protection requires the aggregate gate. The
[main website run 39914438301](https://github.com/KartikeyAI/mayura/actions/runs/39914438301) also passed at the
version-preparation commit `0ba32b038ba8b8a8de6b40e1f4781f36f6a9ba00`, before the final workflow/test-fixture follow-up.

[PR #22](https://github.com/KartikeyAI/mayura/pull/22) prepared the coordinated version and
[PR #23](https://github.com/KartikeyAI/mayura/pull/23) corrected artifact retention and a Windows graph stress fixture.
Each passed all 39 qualification jobs before merging. The final main run above qualifies the published source.
The full publisher requires a committed version, exact-main qualification and source-bound archive/receipt
verification, and creates only the version tag and GitHub Release after publication. It does not commit, rebase or
push main.

The [full workflow rehearsal 39932634159](https://github.com/KartikeyAI/mayura/actions/runs/39932634159) passed at
that same source with `version=1.2.0`, `package_set=all` and `dry_run=true`: build, upgrade from V1.1.0, all 106 archive
checks, 450-component SBOM checks with no license findings, and 106 offline npm dry runs. Its downloaded
`release-rehearsal-1.2.0` artifact was verified independently. This rehearsal preceded live publication.

## Completed stable publication

The [stable release run 39934428405](https://github.com/KartikeyAI/mayura/actions/runs/39934428405) succeeded with
`version=1.2.0`, `package_set=all` and `dry_run=false`, after approval of the protected `release` environment.
All **106 OIDC uploads were accepted** and the publisher verified all versions, provenance and distribution tags
before creating the source-bound `v1.2.0` tag and stable GitHub Release. This establishes successful trusted publishing
for every package, superseding the earlier 22-package RC-only evidence and 84 configuration-only readbacks.

Independent public registry checks confirmed all 106 package identities and versions, SHA-512 archive integrity,
provenance and `latest=1.2.0` against the saved publication archives and receipt. Every `next` value matched the
pre-publication baseline: the reviewed 22-package set remains at `1.2.0-rc.1`, and packages without `next` still have
no such tag. Stable publication did not promote or replace the prerelease channel.

The [release evidence artifact](https://github.com/KartikeyAI/mayura/actions/runs/39934428405/artifacts/12494296045),
`release-all-1.2.0`, contains all 106 archives, their manifest, the complete published receipt, exact-main
qualification, the 450-component SBOM and release notes. Its downloaded ZIP matched SHA-256
`cc0c2d22b23c9ccfdf7856378cb5234f6980efe13c92a2b4945554a65236a39f`.
The receipt and qualification both identify the published source and successful main run `39928903180`.

### Historical RC1 publication

The [RC1 release run 39884720470](https://github.com/KartikeyAI/mayura/actions/runs/39884720470) succeeded through
`release.yml` and the protected `release` environment at `ba4a1e868904453e533e57e2876d64ab8536c454`, after
[its 39-job main qualification](https://github.com/KartikeyAI/mayura/actions/runs/39879429442). All 22 selected archives matched
their public npm integrity metadata, every version had provenance, and `next` resolved to `1.2.0-rc.1`. Existing
`latest` values remained `1.1.0` for `mayura` and the OpenAI provider, and `1.2.0-rc.0` for the 20 newly introduced
extensions. Those `latest` values describe the RC1 snapshot; stable publication subsequently advanced all 106
packages to `1.2.0` while preserving their `next` tags, as verified above.

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
were checked again during release preparation. These local archives were staged for verification; the completed
workflow rehearsal and stable publication generated their own archives bound to the final source and V1.2 version.

The integration result combines the latest execution of each case. The original all-service run had 54 failures
and 313 skipped cases. Focused reruns cleared all executed failures, including a final serial run of 107 cases
that cleared the remaining 52 failures. Filtered skips never overwrite an executed result. This is not a claim that
the original full run passed or that skipped external profiles were qualified. Database stress cases passed without
concurrent builds and unit-suite load. The subsequent complete CI pass is recorded separately above.

## Remaining qualifications and limitations

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

The published release retains the experimental labels and these limits. Any future claim of stable external
interoperability requires the corresponding real-service or reference-client qualification; an offline pass or
successful npm publication is not sufficient evidence for that claim.

## Release completion

The coordinated version PR, artifact/fixture follow-up, full main qualification, final-source rehearsal, protected
environment approval, 106-package stable publication and source-bound tag/GitHub Release are complete.
Trusted publishing is verified by successful OIDC publication for all 106 packages, rather than configuration
readback alone. The remaining work concerns the explicitly unqualified integrations, rendered browser flows and
deployments listed above; stable package availability does not qualify those application paths.
