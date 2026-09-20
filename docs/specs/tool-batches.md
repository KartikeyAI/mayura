# Standalone tool batches

Status: first implementation contract. Requirements: F06; partial V01, V06 and V12. This extends the standalone tool broker, not the durable workflow engine.

## Public contract

`invokeBatch(calls, options)` accepts 1–128 calls. Each call contains a unique bounded `id`, a registered tool, literal JSON `input`, optional `dependsOn` call IDs and optional declared `resources` string keys. The same IDs appear in the ordered result array and execution receipts. Call IDs must be unique within the batch; callers manage correlation across separate batches.

Options contain the ordinary tool invocation context except `callId`, plus `failurePolicy: 'collect-all' | 'fail-fast'` (default collect-all), `concurrency` (default 4, range 1–32), and `preflightTimeoutMs` (default 30 seconds). One shared `Budget` covers every call. Admission and receipt-persistence callbacks retain the ordinary broker semantics.

The result is an immutable array in input order: `{ id, outcome }`. Each outcome is the existing typed tool outcome, including its execution/disclosure receipt, or `{ status: 'skipped', reason, dependencies }`. Skipped reasons are `dependency_failed`, `fail_fast` and `resource_uncertain`. A skipped call never executed. Dependency IDs identify the unsuccessful predecessors where relevant.

This initial API supports literal inputs only. Dependencies determine readiness; they do not substitute predecessor output into arguments. Typed output references, durable batch suspension, persistence, cross-process resource coordination, automatic retries and exactly-once effects are not claimed.

## Preflight and execution

Before the first effect, snapshot all inputs/context and validate the complete graph, unique IDs, references, duplicate edges, cycles, registered tool identity, all required grants and every input schema. Reject malformed configuration, denied admission, invalid input, cancellation or bounded preflight timeout with a safe error and zero handler dispatch. Input bounds are one MiB per call, four MiB across the batch, depth/node limits from core JSON validation; resources are bounded to 32 unique keys per call.

Schema validation runs again through `invokeTool` immediately before execution. The processed JSON must equal the preflight candidate under sorted-key canonical encoding; non-deterministic transformations fail closed before effects. Input/output guards, before-dispatch admission, cost reservations, execution receipts and output release all continue through `invokeTool`; the batch cannot bypass its policy boundary.

Once preflight succeeds, schedule ready calls up to the concurrency limit. A dependency is satisfied only by a `succeeded` outcome with admitted output. A failed, blocked, cancelled, unknown or skipped predecessor skips dependent calls. Independent branches can progress under collect-all. Every accepted call receives an outcome even if it never starts.

Fail-fast stops all new dispatch after the first non-success result and requests cancellation of in-flight calls through the child signal. It cannot retract completed effects. Pending calls are marked skipped; in-flight calls retain their truthful broker results, including successful-but-withheld or unknown-effect receipts. Explicit parent cancellation marks undispatched calls cancelled and signals running calls; unknown reservations are not refunded.

## Resources and uncertainty

Declared resource keys serialize conflicting calls within this batch invocation. All keys for one call are acquired together, in normalized sorted order; no call holds a partial set while waiting, so lock-order deadlock is impossible. Non-conflicting ready calls can still run concurrently.

An unknown execution or timeout/cancellation that may leave a handler active quarantines its resources for the rest of the batch. Later conflicting calls are skipped as `resource_uncertain`, not dispatched merely because the broker returned. Declared resource keys are supplied by trusted application definitions; undeclared aliases cannot be inferred. These locks are not an OS sandbox and do not coordinate other batches, processes or external actors.

Async preflight and tool execution have bounded deadlines. Trusted synchronous JavaScript cannot be forcibly interrupted in this in-process profile. Generated/untrusted code requires the separately qualified execution boundary.

## Required evidence

Tests cover graph rejection before any effect, whole-batch schema/grant preflight, preserved input order, actual independent overlap, dependency ordering/skips, shared budget exhaustion, resource serialization, unknown-resource quarantine, fail-fast and parent cancellation, output-guard receipt preservation, non-deterministic schema rejection, immutable caller snapshots, and bounded preflight cancellation/timeouts. Existing standalone tool tests must remain green.
