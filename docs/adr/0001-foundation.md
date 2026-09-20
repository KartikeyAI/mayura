# ADR 0001: Small public API, shared admission, explicit durability

Status: accepted for foundation implementation, 2026-09-20.
Requirements: F01, F04–F08, F19, F26–F29; V01–V07, V18–V22.

## Context

Mayura is a library used in other applications, not a deployment platform every developer must run. It needs a small first-agent path and a durable execution path with accurately advertised guarantees. The user authorized development in `mayura/`, with Markdown documentation in `mayura/docs/`.

## Decisions

1. Use strict TypeScript and ESM. Start with core contracts, tools, in-process runtime, and deterministic testing packages. Add durable execution and storage as separate packages. No base package imports a database, server, sandbox or hosted SDK.
2. Public authoring uses `defineTool`, `defineAgent`, and `createRuntime`. Submission returns a handle consistently. Tool handlers and model adapters are trusted application code; this foundation is not a sandbox for hostile plugins.
3. Standard Schema input/output validation is a runtime requirement. JSON boundaries reject cycles, accessors, unsupported prototypes, unsafe numbers, excessive depth/size and non-JSON values. Public events contain metadata, not raw prompts or tool payloads.
4. Tools declare effects and capabilities. Grants are explicit, bounded and default-deny. The broker validates before dispatch, bounds calls and time, records execution separately from output disclosure, and never retries a side effect automatically. A tool handler is not given model credentials or a global runtime.
5. The model contract returns a complete final result or complete correlated tool calls. Partial provider tool arguments are not executable. Runtime bounds turns, calls, bytes and elapsed time. Cost-sensitive execution requires explicit adapter bounds and shared reservations; missing prices are not treated as free.
6. In-process execution is explicitly non-durable. It does not claim restart recovery or accept durable approvals. Durable workflows use transactional state plus events, stable effects and explicit reconciliation of uncertain operations. No silent storage fallback.
7. Cancellation is cooperative for trusted JavaScript. Stop new dispatch promptly; in-flight side-effect outcomes may be unknown. An abort signal is not an operating-system kill switch.
8. Schema/guard failures are fail-closed. Errors use stable safe codes; raw exceptions and rejected content do not enter public results. Required hooks/guards cannot be made advisory by a convenience API.
9. The public API, test doubles and package imports are tested as a consumer would use them. Documentation examples are executed, not only type-checked. Private packages prevent accidental publication until license/namespace decisions.

## First delivery and evidence

Implement and test the complete bounded first-agent path and the durable two-branch/approval/restart fixture. Record each as separate milestones. The second does not inherit a first milestone's test result as evidence. Broader workflows, full guardrail catalog, memory/context, providers, server/client and qualified Code Mode remain tracked requirements, not stubs advertised as working.

## Initial DX budgets

The base SDK must install with lifecycle scripts disabled and without native compilation. A credential-free first-agent fixture must finish within 5 seconds after installation on the test machine. Its example requires no unsafe casts or private imports. Track package unpacked size, dependency count, type-check time and first-run time; initial maximum base runtime dependency footprint is 5 MB unpacked, excluding explicitly selected model/schema adapters. Revisit thresholds only with recorded evidence.

These are regression targets, not a claim of measured novice onboarding time. First-time-developer walkthrough and Linux/macOS/Windows package-manager qualification are stable-release gates.
