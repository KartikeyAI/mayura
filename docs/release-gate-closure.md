# Release gate closure ledger

Updated: 2026-09-24. This ledger is the auditable closure record for the mandatory V01–V22 scenarios in the [governing plan](create-mayura-agentic-framework-plan.md#212-mandatory-acceptance-scenarios). A gate closes only when its exact deterministic scenario has direct executable evidence, the relevant public contract is documented, and the evidence passes on the current revision. Broader roadmap ambitions do not silently expand a gate; passing a gate also does not qualify behavior outside its stated scope.

## Current result

**1 of 22 gates closed. Mayura remains an experimental development preview.**

| Gate | State | Evidence or exact remaining blocker |
| --- | --- | --- |
| V01 — Unified authority | Implementation gap | Direct, batch, delegated, workflow-as-tool and required-hook paths exist. MCP invocation and an exact cross-path policy-decision matrix are missing; Code Mode parity must be proven in the same matrix. |
| V02 — Durable effects | Qualification gap | Scheduled profiles cover intent/dispatch/receipt/completion crash boundaries and conservative unknown outcomes. One named gate suite must cover every boundary, inspection replay and both SQL adapters without relying on scattered tests. |
| V03 — Fencing | Qualification gap | Scheduler fences, sticky revocation and resource serialization exist. The gate still needs one ownership-transfer matrix proving stale start and stale commit rejection plus conflicting-resource serialization on both databases. |
| V04 — WorkStream races | Implementation gap | Durable registration, signals, composites, cancellation, restart and cursor gaps exist. A durable deadline transition and explicit losing-subscription disposal evidence are missing. |
| V05 — Bounded orchestration | Qualification gap | Ephemeral nesting and bounded format-4 one-level children exist. A constrained-capacity matrix must jointly prove progress, cycle rejection and depth/concurrency/budget bounds for every supported orchestration profile. |
| V06 — Tool batch semantics | Implementation gap | Success, denial, failure, unknown, receipts, references and no-rollback behavior are covered. The batch contract has no truthful waiting outcome, so the exact mandatory scenario cannot yet pass. |
| V07 — Human intervention | Qualification gap | Durable exact approvals survive restart and bind candidate digests. A single stale-approval matrix must independently mutate target, tool version/code identity, arguments and policy. |
| V08 — Processor/hook integrity | Qualification gap | Candidate versions, final-gate revalidation and fail-closed callbacks exist. The exact transform/verdict invalidation and post-final mutation matrix must be consolidated across model, tool and output paths. |
| V09 — Guardrail barriers | Qualification gap | Required admission barriers and bounded accounted auxiliary checks exist. A direct zero-primary-generation/zero-tool-dispatch denial suite plus non-recursive auxiliary admission proof is still required. |
| V10 — Streaming disclosure | **Closed** | `packages/guardrails/test/release-gate-v10.test.ts` covers split secrets/PII, privileged tool previews, raw events, error messages, citations and byte/chunk overflow through the configured release boundary. Contract: [processors and guardrails](specs/processors.md). |
| V11 — Language handling | Qualification gap | Original text/protected spans, segment mappings, separate metering and fallback behavior exist. The gate needs one acceptance suite that proves tracked separate calls, evidence/code preservation and every documented translation-failure policy. |
| V12 — Budget concurrency | Qualification gap | Atomic hierarchical and durable bundles exist. A cross-root/child/batch/auxiliary contention suite must prove no reservation double-spend, retained unknown usage and admission stop on exhaustion. |
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

1. Close qualification-heavy V02, V03, V07, V08, V09, V11 and V12 before adding more feature surface.
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
