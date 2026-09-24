# Release gate closure ledger

Updated: 2026-09-24. This ledger is the auditable closure record for the mandatory V01–V22 scenarios in the [governing plan](create-mayura-agentic-framework-plan.md#212-mandatory-acceptance-scenarios). A gate closes only when its exact deterministic scenario has direct executable evidence, the relevant public contract is documented, and the evidence passes on the current revision. Broader roadmap ambitions do not silently expand a gate; passing a gate also does not qualify behavior outside its stated scope.

## Current result

**7 of 22 gates closed. Mayura remains an experimental development preview.**

| Gate | State | Evidence or exact remaining blocker |
| --- | --- | --- |
| V01 — Unified authority | Implementation gap | Direct, batch, delegated, workflow-as-tool and required-hook paths exist. MCP invocation and an exact cross-path policy-decision matrix are missing; Code Mode parity must be proven in the same matrix. |
| V02 — Durable effects | Qualification gap | Scheduled profiles cover intent/dispatch/receipt/completion crash boundaries and conservative unknown outcomes. One named gate suite must cover every boundary, inspection replay and both SQL adapters without relying on scattered tests. |
| V03 — Fencing | **Closed** | The shared scheduler conformance matrix passes 22/22 on SQLite and 22/22 on PostgreSQL. Its `persists expiry observation and rejects stale control before and after pre-start recovery`, `commits stale observation without falsely journaling a failed completion`, `never reclaims a started effect` and `serializes declared resources` scenarios prove sticky ownership transfer, stale start/commit rejection and conflicting-resource exclusion. Contract: [leased scheduler](specs/leased-scheduler.md). |
| V04 — WorkStream races | Implementation gap | Durable registration, signals, composites, cancellation, restart and cursor gaps exist. A durable deadline transition and explicit losing-subscription disposal evidence are missing. |
| V05 — Bounded orchestration | Qualification gap | Ephemeral nesting and bounded format-4 one-level children exist. A constrained-capacity matrix must jointly prove progress, cycle rejection and depth/concurrency/budget bounds for every supported orchestration profile. |
| V06 — Tool batch semantics | Implementation gap | Success, denial, failure, unknown, receipts, references and no-rollback behavior are covered. The batch contract has no truthful waiting outcome, so the exact mandatory scenario cannot yet pass. |
| V07 — Human intervention | **Closed** | The `V07` scenario in `packages/workflows/test/scheduled-conformance.ts` runs on both selected SQL adapters. It proves a wait retains no job or budget reservation, survives close/reopen, dispatches once after verified approval, and rejects stale approval after changing target run, tool version/definition identity, arguments or policy. Contract: [scheduled workflows](specs/scheduled-workflows.md). |
| V08 — Processor/hook integrity | **Closed** | `packages/runtime/test/release-gate-v08.test.ts` proves transformed candidates receive new version/digest-bound verdicts, unsafe transforms cannot reuse an earlier decision, post-final hook replacement fails closed, callback failure preserves a completed effect as succeeded/withheld, and failed denial notification cannot release or falsify content. Contracts: [processors](specs/processors.md) and [lifecycle hooks](specs/lifecycle-hooks.md). |
| V09 — Guardrail barriers | **Closed** | `packages/runtime/test/release-gate-v09.test.ts` proves mandatory local denial causes zero primary/tool dispatch, managed auxiliary denial is a single tool-free/continuation-free accounted call, and an unaffordable required barrier rejects atomically before any model dispatch. Contracts: [runtime-managed guardrails](specs/runtime-managed-guardrails.md) and [auxiliary guardrails](specs/auxiliary-guardrails.md). |
| V10 — Streaming disclosure | **Closed** | `packages/guardrails/test/release-gate-v10.test.ts` covers split secrets/PII, privileged tool previews, raw events, error messages, citations and byte/chunk overflow through the configured release boundary. Contract: [processors and guardrails](specs/processors.md). |
| V11 — Language handling | **Closed** | `packages/guardrails/test/release-gate-v11.test.ts` proves separately tracked and metered detection/translation calls, immutable original evidence, exact protected-code preservation, low-confidence preservation without translation, and fail-closed accounted translation failure. Contract: [auxiliary guardrails](specs/auxiliary-guardrails.md#language-detection-and-translation). |
| V12 — Budget concurrency | **Closed** | `packages/guardrails/test/release-gate-v12.test.ts` proves atomic competing child/root bundle admission, genuine ticket single-start, shared batch and parallel auxiliary ceilings, visible unresolved usage and stopped admission after exhaustion. The persistent equivalents remain covered by paired SQL durable-budget and workflow-tree suites. Contracts: [shared budgets](how-to/shared-budgets.md) and [durable budget ledger](specs/durable-budget-ledger.md). |
| V13 — Memory/context isolation | Implementation gap | Scope, correction, tombstones, stale-sync protection and native read-your-writes exist. Derivative revocation and a provenance-preserving migration fixture are missing. |
| V14 — Context continuity | Implementation gap | Required-source continuity exists. Repeated compaction/resume does not yet persist and prove all hard constraints, blockers, approvals and outstanding steps as one contract. |
| V15 — Code Mode | Qualification gap | QuickJS and Docker containment plus mediated nested calls and durable phases exist. A complete escape suite and one crash/resume write-deduplication gate suite remain; production hostile-code qualification is explicitly separate. |
| V16 — Server/client | Implementation gap | Object authorization, authenticated metadata streams, reconnect and cancellation exist. Safe rendering and explicit browser/server bundle separation need gate-specific executable evidence. |
| V17 — Operational recovery | Implementation gap | Provider/exporter failures, artifacts, corruption and worker draining have partial evidence. Cache corruption, migration/restore as an application operation and the complete documented failure matrix remain open. |
| V18 — Standalone consumer conformance | Qualification gap | Framework-owned packed samples use public APIs and cover scope, children and artifacts. Host-code approval and the full observational-policy/parallel-work matrix must be proven in one Arth-free consumer. |
| V19 — Install and dependency boundaries | Owner decision + qualification | Packed profiles prove current Windows x64/Node/pnpm boundaries and browser-safe imports. The owner must approve the supported OS/architecture/package-manager matrix before it can be executed and closed. |
| V20 — First-agent and progressive DX | Qualification gap | Credential-free and typed first-agent paths exist. Declared time/error-quality budgets, a real-provider recipe and the same-definition durable/server adoption fixture remain. |
| V21 — Public API and upgrade compatibility | Implementation gap | Consumer/runtime types and adapter conformance exist. Stable versus experimental surfaces, support policy and an actual prior-version upgrade/migration fixture are missing. |
| V22 — Open-source release trust | Owner decision + implementation | Build, contribution, security and no-default-phone-home evidence exist. Closure requires an owner-approved OSI license, notices/provenance review, release ownership/support policy and release-artifact checks. |

## Closure order

1. Close qualification-heavy V02 before adding more feature surface.
2. Implement the narrow missing contracts for V06 and V04, then close their deterministic matrices.
3. Close composition and containment gates V05, V14, V15 and V18.
4. Finish transport, recovery and compatibility gates V13, V16, V17, V20 and V21.
5. Execute the owner-approved distribution matrix for V19 and release governance for V22.
6. Add MCP authority parity and close V01 after all invocation paths are stable.

## Owner decisions that block release, not local development

- Exact OSI-approved license and copyright holder wording.
- Package registry scope and source repository namespace.
- Supported OS, architecture, Node and package-manager matrix.
- Stable API support window, deprecation period and release owners.

Until these decisions are made, packages stay private and no release claim is permitted.
