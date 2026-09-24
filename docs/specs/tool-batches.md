# Standalone tool batches

Status: first implementation contract. Requirements: F06; partial V01, V06 and V12. This extends the standalone tool broker, not the durable workflow engine.

## Public contract

`invokeBatch(calls, options)` accepts 1–128 calls. Each call contains a unique bounded `id`, a registered tool, an immutable JSON input template, optional `dependsOn` call IDs and optional declared `resources` string keys. A template can contain genuine `batchOutput(callId, path?)` handles. The same IDs appear in the ordered result array and execution receipts. Call IDs must be unique within the batch; callers manage correlation across separate batches.

Options contain the ordinary tool invocation context except `callId`, plus `failurePolicy: 'collect-all' | 'fail-fast'` (default collect-all), `concurrency` (default 4, range 1–32), and `preflightTimeoutMs` (default 30 seconds). One shared `Budget` covers every call. Admission and receipt-persistence callbacks retain the ordinary broker semantics.

The result is an immutable array in input order: `{ id, outcome }`. Each outcome is the existing typed tool outcome, including its execution/disclosure receipt, or `{ status: 'skipped', reason, dependencies }`. Skipped reasons are `dependency_failed`, `fail_fast` and `resource_uncertain`. A skipped call never executed. Dependency IDs identify the unsuccessful predecessors where relevant.

An output handle adds an exact dependency edge automatically. Its path contains at most 16 own-property string or array-index segments; it never invokes a getter, coerces a key, reads the prototype chain or treats missing data as `undefined`. A handle can select the complete admitted output or a nested JSON value and can appear anywhere in an input template. Handles are opaque registrations from the active package instance: cloned/lookalike objects are rejected instead of being interpreted as references.

References are process-local authoring values, not serialized durable pointers. Durable batch suspension, persistence, cross-process resource coordination, automatic retries and exactly-once effects are not claimed.

## Preflight and execution

Before the first effect, snapshot all templates/context and validate the complete graph, unique IDs, output-handle registrations and paths, duplicate explicit edges, cycles, registered tool identity, all required grants and every literal-only input schema. Reject malformed configuration, denied admission, invalid literal input, cancellation or bounded preflight timeout with a safe error and zero handler dispatch. Input/template bounds are one MiB per call and four MiB across the batch, with at most 64 output handles per call, 512 per batch, 32 levels and 100,000 nodes per call; resources are bounded to 32 unique keys per call.

A reference-dependent schema cannot be fully evaluated before its predecessor output exists. After every referenced predecessor succeeds and releases admitted output, Mayura resolves only exact own paths, copies the resulting bounded JSON, enforces the four-MiB resolved-input aggregate and invokes the dependent call through the ordinary broker. That broker performs schema validation and all admission again before dispatch. A missing path, oversized resolution or invalid dependent schema produces a truthful non-success outcome with no dependent effect. Earlier successful effects remain successful; Mayura never implies rollback. Under collect-all, unrelated branches continue. Under fail-fast, the resolution/schema failure stops new dispatch and requests cancellation of active work under the existing semantics.

Literal-only schema validation runs again through `invokeTool` immediately before execution. Its processed JSON must equal the preflight candidate under sorted-key canonical encoding; non-deterministic transforms fail closed before effects. Reference-dependent inputs have no fabricated early candidate: their schema transform runs once at the normal broker boundary after resolution. Input/output guards, before-dispatch admission, cost reservations, execution receipts and output release all continue through `invokeTool`; the batch cannot bypass its policy boundary.

Once preflight succeeds, schedule ready calls up to the concurrency limit. A dependency is satisfied only by a `succeeded` outcome with admitted output. A failed, blocked, cancelled, unknown or skipped predecessor skips dependent calls. Independent branches can progress under collect-all. Every accepted call receives an outcome even if it never starts.

Fail-fast stops all new dispatch after the first non-success result and requests cancellation of in-flight calls through the child signal. It cannot retract completed effects. Pending calls are marked skipped; in-flight calls retain their truthful broker results, including successful-but-withheld or unknown-effect receipts. Explicit parent cancellation marks undispatched calls cancelled and signals running calls; unknown reservations are not refunded.

## Resources and uncertainty

Declared resource keys serialize conflicting calls within this batch invocation. All keys for one call are acquired together, in normalized sorted order; no call holds a partial set while waiting, so lock-order deadlock is impossible. Non-conflicting ready calls can still run concurrently.

An unknown execution or timeout/cancellation that may leave a handler active quarantines its resources for the rest of the batch. Later conflicting calls are skipped as `resource_uncertain`, not dispatched merely because the broker returned. Declared resource keys are supplied by trusted application definitions; undeclared aliases cannot be inferred. These locks are not an OS sandbox and do not coordinate other batches, processes or external actors.

Async preflight and tool execution have bounded deadlines. Trusted synchronous JavaScript cannot be forcibly interrupted in this in-process profile. Generated/untrusted code requires the separately qualified execution boundary.

## Required evidence

Tests cover graph/reference rejection before any effect, cloned/accessor handle rejection, exact root/object/array paths, automatic dependency ordering, missing paths, dependent schema rejection after a completed predecessor effect with no implied rollback, resolved aggregate limits, collect-all/fail-fast behavior, whole-batch literal schema/grant preflight, preserved input order, actual independent overlap, dependency ordering/skips, shared budget exhaustion, resource serialization, unknown-resource quarantine, parent cancellation, output-guard receipt preservation, non-deterministic literal schema rejection, immutable caller snapshots, and bounded preflight cancellation/timeouts. Existing standalone tool tests must remain green.
