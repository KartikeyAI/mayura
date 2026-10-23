# Releasing Mayura

Releases are automated and come from `main` only. Mayura is published as **one npm package, `mayura`**, built from
every workspace package by `scripts/bundle-package.mjs`. `mayura` is the SDK; `mayura/workflows`,
`mayura/workflows/lifecycle`, `mayura/server-node` and the other subpaths mirror the workspace packages; and `mayura`
is also the CLI command. The package also carries the public documentation (`docs/`), `llms.txt` and `llms-full.txt`.
Native SQLite, PostgreSQL, QuickJS and React are optional peers, installed only by projects that use them.
`pnpm test:bundle` installs the package offline with and without those peers, loads every entry point, type-checks a
strict consumer and runs the CLI.

Beside it, the **`@mayurajs/*` extensions** in `extensions/` (provider packages built on vendor SDKs, and later storage,
RAG and voice) are published as separate npm packages from the same release, in lockstep: the same version as
`mayura`, with `mayura@^<version>` as their peer. `scripts/extensions.mjs` stages each one, and its third-party
dependencies must be listed there, reviewed, before a release accepts them. `pnpm test:bundle` also installs each
extension offline next to the bundle and type-checks it, and `mayura` is published first.

## V1.2 released

**1.2.0 was published on 2026-10-23** for `mayura` and all 105 `@mayurajs/*` extensions under `latest`.
The [stable release workflow](https://github.com/KartikeyAI/mayura/actions/runs/39934428405) succeeded through
`release.yml` and the protected `release` environment using npm trusted publishing, with **106 OIDC uploads accepted**.
All 106 public versions were independently checked against the saved archives for SHA-512 integrity, provenance
and `latest=1.2.0`. Every existing `next` tag was preserved, including the 22-package `1.2.0-rc.1` channel; packages
without a `next` tag still have none. This supersedes the earlier 22-package OIDC evidence and 84 configuration-only checks.

The [39-job main qualification](https://github.com/KartikeyAI/mayura/actions/runs/39928903180) and
[full 106-package rehearsal](https://github.com/KartikeyAI/mayura/actions/runs/39932634159) passed at the published
source, `ac32daa412d7209066530cfdc9542d820d054b86`. The
[v1.2.0 tag and stable GitHub Release](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.0) identify that commit.
The `release-all-1.2.0` workflow artifact retains the source-bound archives, publication receipt, qualification,
450-component SBOM and release notes. See the [V1.2 validation status](docs/guides/release-readiness.md) for evidence
scope and the experimental AG-UI/RAG, external-service and browser limitations that remain after publication.

## How a release happens

1. A push to `main` runs the **Mayura qualification** workflow: every test on Linux, Windows and macOS, Node.js 22 and
   24, SQLite and PostgreSQL.
2. When it passes, **Mayura release** (`.github/workflows/release.yml`) works out the next version from the commits
   since the last `v*` tag, following [Conventional Commits](https://www.conventionalcommits.org/):

   | Commit | Release |
   |---|---|
   | `feat: …` | minor (1.2.0 → 1.3.0) |
   | `fix: …`, `perf: …` | patch (1.2.0 → 1.2.1) |
   | `feat!: …`, or a `BREAKING CHANGE:` footer | major (1.2.0 → 2.0.0; before 1.0, a minor) |
   | `docs:`, `test:`, `chore:`, `ci:` and anything else | no release |

   From a prerelease such as `1.0.0-rc.1`, releases continue the prerelease (`1.0.0-rc.2`); release the final version
   explicitly.
3. For a full publication, the version must already be committed through a reviewed PR. Until then planning performs
   a dry run, even when publishing is enabled. On a clean release branch, run `node scripts/version.mjs set 1.2.0`:
   this updates the coordinated manifests, version references and changelog. Commit without `[skip ci]`, open a PR,
   require its qualification, merge through normal branch protection and require the pushed `main` commit to pass.
   The publisher never commits, rebases or pushes `main`; no branch-protection bypass is needed.
4. Dispatch the explicit version with `package_set=all` and `dry_run=true` to rehearse the complete release without
   changing `MAYURA_RELEASE`. The `release-rehearsal-<version>` artifact holds the archives, manifest, SBOM and notes
   for review. After a successful rehearsal and review, dispatch the same qualified main commit with
   `dry_run=false` and approve the protected `release` job. Automatic planning can also offer that job once the
   coordinated version is committed. Do not approve an older waiting job from an earlier workflow revision.
5. The live job checks the committed version, builds, runs upgrade compatibility, stages all archives and the SBOM,
   then independently requires complete successful push qualification for the exact current main commit. It validates
   the complete repository inventory, dependency order and every archive before uploading:
   - npm uses OIDC only and provenance, with npm 11.21.1 pinned; stable versions publish to `latest`, prereleases to
     `next`, and the other channel is preserved;
   - existing versions must match SHA-512 integrity; an existing version with different bytes stops publication;
   - each upload's intent/result is saved before/after npm runs, and registry visibility, provenance and tags are
     verified for every package before the receipt is marked published;
   - only then is the qualified version commit tagged `vX.Y.Z`; a conflicting existing tag is rejected;
   - the GitHub Release carries the frozen archives, manifest, SBOM, qualification evidence and publication receipt.

The `release-all-<version>` Actions artifact keeps immutable recovery evidence for 30 days, including on failure.
Use **Re-run jobs on the original workflow run** to recover it; do not start a new dispatch after a partial or
uncertain publication. Accepted uploads are never replayed, and uncertain uploads must become visible with the
expected integrity before further writes. Registry scanning can delay visibility; reconciliation waits up to 20
minutes after submission. Every poll rechecks all packages. Recovery fails closed if the artifact is missing,
archives/commit differ, main moved, or distribution tags changed unexpectedly. Investigate such failures before any
new operation. A dry run or a newly generated archive is not a recovery receipt. Existing GitHub Release notes are
preserved when a completed publication only needs its assets attached again.

The first release, or any exact version, is started by hand: **Actions → Mayura release → Run workflow** on `main`,
with the version (for example `1.0.0-rc.1`). With no `v*` tag yet, automatic runs release nothing.

## Qualification layout

Full qualification runs on pull requests (the proposed merge result), pushes to `main`, merge-queue groups and
manual workflow dispatches. Feature-branch pushes do not also start a duplicate full matrix; open a PR or dispatch
the workflow manually to qualify a branch before it reaches `main`.

- Shared checks run once on Linux: secrets, inspector build, CI tooling, provider dry run, API and version reports,
  facade consistency, documentation and the SBOM/license policy.
- Each Linux/macOS/Windows and Node 22/24 combination retains source type checks, offline consumers, examples,
  templates, starters and release archive qualification in its consumer lane.
- Each OS/Node combination runs the existing Vitest projects across two file shards, with the same per-runner
  worker limits and per-test deadlines. Service-backed integration still runs separately in all four database shards.
- Bundle checks use two extension shards per OS/Node combination. Shard 1 also checks all core entry points, optional
  peers, the strict core consumer and the CLI. Every extension still gets its own offline installation, runtime import
  and strict TypeScript consumer on each OS/Node combination. Without arguments, `pnpm test:bundle` checks everything;
  use `pnpm test:bundle --shard 1/2` and `--shard 2/2` to reproduce CI. Reports include per-extension timings.
- Runtime and container matrices retain their existing coverage. Build outputs and native dependencies are produced
  on each runner; native binaries are never copied between operating systems or Node versions.

The stable required check is **Qualification gate**. It runs after all seven lane groups and rejects failed,
cancelled, skipped or missing lanes. Configure branch protection to require this check instead of individual matrix
job names. Automatic release planning continues to require the entire **Mayura qualification** workflow to succeed
on the exact pushed `main` commit. At the current matrix sizes there are 39 jobs including the gate; release tooling must
use the gate and workflow conclusion rather than assuming a fixed job count.

## Scoped prereleases for the reviewed 22-package set

For the RC bootstrap set in `compatibility/prerelease-22.json`, dispatch **Mayura release** on `main` with an explicit
version such as `1.2.0-rc.1` and `package_set=prerelease-22`. This mode accepts only `1.2.0-rc.N` after `rc.0` and always
publishes to `next`. Set `MAYURA_RELEASE=enabled` and approve the **Publish reviewed 22-package prerelease** job in
the protected `release` environment. The default `all` option retains the normal full-release behavior.

The scoped job uses npm 11.21.1, OIDC and provenance, with no npm token secret. It verifies green push qualification,
including the aggregate gate, for the exact dispatched main commit before uploading. Every selected archive must
match its checksum, identity, repository and dependency closure. Each package must already have its `rc.0` bootstrap;
the job snapshots every existing `latest` tag and checks that it stays unchanged. A new package's first publication can
receive an automatic `latest` tag even with `--tag next`, so this lane cannot introduce unbootstrapped names.

This is a partial package publication: it does not commit a global version bump, create a Git tag, or create a GitHub
Release for the other packages. Scoped runs have their own serialized queue, independent of pending full releases.
Approve only the scoped job for an RC-set operation.

The `prerelease-22-<version>` Actions artifact contains the selected immutable archives, qualification evidence and
receipt. Use **Re-run jobs** on the original workflow run to recover that artifact, rather than starting a fresh dispatch
for a partial operation. Accepted uploads are polled for registry visibility
and provenance without re-uploading; cancellation or a lost response leaves an uncertain receipt that must be
reconciled before further uploads. A different archive for an existing version is rejected. npm scanning can delay
availability; the job waits up to 20 minutes after submission. Unvalidated trusted publishers require their first
successful OIDC publication within 48 hours of configuration; see the [npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Nothing is published until you turn it on

Until the repository variable `MAYURA_RELEASE` is `enabled`, every run is a complete **dry run**: it builds, verifies
and dry-run publishes, and writes the version it would release and the release notes to the run summary. Nothing is
pushed, tagged or published.

## One-time setup

1. **npm trusted publishers.** Use an npm account with package write access and two-factor authentication enabled.
   Configure [trusted publishing](https://docs.npmjs.com/trusted-publishers/) separately for `mayura` and every
   published `@mayurajs/*` extension: GitHub owner `KartikeyAI`, repository `mayura`, workflow filename `release.yml`,
   environment `release`. Enable direct publishing, not only staged publishing. Names are case-sensitive.
   The release job uses GitHub OIDC (`id-token: write`) on a GitHub-hosted runner; no `NPM_TOKEN` repository secret
   or user-supplied `NODE_AUTH_TOKEN` is needed. Node 24.14.1 includes an npm version above the OIDC minimum
   (npm 11.5.1; Node 22.14.0). Keep the runner's npm version at or above that minimum.
2. **Protected environment.** Create the `release` environment (Settings → Environments) with required reviewers and
   the `main` branch only. The release job waits there for approval before it publishes anything.
3. **Version PR and tag permission.** Merge the coordinated version/changelog PR through the required
   **Qualification gate**, without a skip-CI marker, and qualify main. The release job's token only needs to create
   the version tag and GitHub Release, not bypass main's rules. If tag rules exist, allow the intended release actor
   to create `v*` tags. `RELEASE_GIT_COMMITTER_NAME` and `RELEASE_GIT_COMMITTER_EMAIL` name the tagger, falling back to
   `RELEASE_GIT_NAME`/`RELEASE_GIT_EMAIL`, then `github-actions[bot]`. The version commit uses the PR author's normal
   Git identity; the publisher does not author a replacement commit.
4. **Enable publishing:** set the repository variable `MAYURA_RELEASE=enabled`.
5. **New packages in the `@mayurajs` scope.** The npm organization must grant the publishing account access.
   npm requires a package to exist before configuring trust. A new package therefore needs a separately approved,
   interactive first publication with npm login and 2FA, using reviewed, versioned release archives (never the private
   workspace directory). Then configure its trusted publisher before CI publishes later versions. Do not approve a
   release expecting OIDC to create new packages automatically, or publish placeholder packages to establish trust.

### Configure or check existing packages in bulk

The management command [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires npm 11.15 or newer.
Install it locally without changing the project's dependencies, then authenticate in your own terminal:

```sh
npm install --prefix .artifacts/tools/npm-trust --ignore-scripts --no-audit --no-fund --package-lock=false npm@11.21.1
npm login --registry=https://registry.npmjs.org/
node .artifacts/tools/npm-trust/node_modules/npm/bin/npm-cli.js trust list mayura --json
node scripts/npm-trusted-publishing.mjs         # read-only plan
node scripts/npm-trusted-publishing.mjs --apply # create missing trust; never publish packages
```

Complete npm's browser verification locally; its five-minute verification window makes bulk setup easier. If it expires,
complete verification again and resume with `--from @mayurajs/<name>`. To select individual packages, use
`--package @mayurajs/<name>` (repeat the option for multiple packages).
Use `--npm-cli /absolute/path/to/npm-cli.js` for another npm installation. The helper discovers extensions from their
workspace manifests, verifies each created publisher, preserves different existing configurations for review, stops on
errors, and returns a nonzero exit status for failures or packages not found publicly. A public 404 may also mean a
private package; inspect its access before any first publication.

A newly configured publisher must first publish successfully within npm's two-day activation window; otherwise recreate
it before releasing. Configuration checks and dry runs do not prove an OIDC publication succeeded. Verify provenance
after the first approved release. Keep an older waiting release run unapproved when it predates workflow changes;
qualify the updated `main` commit and start a release from that commit instead.

GitHub Packages is not used: its npm registry accepts only scoped packages, and `mayura` is unscoped. The GitHub
Release carries the same archive.

## What every release checks

- The complete type, unit, integration, packed-consumer and bundle suites on the declared matrix; a skipped required
  profile fails the release.
- `pnpm secret-scan` (every tracked file; findings report location and kind, never the value) and `pnpm sbom`
  (CycloneDX SBOM of the package and its production dependencies; fails on an undeclared or disallowed licence).
- `pnpm docs:check`: every documentation snippet type-checks against the real entry points and every link resolves.
- `pnpm release:artifacts` stages the package without changing source manifests, adds the exact Apache-2.0 `LICENSE`
  and `NOTICE`, disables lifecycle scripts, verifies archive paths, content and metadata, and writes SHA-256 checksums
  bound to the source commit. `scripts/publish-staged.mjs` requires an explicit manifest, the complete extension
  inventory, committed version, exact-main qualification and matching archives. Registry errors never imply that a
  version is absent. Both live writes and recovery verify distribution tags, integrity and provenance.

Source packages stay `private: true`, so an ordinary workspace command cannot publish them. Never overwrite a published
version; a failed verification stops the release.

## Locally

```text
node scripts/version.mjs check              # every file names the same version (CI runs this)
node scripts/version.mjs next               # what an automatic release would be now
pnpm build && pnpm release:artifacts        # stage and verify the archive
node scripts/publish-staged.mjs --manifest .artifacts/release-XXXX/release-manifest.json --tag latest
# Offline dry run for a stable version; use --tag next for a prerelease. Live writes require release.yml.
```
