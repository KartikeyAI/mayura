# Contributing to Mayura

This repository is an unreleased development checkout. Public contribution intake and license terms must be established before accepting external contributions or publishing packages.

## Local development

Use Node 24.14.1 and pnpm 10.17.1. Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm typecheck`, `pnpm test`, and `pnpm example`. Run SQL integration tests with an isolated PostgreSQL database specified by `MAYURA_TEST_POSTGRES_URL`. Test credentials must never be production credentials.

## Change requirements

1. Link the affected requirement and verification gate in the development plan.
2. Define public contracts and security invariants before changing behavior. Record significant decisions under `docs/adr/`.
3. Add regression coverage, including denied paths, cancellation, cost and failure recovery where relevant.
4. Keep public exports small and documented. No mandatory provider, native storage, server or UI dependency in the basic SDK.
5. Run tests against emitted and packed artifacts; passing monorepo imports alone is insufficient.
6. Update Markdown documentation and the status ledger. Never mark a broad release gate complete using a narrower passing fixture.

Generated dependency/build files are produced by their tools. Source edits require review. Security-sensitive changes should be isolated and described without including live secrets or exploitable private data.

The project owner currently controls architecture, license, namespace and release decisions. A public governance/RFC and maintainer succession policy remains a release requirement; no external support SLA is promised.
