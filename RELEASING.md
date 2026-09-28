# Releasing Mayura

Releases are automated and come from `main` only. Mayura is published as **one npm package, `mayura`**, built from
every workspace package by `scripts/bundle-package.mjs`. `mayura` is the SDK; `mayura/workflows`,
`mayura/workflows/lifecycle`, `mayura/server-node` and the other subpaths mirror the workspace packages; and `mayura`
is also the CLI command. The package also carries the public documentation (`docs/`), `llms.txt` and `llms-full.txt`.
Native SQLite, PostgreSQL, QuickJS and React are optional peers, installed only by projects that use them.
`pnpm test:bundle` installs the package offline with and without those peers, loads every entry point, type-checks a
strict consumer and runs the CLI.

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
     that is already published, so a release that stopped part-way can be run again;
   - commits `chore(release): vX.Y.Z [skip ci]`, where the changelog's Unreleased section becomes the release's, tags
     it `vX.Y.Z` and pushes both;
   - creates the GitHub Release with the changelog section as notes, and the package archive, its manifest and the SBOM
     attached.

The first release, or any exact version, is started by hand: **Actions → Mayura release → Run workflow** on `main`,
with the version (for example `1.0.0-rc.1`). With no `v*` tag yet, automatic runs release nothing.

## Nothing is published until you turn it on

Until the repository variable `MAYURA_RELEASE` is `enabled`, every run is a complete **dry run**: it builds, verifies
and dry-run publishes, and writes the version it would release and the release notes to the run summary. Nothing is
pushed, tagged or published.

## One-time setup

1. **npm package.** Publish from an npm account that owns the `mayura` package, with two-factor authentication on.
   Then either add an automation token as the repository secret `NPM_TOKEN`, or configure
   [trusted publishing](https://docs.npmjs.com/trusted-publishers) for this repository and the `release.yml` workflow.
2. **Protected environment.** Create the `release` environment (Settings → Environments) with required reviewers and
   the `main` branch only. The release job waits there for approval before it publishes anything.
3. **Pushing the version commit.** The job pushes `chore(release)` commits and tags with its own token. If `main` is
   protected, allow GitHub Actions to bypass the rule for that push (or use a GitHub App token). The
   `RELEASE_GIT_NAME` and `RELEASE_GIT_EMAIL` repository variables choose the commit's author; the default is
   `github-actions[bot]`.
4. **Enable publishing:** set the repository variable `MAYURA_RELEASE=enabled`.

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
