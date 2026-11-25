# Releasing Mayura

Releases come from `main`. The **`mayura`** npm package bundles the private framework packages through
`scripts/bundle-package.mjs`. `mayura` is the SDK; `mayura/workflows`,
`mayura/workflows/lifecycle`, `mayura/server-node` and the other subpaths mirror the workspace packages; and `mayura`
is also the CLI command. The package also carries the public documentation (`docs/`), `llms.txt` and `llms-full.txt`.
Native SQLite, PostgreSQL, QuickJS and React are optional peers, installed only by projects that use them.
`pnpm test:bundle` installs the package offline with and without those peers, loads every entry point, type-checks a
strict consumer and runs the CLI.

The **`@mayurajs/*` extensions** in `extensions/` have independent npm versions. Each extension declares a
compatible Mayura peer range. Third-party dependencies are reviewed in `scripts/extensions.mjs`. Release plans list
the packages whose source, dependencies or compatibility changed. The core package includes the SDK, CLI and
starters. CI stages and checks the full inventory, including an offline install and strict type check per extension.

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

## V1.2.1 released

**1.2.1 was published on November 23, 2026** for `mayura` and all 105 extensions under `latest`.
The [main qualification](https://github.com/KartikeyAI/mayura/actions/runs/45084310737),
[full rehearsal](https://github.com/KartikeyAI/mayura/actions/runs/45087206578) and
[protected publication](https://github.com/KartikeyAI/mayura/actions/runs/45088101597) succeeded on the source
identified by [the v1.2.1 release](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.1). All 106 npm archives
and provenance records were verified. All 22 existing `next` tags were preserved.

See the [qualified Modal and Pinecone RAG profile](docs/guides/rag-production.md) for the scope of the Loki v28 evidence.

## How a release happens

### Production dependency audit

`pnpm audit:production` runs in Shared checks under the required Qualification gate. It checks the frozen
dependency graph of `mayura` and every staged extension against npm advisories. It includes transitive and
platform-specific dependencies, the browser dependencies embedded in the inspector, and separate profiles
for compatible optional peers pinned in the workspace. Deployments audit their actual consumer lockfile.

High and critical findings fail all production-qualified profiles. An optional extension profile explicitly listed as
unqualified in the policy is still audited and reported. Its status excludes it from production qualification, and any
finding shared with a supported profile still gates the release. A moderate finding in a supported profile fails unless
[`compatibility/production-audit.json`](compatibility/production-audit.json) records its exact package `name`,
`version`, npm advisory `id`, `reason`, `expiresOn` date (UTC), and GitHub PR `review` link. A maintainer
records the approval in a GitHub review with a line in the form
`Approve moderate <name>@<version> npm:<id> until <YYYY-MM-DD>`. CI verifies the receipt against GitHub.
The exception expires at the start of the given UTC date. Remove it when the dependency is fixed.

### Archive and installed-package checks

The main archive has a 5,600,000-byte compressed limit, a 24,000,000-byte unpacked limit and a 2,500-file limit.
The bundle check and release staging both apply the [package-size policy](compatibility/package-size-budget.json)
to the actual npm archive. The archive keeps TypeScript sources and debugger maps. Identical starter files can
share one archived copy; the CLI restores their exact bytes and the bundle check compares generated file digests.

The installed-package gate compiles a strict TypeScript RAG consumer and exercises durable ingestion, ranking,
citations, authorization, deletion, and adapter failures without service credentials. The protected release job
repeats the npm installation from the public registry for every published package, matches the archive digests
and runs registry signature and attestation verification before creating the GitHub Release.

The release workflow uses `pnpm upgrade:compat --fetch-baseline` to fetch dependencies from the previous release's
frozen lockfile with lifecycle scripts disabled. Its baseline install and migration test then run offline.

### Prerelease channel

Stable publication preserves existing `next` tags. For v1.2.2, correct tags still pointing to `1.2.0-rc.1` in
a separate registry change after the stable release is verified. Move those existing tags to `1.2.2` and leave
packages without a `next` tag as they are. Snapshot the tags before changing them and verify each new `next`
and existing `latest` afterward. The registry requires a maintainer npm session or a trusted publisher with
explicit dist-tag permission. [npm dist-tag permission](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing)

### Release sequence

1. Prepare a release plan on a topic branch from `dev`. Choose a SemVer bump for each package with changes. Use `mayura` for
   CLI or bundled starter fixes and the extension name for an adapter-only update. Include multiple packages when a
   change spans their dependency boundary.

   ```sh
   node scripts/version.mjs prepare storage-d1-1-4-1 --notes release-notes.md @mayurajs/storage-d1@1.4.1
   ```

   Commit the updated package version and the plan under `release-plans/`. Include any core version references and
   changelog changes generated for a core bump. Merge the topic PR into `dev` through the Qualification gate and wait
   for push qualification on `dev`. Open a promotion PR from `dev` to `main`, wait for its checks and squash merge.
   The pushed `main` commit must pass the full matrix before the rehearsal and publication.
2. Open **Actions → Mayura release → Run workflow** on `main`. Select `package_set=changed`, enter the plan filename
   without `.json`, and keep `dry_run=true`. The rehearsal checks the full inventory and installs the staged archives
   alongside the exact unchanged versions from npm. Its artifact contains the selected tarballs, plan-bound manifest,
   mixed-version compatibility result, SBOM and release notes.
3. After reviewing the rehearsal, dispatch the same qualified commit and plan with `dry_run=false`. Approve the job
   in the protected `release` environment. It verifies the exact main commit and mixed-version install before npm
   OIDC can upload the selected archives. Stable versions use `latest` and prereleases use `next`.
4. The publisher reconciles each upload against SHA-512, verifies provenance, and checks distribution tags. It then
   clean-installs the resulting package mix and verifies registry signatures and attestations. The workflow tags the
   exact qualified commit as `vX.Y.Z` for core and `release/<extension>/vX.Y.Z` for each selected extension. The GitHub
   Release carries the selected archives, manifest, plan, SBOM, and qualification and publication evidence.

The `release-plan-<id>` Actions artifact keeps recovery evidence for 30 days, including on failure.
Use **Re-run jobs on the original workflow run** after a partial or uncertain publication. An accepted write is
never replayed. An uncertain write must become visible with the expected integrity before publication continues.
Each registry poll verifies the selected packages. Recovery stops if evidence is missing, archives differ, main
moved, or distribution tags changed unexpectedly.

The explicit `all` and `prerelease-22` inputs are legacy coordinated modes. Use a package plan for new releases.

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
3. **Version PR and tag permission.** Merge the package plan PR through the required
   **Qualification gate**, without a skip-CI marker, and qualify main. The release job's token only needs to create
   the version tag and GitHub Release, not bypass main's rules. If tag rules exist, allow the intended release actor
   to create `v*` and `release/**` tags. `RELEASE_GIT_COMMITTER_NAME` and `RELEASE_GIT_COMMITTER_EMAIL` name the tagger, falling back to
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
  bound to the source commit. `scripts/publish-staged.mjs` requires the archive manifest, committed package plan,
  exact-main qualification, a mixed-version install check and matching selected archives. Registry errors never imply that a
  version is absent. Both live writes and recovery verify distribution tags, integrity and provenance.

Source packages stay `private: true`, so an ordinary workspace command cannot publish them. Never overwrite a published
version; a failed verification stops the release.

## Locally

```text
node scripts/version.mjs check              # core version consistency and valid extension versions
pnpm build && pnpm release:artifacts        # stage and verify the archive
node scripts/publish-staged.mjs --manifest .artifacts/release-XXXX/release-manifest.json --plan release-plans/storage-d1-1-4-1.json --tag latest
# Offline dry run for a stable version; use --tag next for a prerelease. Live writes require release.yml.
```
