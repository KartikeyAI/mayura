# Mayura v1 release plan

Status: **active**. Owner decision (2026-09-26): nothing is published before v1. This file is the working checklist for v1; every item needs public contracts, failure-path tests, packed-consumer evidence where it ships, documentation and a local Git checkpoint, as for every earlier slice. It refines — and does not replace — the governing [plan](create-mayura-agentic-framework-plan.md) (§17.1 server release, §21.3 measures, §21.4 release operations) and the [roadmap audit](roadmap-completion-audit.md).

Owner scope decisions (2026-09-27): the **full** §8.2 hook catalog including fail-closed context, memory and retry hooks; **all** memory and context capabilities including graph memory, a scalable native semantic index and speculation; **Node.js 22 LTS and 24**; and **every package stable** at v1.

Legend: ✅ done · 🔨 in progress · ⬜ not started · 👤 requires the owner (accounts, spend, hardware or authority the development environment does not have).

## A. Production server and workers (§17.1: "container packaging, health checks, migrations, backup/restore, graceful shutdown and worker draining are required before a server release")

| Item | Status |
|---|---|
| A1 Production Node host: explicit non-loopback binding, HTTPS origin, in-process TLS or declared TLS-terminating proxy, liveness/readiness, graceful shutdown ([spec](specs/production-server.md)) | ✅ |
| A2 Durable HTTP idempotency so a client retry after a server restart cannot start a duplicate run | ✅ |
| A3 Durable leadership lease so several worker replicas drive a scope without duplicated host work ([spec](specs/workers.md)) | ✅ |
| A4 Worker supervisor: hosts/coordinators under leadership, readiness, drain | ✅ |
| A5 CLI `serve` and `worker` commands over an explicit application module | ✅ |
| A6 Container image and compose profile (server, worker, PostgreSQL) with health checks ([guide](how-to/production-deployment.md)) | ✅ |
| A7 Versioned storage schema, `migrate` command, backup/restore runbook with a restore drill ([runbook](how-to/storage-operations.md)) | ✅ |
| Worker draining (bounded `drain`) | ✅ |
| Operator pause, fleet hold and authenticated transport | ✅ |

## B. Workflow controls

| Item | Status |
|---|---|
| B1 Definition-version migration policy and tooling for in-flight runs (today mismatched state is refused, never upgraded) | ⬜ |
| Timers, recovery, reconciliation, pause, drain | ✅ |

## C. Hooks, guardrails, streaming

| Item | Status |
|---|---|
| C1 Implement the full §8.2 hook catalog: observer hooks for every lifecycle point plus fail-closed context-build, memory-write and retry hooks ([spec](specs/lifecycle-hook-catalog.md)) | ✅ |

## D. Memory and context

| Item | Status |
|---|---|
| D1 Native memory import/export ([spec](specs/native-memory-v1.md), [guide](how-to/native-memory.md)) | ✅ |
| D2 Context cache invalidation and prefetch | ✅ |
| D3 Graph memory | ✅ |
| D4 Scalable native semantic index (IVF; local hashing and hosted OpenAI embedders) | ✅ |
| D5 Speculation (`runtime.speculate`) and context prefetch | ✅ |

## E. Developer surface

| Item | Status |
|---|---|
| E1 Local inspector UI over the authenticated read APIs | ⬜ |
| E2 Every package declared stable in `compatibility/api-stability.json` after a surface audit, with support window and deprecation policy | ⬜ |
| E3 Node.js 22 LTS and 24 support: engines range, compatibility fixes, CI matrix. Local evidence: Node.js 22.23.2 packed install and server/worker image smoke ([matrix](support-matrix.md)); the full unit suite on 22 runs in hosted CI (F7) | ✅ |

## F. Qualification and release operations (§21.3, §21.4)

| Item | Status |
|---|---|
| F1 Performance suite for the §21.3 reference targets, with a declared-hardware report | ⬜ |
| F2 Standalone threat model covering every trust boundary ([threat model](threat-model.md)) | ✅ |
| F3 SBOM generation and license review (`pnpm sbom`, in CI and the release workflow) | ✅ |
| F4 CI: secret scanning, dependency updates, release workflow with provenance, container smoke job (prepared; runs once hosted). CodeQL default setup and GitHub secret scanning are repository settings (F7) | ✅ |
| F5 Flaky timing-sensitive tests stabilized | ⬜ |
| F6 Upgrade-compatibility test: a run started on one version resumes on the next | ⬜ |
| F7 Host the repository, enable CI, branch protection and private vulnerability reporting | 👤 |
| F8 Verify `@mayura` npm scope ownership and run a provenance rehearsal | 👤 |
| F9 Live model/provider qualification (OpenAI, Anthropic, local runtime) with funded credentials | 👤 |
| F10 macOS and Arm qualification (via hosted CI runners) | 👤 |
| F11 Independent security audit, including Code Mode | 👤 |
| F12 Additional maintainers / release ownership | 👤 |

Owner-required items are prepared as far as possible locally (for example CI and release workflow files, rehearsal scripts and provider qualification harnesses) so that they only need credentials or accounts to execute.
