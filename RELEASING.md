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

## V1.2 preparation

The [V1.2 validation status](docs/guides/release-readiness.md) records completed local checks and the successful
[13-job release-branch qualification](https://github.com/KartikeyAI/mayura/actions/runs/39576846216) at
`f443c76e822eef27b143d318d748ed513599e00c`. The documentation follow-up, newer `main` changes and merge commit
require their own green checks; publishing still requires qualification on `main`. Preserve the documented experimental
AG-UI/RAG status and avoid claiming unqualified real-service or browser interoperability. Rebuild versioned release
artifacts from the final reviewed commit; local qualification archives are not the publishable V1.2 release.

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
3. The release job sets the version everywhere (`node scripts/version.mjs set`), builds, runs the upgrade check
   against the previous release, stages and verifies the package archive (`pnpm release:artifacts`) and the SBOM, and
   then:
   - publishes to npm with provenance (`latest` for a stable version, `next` for a prerelease), skipping a version
     that is already published;
   - commits `chore(release): vX.Y.Z [skip ci]`, where the changelog's Unreleased section becomes the release's, tags
     it `vX.Y.Z` and pushes both;
   - creates the GitHub Release with the changelog section as notes, and the package archive, its manifest and the SBOM
     attached.

   Every step skips what is already done, so a release that stopped part-way can be run again with the same version:
   **Run workflow** with that version resumes it. A version that is already tagged is accepted only when `main` is at
   that version, for example one committed and tagged by hand and published from a terminal; the run then adds what is
   missing, such as the GitHub Release. A GitHub Release that already exists keeps its notes and gets its files
   attached again.

The first release, or any exact version, is started by hand: **Actions → Mayura release → Run workflow** on `main`,
with the version (for example `1.0.0-rc.1`). With no `v*` tag yet, automatic runs release nothing.

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
3. **Pushing the version commit.** The job pushes `chore(release)` commits and tags with its own token. If `main` is
   protected, allow GitHub Actions to bypass the rule for that push (or use a GitHub App token). Repository variables
   choose who the commit and tag name:
   - `RELEASE_GIT_AUTHOR_NAME` and `RELEASE_GIT_AUTHOR_EMAIL`: the commit's author;
   - `RELEASE_GIT_COMMITTER_NAME` and `RELEASE_GIT_COMMITTER_EMAIL`: its committer, who also creates the tag;
   - `RELEASE_GIT_NAME` and `RELEASE_GIT_EMAIL`: both, where the specific ones are not set.

   Without them, both are `github-actions[bot]`.
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
  bound to the source commit. `scripts/publish-staged.mjs` refuses unless the staged manifest names the current
  commit, the tag matches the version and every checksum matches, and it never publishes a prerelease to `latest`.

Source packages stay `private: true`, so an ordinary workspace command cannot publish them. Never overwrite a published
version; a failed verification stops the release.

## Locally

```text
node scripts/version.mjs check              # every file names the same version (CI runs this)
node scripts/version.mjs next               # what an automatic release would be now
pnpm build && pnpm release:artifacts        # stage and verify the archive
node scripts/publish-staged.mjs --tag next  # dry run; add --publish only in the release workflow
```
