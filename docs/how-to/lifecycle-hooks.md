# Required lifecycle hooks

Mayura's experimental ephemeral runtime supports four control stages. They are awaited, run in registration order, and fail closed. They are not arbitrary middleware, a JavaScript sandbox, or the complete planned lifecycle catalog.

| Stage | Runs after | Protects |
| --- | --- | --- |
| `beforeExecution` | Agent input schema and every required input guard | First primary model call |
| `beforeModelCall` | Each primary request's permission/content admission and protected output-check reservation | That primary model call |
| `beforeToolCall` | Whole model-proposal preflight and the prospective tool/output-check reservations | Original tool attempt |
| `beforeOutputRelease` | Candidate schema and every required output guard | Tool history insertion or final agent candidate |

The final-agent release hook runs before the required-child join. A later child failure can still prevent the parent from succeeding. A before-tool event contains the **raw proposal**, not a promise about the broker's schema-transformed executor input. Hooks cannot rewrite it or override an earlier denial.

Before-model hooks receive `purpose: 'primary'`, `modelId`, and `request: { messages, tools, maxOutputTokens }` for every iteration, including admitted tool history on subsequent turns. Those deeply immutable fields match the prospective adapter request; instructions and private provider continuation are omitted. This is not inspection of every provider-bound byte. Hook actions cannot replace the model, change its arguments or insert their results into that request. Auxiliary moderation does not recursively invoke before-model hooks. See the [primary admission contract](../specs/primary-model-hooks.md).

## Start with a local control check

```ts
import { defineAgent, defineHook } from 'mayura';

const release = defineHook({
  id: 'policy.release', version: '1', stage: 'beforeOutputRelease',
  tools: [],
  handler(event, context) {
    // Stage inference exposes candidate/source here, not proposal or input.
    // context has verified scope, run correlation, signal, step and attempt: 1.
    return { decision: event.candidate === null ? 'block' : 'continue' };
  },
});

const agent = defineAgent({ ...agentOptions, hooks: [release] });
```

Use genuine definitions from the same package instance; spreading a handle into a copy is not registration. An agent accepts at most 16 hooks with unique IDs across all stages. IDs and versions use 1–128 characters: start alphanumeric, followed by alphanumeric, `.`, `_`, `/` or `-`. Options must be plain own-data configuration, not accessors. The handler reference and tool catalog are captured without freezing application objects.

## Request an existing tool through the runtime

```ts
const proposalPolicy = defineHook({
  id: 'policy.proposal', version: '1', stage: 'beforeToolCall',
  tools: [assertProjectReadable],
  handler(event) {
    return {
      decision: 'continue',
      actions: [{ toolId: assertProjectReadable.id, input: event.proposal.input }],
    };
  },
});
```

`assertProjectReadable` must be a genuine `defineTool` definition with `effects: 'none'` or `'read'`. Its catalog is private to the hook, not added to the primary model's tools. A catalog supplies **no permissions**: the owning runtime still needs `tool:<id>`, the tool's capability grants, and `effect:read` for a read effect. Genuine agent/workflow composition wrappers are not allowed as hook actions. The registry is bounded to 32 tools.

The full decision/action list is validated before any requested action: exact registered identities, every grant and every input schema. Actions run sequentially through the same broker, original run scope, ancestor budgets/counters, tool guards and agent output guards. They do not trigger hooks recursively. The original prospective tool and managed-output checks keep their reserved funds while the hook runs.

An action's result is **not fed back into the hook handler**. Use an assertion-style tool whose schema/guards/outcome encode a policy failure. A successful `false` is not a denial. No action list is a transaction, and later failure cannot undo an earlier action. To inspect a read result and then reason over it, use a normal agent/workflow, not this one-shot control-hook API.

## Bounds and failures

- `timeoutMs`: default 5,000; maximum 30,000. Covers queueing, callback, validation, all actions and their checks, clamped by run/ancestor cancellation.
- `maxActions`: default 4; maximum 8 per hook invocation.
- `maxResultBytes`: default 65,536; maximum 1,048,576, including all action arguments.
- Runtime `maxHookCalls`: default 128; maximum 4,096. Each actual callback consumes one slot on every ancestor. Children may narrow, never widen it.

Callbacks have no account, ticket, model/child executor or invocation gateway. A callback consumes an operation permit until its **actual promise** settles, even if the logical deadline already ended. The permit is released before actions, so callback → tool → managed moderation can progress with `maxConcurrentOperations: 1`. Runtime tool schemas and tool-local guard callbacks also acquire individual actual-lifetime permits through the broker's trusted `acquireCallback` seam; no executor or wrapper holds a slot while waiting for these callbacks. Standalone broker hosts must supply their own scheduler to obtain that bound. Hook calls themselves do not consume model steps or inferred costs; their tools and checks consume ordinary shared call/cost ceilings. A timed-out callback cannot later dispatch its returned actions.

Explicit block returns `GUARD_BLOCKED`; invalid decisions/callback failures return `GUARD_UNAVAILABLE`. Runtime cancellation, timeouts, grants, limits and budgets retain their meaningful codes with sanitized messages. A successful original tool whose release hook fails remains succeeded/withheld in run evidence. Unknown external/read action effects remain `outcome_unknown` and require reconciliation; pure computation cancellation retains the broker's cancelled/failed outcome and unknown receipt. Never automatically retry unknown effects.

Runs with hooks include run-qualified tool receipts in `outcome.evidence`; late known evidence remains inspectable without rewriting the terminal outcome. Action call IDs are runtime-generated `hook:<uuid>:<index>`, disjoint from model-issued IDs. They are process-local correlation, not durable deduplication.

`hook.started`/`hook.completed` expose only hook identity, stage, generated invocation ID, step, attempt and completion status. No candidate, action arguments, policy text or error message is included. `beforeExecution` uses `context.step: null`; event metadata uses `step: 0` with that stage as its explicit discriminator. The optional client/observer accepts these strict metadata events; the observer includes them in total event counts, not a new hook-specific metric.

Run the complete credential-free example after building:

```sh
node examples/lifecycle-hooks.mjs
```

See the [acceptance contract](../specs/lifecycle-hooks.md), [shared budgets](shared-budgets.md), and [managed moderation](managed-guardrails.md). The full catalog — observer stages (`afterStep`, `afterModelCall`, `afterToolCall`, `afterDelegate`, `onViolation`, `afterExecution`, `onError`, `onCancel`, `onBlocked`, `onFinally`), the `beforeStep`/`beforeDelegate` control stages, context/memory/retry hooks and durable workflow delivery — is described below and in the [catalog spec](../specs/lifecycle-hook-catalog.md). Transforms, write/host actions and hook-triggered models/children remain out of scope.

## Observer hooks

```ts
const audit = defineHook({ id: 'audit', version: '1', stage: 'afterToolCall', mandatory: true,
  handler: async event => { await auditLog.append({ tool: event.toolId, status: event.status }); } });
const finish = defineHook({ id: 'metrics', version: '1', stage: 'onFinally',
  handler: event => { metrics.count(`run.${event.status}`); } });
const agent = defineAgent({ ...agentOptions, hooks: [audit, finish] });
```

Observers get a frozen, content-free view and return nothing. An optional observer (the default) that throws or times out is recorded as `hook.completed` with `status: 'failed'` and the run continues. A `mandatory: true` observer fails closed: the run ends `blocked` with `GUARD_UNAVAILABLE`, and a successful output is withheld. `onViolation`, `onError`, `onCancel`, `onBlocked` and `onFinally` can never change an outcome.

## Context, memory and retry hooks

```ts
await assembleContext({ ...options, hooks: { beforeContextBuild: () => ({ decision: 'continue' }), afterContextBuild: view => policy(view) } });
const memory = createMemoryStore({ ...options, hooks: { beforeMemoryWrite: event => screen(event.candidate), afterMemoryWrite: event => audit(event) } });
await retry(operation, { ...retryOptions, onRetry: event => event.error.code === 'TIMEOUT' ? { decision: 'continue' } : { decision: 'block' } });
```

These hooks are fail-closed. A blocked memory write stores nothing. A failed `afterMemoryWrite` rejects with a message stating that the write committed.

## Durable workflow hooks

```ts
const relay = createWorkflowHookRelay({ source: lifecycleRuntime, store, scope, relayId: 'notifications',
  hooks: { onApprovalRequested: event => notify(event.runId, event.nodeId, event.eventId), onFinally: event => close(event.runId) } });
await relay.deliver(runId); // call from a worker loop; resumes from a durable cursor
```

Delivery is at-least-once. Deduplicate on `event.eventId`. Trusted callbacks can capture outside references; declared effects are not hard isolation.
