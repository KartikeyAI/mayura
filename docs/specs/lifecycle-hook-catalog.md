# Lifecycle hook catalog

Status: **implemented** (C1 in the [v1 release plan](../v1-release-plan.md)). Owner decision (2026-09-27): implement the full [plan §8.2](../create-mayura-agentic-framework-plan.md) catalog, including fail-closed context-build, memory-write and retry hooks. This spec extends the [control hooks](lifecycle-hooks.md) and [primary-model hooks](primary-model-hooks.md); the [reconciliation](hook-catalog-reconciliation.md) records the prior state.

## 1. Where each point lives

Each lifecycle point is served where the lifecycle actually happens. There is no global hook bus.

| Point | Surface | Kind | Failure effect |
|---|---|---|---|
| `beforeExecution` | agent `defineHook` | control | blocks the run |
| `beforeStep` | agent `defineHook` | control | blocks the run before the step's model call |
| `afterStep` | agent `defineHook` | observer | mandatory: blocks the run; optional: visible only |
| `beforeModelCall` | agent `defineHook` | control | blocks the model call |
| `afterModelCall` | agent `defineHook` | observer | as `afterStep` |
| `beforeToolCall` | agent `defineHook` | control | blocks the tool call |
| `afterToolCall` | agent `defineHook` | observer | as `afterStep`; can never turn a failure into success |
| `beforeDelegate` | agent `defineHook` (on the parent) | control | the child ends `blocked` before its first step |
| `afterDelegate` | agent `defineHook` (on the parent) | observer | mandatory: the child's result is withheld as `blocked` |
| `beforeOutputRelease` | agent `defineHook` | control | withholds the candidate |
| `onViolation` | agent `defineHook` | observer | visible only; can never reverse a block |
| `afterExecution` | agent `defineHook` | observer, terminal | mandatory: withholds a successful output as `blocked` |
| `onError` / `onCancel` / `onBlocked` | agent `defineHook` | observer, terminal | visible only |
| `onFinally` | agent `defineHook` | observer, terminal | visible only |
| `beforeContextBuild` / `afterContextBuild` | `assembleContext({ hooks })` | control | assembly throws; no context is returned |
| `beforeMemoryWrite` | `createMemoryStore({ hooks })`, `createRemoteMemoryBridge({ hooks })` | control | nothing is written |
| `afterMemoryWrite` | same | observer, fail-closed | the call rejects, stating that the write committed |
| `onRetry` | `retry({ onRetry })` | control | no further attempt |
| `onWait`, `onResume`, `onApprovalRequested`, `onApprovalResolved` | `createWorkflowHookRelay` | durable observer | delivery stops at that event and resumes later |
| durable `afterExecution`, `onError`, `onCancel`, `onBlocked`, `onFinally` | `createWorkflowHookRelay` | durable observer | same |

**Control** hooks are awaited and return `{ decision: 'continue' }` or `{ decision: 'block' }`. Agent control hooks may also request registered read-only actions, as before. **Observer** hooks are awaited, receive a metadata-only view and return nothing. A result other than `undefined` counts as a failure.

## 2. Agent hooks

`defineHook` accepts every agent stage above. Observers take `mandatory?: boolean` (default `false`) and must pass `tools: []`, because observers cannot request actions. Control stages reject `mandatory`, since they are always fail-closed.

Registration order, deadlines (`timeoutMs`), the ancestor `maxHookCalls` ceiling and the `hook.started`/`hook.completed` events are unchanged. A failed or timed-out observer completes with `status: 'failed'`, a cancelled one with `status: 'cancelled'`, and a successful one with `status: 'continued'`. Hook actions still bypass every hook stage, so hooks never recurse.

Observer views (all frozen, all without content):

- `afterStep`: `{ step, result: 'tool_calls' | 'final' | 'stopped' }`
- `afterModelCall`: `{ step, modelId, response: 'final' | 'tool_calls', toolCalls }`
- `afterToolCall`: `{ step, callId, toolId, status, execution?, disclosure? }`. This is the real tool outcome, taken after the output guards and `beforeOutputRelease`.
- `afterDelegate`: `{ childRunId, childAgentId, status }`
- `onViolation`: `{ source: 'guard' | 'hook' | 'permission', boundary: 'input' | 'output' | 'tool' | 'model' | 'execution' | 'delegate', code, callId? }`. Sources are guard blocks (local and managed), control-hook blocks and tool/model permission denials. A delegation denial inside `admitChild` is synchronous and is not reported here.
- terminal: `{ status, error?: { code } }`

`beforeStep` receives `{ step }`. `beforeDelegate` receives `{ childRunId, childAgentId, input }`, where `input` is the child's submitted JSON.

### Ordering

1. `run.started`, then input validation, input guards and `beforeExecution`.
2. For each step: `step.started`, then `beforeStep`, request assembly, `beforeModelCall`, the model call, `model.completed` and `afterModelCall`. For each tool call: `beforeToolCall`, the tool, output checks, `beforeOutputRelease`, `tool.completed` and `afterToolCall`. The step ends with `afterStep` and `step.completed`.
3. On a block by a guard, control hook or permission check: `onViolation`, then the blocked result continues as before.
4. At the end: the required-child join, then exactly one of `afterExecution`, `onError` (`failed`/`outcome_unknown`), `onCancel` or `onBlocked`, then `onFinally`, then `run.completed`.

Terminal observers run after the run's own cancellation signal and budget have closed. They get a fresh deadline-only signal and never take actions or charge the budget. They still count against `maxHookCalls`. An observer that the ceiling does not admit emits no events and counts as failed, so a mandatory one fails closed.

A child's `beforeDelegate` runs in the **parent's** hook context (parent run ID, hook-call ceiling and broker for actions), after the child's `run.started` and before child input validation. A block ends the child as `blocked`. `afterDelegate` runs in the parent after the child's own terminal hooks and before the child's `run.completed`, so a mandatory `afterDelegate` failure is reflected in the child's reported status. The child's `onFinally` sees the status its own hooks decided.

### New metadata events

`step.started { step }`, `step.completed { step, result }`, `delegate.started { childRunId, childAgentId }` and `delegate.completed { childRunId, status }` join the run event catalog. Hook events accept every stage. The observability validator, client stream parser, headless activity projection and OTLP severity mapping are updated to match.

## 3. Library hooks: context, memory, retry

These packages do not depend on the runtime, so their hooks are plain callback options. They use one shared evaluator from `@mayura/core/host`, which applies the same rules to all of them:

- bounded `timeoutMs` (default 5,000, maximum 30,000);
- a deadline signal passed to the callback;
- frozen event views;
- strict result validation;
- safe error codes that never echo callback text.

| Outcome | Error code |
|---|---|
| block | `GUARD_BLOCKED` |
| invalid result or thrown error | `GUARD_UNAVAILABLE` |
| timeout | `TIMEOUT` |
| caller cancellation | `CANCELLED` |

- **Context.** `assembleContext({ hooks: { beforeContextBuild, afterContextBuild, timeoutMs } })`.
  - `beforeContextBuild` receives `{ scope, policyVersion, asOf, candidateCount, sourceCount, budget }` after input snapshotting.
  - `afterContextBuild` receives the immutable assembly's `{ fingerprint, selected: [{ id, sourceId, revision, contentDigest }], excluded, usage }` before return.
  - Either hook can block.
- **Memory.** `createMemoryStore({ hooks: { beforeMemoryWrite, afterMemoryWrite, timeoutMs } })`.
  - `beforeMemoryWrite` runs after permission and validation and before any storage access. It receives `{ operation: 'add' | 'correct' | 'forget', id, expectedVersion?, candidate? }`, where `candidate` holds the validated content, provenance, category, sensitivity and validity. It can block.
  - `afterMemoryWrite` runs after the committed write and receives `{ operation, id, version, status }`. A failure rejects with `GUARD_UNAVAILABLE` and a message stating that the write committed.
  - The remote bridge applies the same hooks to `publish` (`operation: 'publish'`) and `remove` (`operation: 'remove'`).
- **Retry.** `retry(operation, { onRetry })` calls `onRetry` after a retryable failure and before the backoff delay. It receives `{ attempt, nextAttempt, delayMs, error: { code } }`, where `code` is the `MayuraError` code or `'UNKNOWN'`.
  - `continue` lets the next attempt run.
  - `block` stops retrying and rethrows the original error.
  - A failed or timed-out hook stops retrying and throws `GUARD_UNAVAILABLE`.

## 4. Durable workflow hooks

`createWorkflowHookRelay({ source, store, scope, relayId, hooks, timeoutMs })` delivers named callbacks from any workflow runtime's durable event log.

- `source` is any runtime's `events(id, after)`.
- It maps each stored event to at most one point, for every workflow format:
  - approval `requested`/`resolved`/`expired` events go to `onApprovalRequested` or `onApprovalResolved`;
  - wait, pause, human-request and timer-scheduled events go to `onWait`;
  - wait-resolved, resume, human-response and timer-fired events go to `onResume`;
  - terminal completion, cancellation and termination events go to `afterExecution`, `onError`, `onCancel` or `onBlocked` by status, followed by `onFinally`.
- `deliver(runId)` reads events after a durable per-(relay, run) cursor. It awaits each callback in sequence order and advances the cursor with a compare-and-set after each success.
  - Each callback receives `{ stage, runId, sequence, eventId: '<relayId>:<runId>:<sequence>:<stage>', type, nodeId?, status? }`. No other event data is passed; in particular, human identities are withheld.
  - The cursor is persisted after every event that produced a callback, so a crash repeats at most the event in progress.
  - A failure stops delivery at that event, and the next `deliver` retries it. Delivery is at-least-once, and `eventId` is the deduplication identity.
  - This is the plan's recoverable `onFinally`: a crash never loses a terminal callback, but a process-local callback is never promised to run after one.

## 5. Tests required

- Every stage fires in the documented order.
- Mandatory versus optional observer failure, and timeout visibility.
- `afterToolCall` never upgrades a failure.
- `onViolation` never reverses a block.
- Terminal hooks under cancellation and timeout.
- Delegate hooks for agent tools and manual `spawn`.
- The hook-call ceiling for observers.
- Validators accept the new events and still reject unknown ones.
- Context, memory and retry block/fail/timeout paths, with no storage write on a blocked memory write.
- Relay cursor durability across a simulated crash, and at-least-once redelivery on SQLite and PostgreSQL.
- Packed consumer type checks for the widened `defineHook`.
