# AGENTS.md

Guidance for AI coding agents working in the Mayura repository. For *using* Mayura in an application, read
[docs/README.md](docs/README.md) or [llms.txt](llms.txt) instead.

## What this repository is

Mayura is a TypeScript framework for AI agents, typed tools and durable workflows, published as **one npm package,
`mayura`**. The repository is a pnpm workspace:

- `packages/<name>`: one internal package per part, named `@mayura/<name>`. These are private and never published.
- `scripts/bundle-package.mjs`: builds them into the published `mayura` package, where `@mayura/<name>[/<sub>]`
  becomes `mayura/<name>[/<sub>]` and `@mayura/sdk` becomes the root `mayura`. The package also ships `docs/`,
  `llms.txt` and a generated `llms-full.txt`.
- `packages/mayura`: a generated facade with the published entry points, so examples, starters and docs import
  `mayura/...` exactly as users do. Regenerate it with `node scripts/workspace-facade.mjs` after adding an entry point.
- `packages/cli/starters/<name>` and `packages/cli/templates/<name>.ts`: what `mayura init` creates.
- `docs/`: the public documentation. `llms.txt` is generated from `docs/README.md`.
- `examples/`: runnable examples that CI executes.
- `site/`: the website (landing page and the docs from `docs/`), a TanStack Start app prerendered to static HTML and
  deployed to GitHub Pages by `.github/workflows/site.yml`. It is its own pnpm root with its own lockfile, outside
  the workspace, so its dependencies never reach the package. Run its commands inside `site/`: `pnpm install
  --frozen-lockfile --ignore-scripts`, `pnpm dev`, `pnpm typecheck`, `pnpm build && pnpm check` (every page, link
  and anchor resolves). Set `SITE_BASE=/mayura/` to build for a project page instead of the custom domain.
- `internal-docs/` is ignored by git; never link to it from anything public.

## Commands

Node.js 24.14.1 and pnpm 10.17.1.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build                       # TypeScript project build (tsc --build)
pnpm typecheck
pnpm test                        # unit tests (vitest)
pnpm vitest run packages/<name>  # one package
pnpm docs:check                  # doc snippets type-check, links resolve, llms.txt is current
pnpm api:report                  # public API report; update it deliberately when the API changes
pnpm test:bundle                 # the published package, installed offline, every entry point loaded
pnpm test:templates              # every template generated, installed and run
pnpm test:starters               # every starter generated, installed and tested
```

## Rules

- Public code, docs and examples import from `mayura` or `mayura/<subpath>`. Inside `packages/*/src`, packages import
  each other as `@mayura/<name>`.
- Keep the core free of infrastructure: no database, server, provider or UI dependency in `mayura` itself. Heavy
  third-party packages are optional peers of the entry point that needs them.
- Nothing is allowed by default. New capabilities need an explicit permission string, a cost or limit where they
  spend, and tests for the denied path, cancellation and failure, not only the happy path.
- Tests never touch a real network or real credentials. Use `scriptedModel` and fake transports.
- A change to a public export updates `compatibility/api-report.json` (`pnpm api:report`), the docs page that
  describes it, and `CHANGELOG.md` (Unreleased).
- Docs pages start with `title` and `description` frontmatter, have no `# H1`, link only within `docs/`, and are
  listed in `docs/README.md`; then run `node scripts/docs-index.mjs` to regenerate `llms.txt`. Snippets must pass
  `pnpm docs:check`.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`); releases are versioned
  from them (see [RELEASING.md](RELEASING.md)).
- Never print, log or commit secrets. `.env` files are ignored.
