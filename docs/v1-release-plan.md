# Mayura v1 release plan

Status: **active**. Owner decision (2026-09-26): nothing is published before v1. This file is the working checklist for v1; every item needs public contracts, failure-path tests, packed-consumer evidence where it ships, documentation and a local Git checkpoint, as for every earlier slice. It refines — and does not replace — the governing [plan](create-mayura-agentic-framework-plan.md) (§17.1 server release, §21.3 measures, §21.4 release operations) and the [roadmap audit](roadmap-completion-audit.md).

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
| A7 Versioned storage schema, `migrate` command, backup/restore runbook with a restore drill | ⬜ |
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
| C1 Reconcile the implemented hook catalog against plan §8.2 and close or formally defer each gap | ⬜ |

## D. Memory and context

| Item | Status |
|---|---|
| D1 Native memory import/export | ⬜ |
| D2 Context cache invalidation | ⬜ |
| D3 Formal v1 scope decision for graph memory, scalable native semantic indexing and speculation (deliver or mark post-v1 experimental) | ⬜ |

## E. Developer surface

| Item | Status |
|---|---|
| E1 Local inspector UI over the authenticated read APIs | ⬜ |
| E2 Stable v1 API surface declared in `compatibility/api-stability.json`, with support window and deprecation policy | ⬜ |
| E3 Node 22 LTS support decision and engines range | ⬜ |

## F. Qualification and release operations (§21.3, §21.4)

| Item | Status |
|---|---|
| F1 Performance suite for the §21.3 reference targets, with a declared-hardware report | ⬜ |
| F2 Standalone threat model covering every trust boundary | ⬜ |
| F3 SBOM generation and license review in the release artifact check | ⬜ |
| F4 CI: secret scanning, CodeQL, dependency updates, release workflow with provenance (files prepared locally) | ⬜ |
| F5 Flaky timing-sensitive tests stabilized | ⬜ |
| F6 Upgrade-compatibility test: a run started on one version resumes on the next | ⬜ |
| F7 Host the repository, enable CI, branch protection and private vulnerability reporting | 👤 |
| F8 Verify `@mayura` npm scope ownership and run a provenance rehearsal | 👤 |
| F9 Live model/provider qualification (OpenAI, Anthropic, local runtime) with funded credentials | 👤 |
| F10 macOS and Arm qualification (via hosted CI runners) | 👤 |
| F11 Independent security audit, including Code Mode | 👤 |
| F12 Additional maintainers / release ownership | 👤 |

Owner-required items are prepared as far as possible locally (for example CI and release workflow files, rehearsal scripts and provider qualification harnesses) so that they only need credentials or accounts to execute.
