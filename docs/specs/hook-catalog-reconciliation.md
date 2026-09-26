# Lifecycle hook catalog reconciliation

Status: **superseded by the [lifecycle hook catalog](lifecycle-hook-catalog.md)**, which implements option 2 (owner decision 2026-09-27). The table below records the state before C1.

[Plan §8.2](../create-mayura-agentic-framework-plan.md) lists 25 lifecycle points. It says the names are proposed spellings but the lifecycle semantics are required. This table records how each point is served today.

Legend: **Control** — a required, awaited, fail-closed control hook ([lifecycle hooks](lifecycle-hooks.md), [primary-model hook](primary-model-hooks.md)). **Event** — observable as a metadata event on the run event stream ([native observability](native-observability.md)) or as a durable workflow event, but not as a registered callback. **Gap** — neither.

| Hook | Today | Notes |
|---|---|---|
| `beforeExecution` | Control | |
| `afterExecution` | Event | `run.completed` with terminal status and cost |
| `beforeStep` / `afterStep` | Event (partial) | Step index appears on model and hook events; no dedicated step events |
| `beforeModelCall` | Control | Primary model calls; managed guardrail calls are separately observable |
| `afterModelCall` | Event | `model.completed` |
| `beforeToolCall` | Control | |
| `afterToolCall` | Event | `tool.completed` with outcome and receipt fields; cannot rewrite failure, as the plan requires |
| `beforeDelegate` / `afterDelegate` | Event (partial) | Child runs carry `rootId`/`parentId` on `run.started`/`run.completed`; no delegate-specific callback |
| `beforeContextBuild` / `afterContextBuild` | Gap | Context assembly is deterministic library code with no hook point |
| `beforeMemoryWrite` / `afterMemoryWrite` | Gap | Memory writes are explicit application calls; no interception point |
| `beforeOutputRelease` | Control | Runs before final release checks, as required |
| `onWait` / `onResume` | Event | Durable workflow events (`lifecycle.human.requested`, `lifecycle.timer.scheduled`, `run.paused`, `run.resumed`, …) |
| `onApprovalRequested` / `onApprovalResolved` | Event | `approval.requested` / `approval.resolved` durable events in every workflow format |
| `onViolation` / `onBlocked` | Event (partial) | Blocked hook outcomes, guardrail decisions and blocked steps are recorded; no unified violation callback |
| `onRetry` | Gap | Retries are explicit application or helper policy; no framework retry loop to observe |
| `onError` / `onCancel` | Event | Terminal `run.completed` statuses and durable `run.cancelled` events |
| `onFinally` | Event | Terminal events are durable; the plan itself notes `onFinally` cannot promise process-local code after a crash |

Summary: 4 of 25 are control hooks, 16 are observable as events (5 of them only partially), and 5 are gaps (`beforeContextBuild`, `afterContextBuild`, `beforeMemoryWrite`, `afterMemoryWrite`, `onRetry`).

## Options for v1

1. **Observer hooks over existing events (recommended).** Add a registered, read-only `observe` hook interface that delivers the existing metadata events as named callbacks (`afterModelCall`, `afterToolCall`, `onApprovalResolved`, …), with the plan's rules: immutable redacted views, visible optional-hook failure, and no effect on execution. Add the missing step and delegate events. Leave context/memory/retry interception as documented post-v1 extension points. This closes the semantics with bounded risk.
2. **Full catalog.** Also add awaited control hooks for context build and memory write, plus an `onRetry` point inside the helpers' retry policy. This is significantly larger and puts new fail-closed points on hot paths.
3. **Defer.** Ship v1 with the four control hooks plus the documented event stream, and mark the named callbacks as post-v1. This is smallest, but it narrows the plan's stated requirement.
