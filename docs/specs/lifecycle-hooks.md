# Ephemeral lifecycle control hooks

Status: implemented experimental ephemeral subset; qualification evidence is recorded in the [development ledger](../development-status.md). This slice follows runtime-managed moderation. It supplies part of F09/F21 and V01/V08/V12, not the full lifecycle catalog or enterprise release.

Authority: [framework plan §8](../create-mayura-agentic-framework-plan.md), [technical proposal §7](../mayura-technical-proposal.md), [managed guardrails](runtime-managed-guardrails.md), and [orchestration](agent-orchestration.md). The user has authorized continued implementation. The initial independent review confirmed raw-proposal semantics, callback lifetime, exact action identities and private shared accounting requirements.

## 1. Scope and authoring

Implement four **required control** stages: `beforeExecution`, `beforeModelCall`, `beforeToolCall`, and `beforeOutputRelease`. They run in registration order, are awaited and fail closed. The [primary-model extension](primary-model-hooks.md) specifies the content projection and protected primary admission. Optional observer hooks, the rest of the lifecycle catalog, transforms, hook-triggered models/children, writes/host effects, durable hook delivery/replay and `onFinally` recovery are separate slices. Existing metadata observation remains available independently.

```ts
const check = defineHook({
  id: 'project-policy', version: '1', stage: 'beforeToolCall',
  tools: [assertProjectReadable],
  timeoutMs: 5000,
  handler: event => ({
    decision: 'continue',
    actions: [{ toolId: 'project.assert-readable', input: event.proposal.input }],
  }),
});
const agent = defineAgent({ ...agentOptions, hooks: [check] });
```

`defineHook` is exported by runtime and SDK. It returns a frozen opaque `HookDefinition<S>` with `kind: 'mayura.control-hook'`, id, version and stage, but no callable handler, tool registry, budget or execution gateway. Runtime-private registration retains captured callback and exact tool references. Stage generics infer the callback's event; tool IDs remain strings because existing `ToolDefinition.id` is not a literal-generic catalog.

Required options: bounded stable id/version/stage, explicit `tools` array (empty allowed), callable `handler`. Optional `timeoutMs` defaults to 5000 (maximum 30000), `maxActions` defaults to 4 (maximum 8), `maxResultBytes` defaults to 65536 (maximum 1 MiB). Positive safe-integer limits only. Reject unknown fields, accessors, sparse/custom-method arrays, duplicate registry IDs, forged tools, unsupported stages and invalid bounds at definition time. Capture ordinary class callback receivers without invoking getters or callback-owned `.bind` properties. Do not freeze caller-owned objects.

Only exact registered tools with declared `effects: 'none' | 'read'` are allowed, with at most 32 tools per hook; reject genuine agent/workflow composition tools even when they declare `none`. A declaration is trusted application metadata, not containment of a malicious handler. Each hook's private tool catalog is separate from the model-visible agent catalog. Registering a tool never supplies its capability grants.

`AgentOptions.hooks` is an optional dense ordered array of at most 16 genuine definitions, with unique IDs across the agent. Preserve exact handles; copies, proxies and reconstructed metadata fail. Existing agents default to an empty array. One definition can be reused across roots/children, but every invocation obtains its actual owning run's authority independently.

## 2. Immutable inputs and strict results

Stage-specific event shapes:

```ts
type HookEvent<S extends HookStage> =
  S extends 'beforeExecution' ? { stage: S; input: JsonValue } :
  S extends 'beforeModelCall' ? {
    stage: S; purpose: 'primary'; modelId: string;
    request: Readonly<Pick<ModelRequest, 'messages' | 'tools' | 'maxOutputTokens'>>;
  } :
  S extends 'beforeToolCall' ? {
    stage: S; phase: 'proposal';
    proposal: { callId: string; toolId: string; input: JsonValue };
  } : {
    stage: S; source: 'agent' | 'tool'; callId: string;
    toolId?: string; candidate: JsonValue;
  };

type HookDecision =
  | { decision: 'block' }
  | { decision: 'continue'; actions?: readonly { toolId: string; input: JsonValue }[] };
```

The second handler argument is a frozen `HookContext`: runId, rootId, optional parentId, agentId, verified scope, invocationId, hookId, hookVersion, step (number or null), attempt (literal 1), and the hook's bounded cancellation signal. It contains no transcript, instructions, permissions, account, ticket, handle, descriptor or callback executor. Candidate/proposal values are bounded immutable snapshots, not mutable model history. `beforeToolCall` deliberately exposes the **raw proposal**: the broker still validates/transforms input at its own final admission boundary. No promise that this raw value equals schema-transformed executor input.

Validate the complete returned plain JSON union before any requested action. Block plus actions, transforms/replacements, unknown keys, missing fields, invalid tool IDs, accessor results, oversized data and excessive actions fail closed. Every action must resolve against this hook's exact captured registry; validate every action's tool grant and input schema before the first action. Execution is sequential and required-success. No response is fed back to the callback. Policy-read tools must encode failure in their outcome/schema/guards; a successful boolean false is not automatically a denial. The action list is not a transaction or a prepayment for all future work.

## 3. Ordering and denial

1. `beforeExecution`: after the agent input schema and complete required local/managed input guard barrier; before the first primary model. Earlier input denial runs no hook callback or hook action.
2. `beforeModelCall`: on every primary iteration after permission/request admission and reserving its primary/output-check bundle, but before acquiring its executor permit. Expose only immutable messages/tools/token-limit projection; never private instructions or continuation. Auxiliary checks do not recursively invoke this stage.
3. `beforeToolCall`: after model proposal envelope validation and batch identity/grant/schema preflight, and after reserving the prospective tool plus required output checks; before the original broker attempt. Hooks cannot change the original arguments. The callback and any requested actions run **without holding the original executor permit**. Keep its financial/check holds while hook actions compete for remaining capacity. Recheck cancellation and ordinary broker gates before original dispatch.
4. `beforeOutputRelease`: after the candidate schema and all required local/managed output guards; before a tool result enters model history or an agent candidate is returned. These hooks are control-only, so a previous denial cannot be reversed and no transformed candidate can skip a new verdict. Final-agent hooks inspect a candidate before the existing required-child join; they do not claim that the entire run has already succeeded. Child failure can still replace the parent candidate.

Each stage executes matching hooks in declared order. Block/unavailability stops later hooks/actions and prevents the protected operation or disclosure. A failed hook after a successful original tool keeps that tool's succeeded/withheld receipt. An uncertain external/read hook action retains its own unknown receipt and returns `outcome_unknown`, never a generic retryable failure. Pure computations preserve the existing broker's cancelled/failed outcome with unknown execution evidence when still pending. When hooks are configured, returned run evidence includes original and hook-action receipts as applicable, qualified by run ID. Known late receipts continue updating inspection without rewriting a terminal outcome. Live receipts stay withheld while any required output guard or hook remains pending.

No hook runs between the broker's final dispatch gate and executor invocation. Hook actions bypass all hook stages, preventing recursion, but still use the normal broker and the agent's required output guards. They cannot invoke composed agents/workflows or switch to an unregistered handler. Auxiliary moderation does not invoke hooks.

## 4. Accounting and callback lifetime

Add `RuntimeLimits.maxHookCalls` (default 128, maximum 4096). Actual local hook callbacks consume one hook-call slot on every ancestor, independent of model/tool/generic financial call counters; they consume no model step or inferred model charge. Check counters immediately before callback dispatch after acquiring an operation permit. No callback/await intervenes between ancestor counter checks and increments. Child ceilings cannot exceed ancestors. Admission caps, retained actual callback permits and existing root/descendant limits prevent timeout loops from creating unbounded pending callbacks.

The hook deadline covers callback queueing, callback execution, result admission, action preflight, all requested actions and their required output checks. It is clamped by the owning run/ancestor deadline. The actual callback owns an `OperationPermits` slot until its promise settles; a logical timeout cannot free that slot. Release it before invoking requested tools or acquiring any output-check permit. The one-permit configuration must progress.

Each hook action is a normal tool attempt against the actual private account: atomically reserve its fixed cost and required managed output checks, include ancestor model/tool holds, consume one historical maxToolCalls attempt at broker entry and use a genuine exact-owner ticket binding at dispatch. Never allocate a fresh budget, pass a public execution gateway or refund started unknown usage. Cancel only undispatched holds. Primary/auxiliary/tool charges and late settlement preserve the existing contract.

Independent fail-first review found that the existing broker's second input-schema validation, tool-local guards and output-schema validation did not acquire the runtime's callback pool. Add the trusted host seam `InvokeToolContext.acquireCallback(signal)` alongside executor admission. When supplied by the runtime, each actual schema/local-guard promise acquires its own permit and retains it until settlement, even after logical cancellation. Release it before an executor, another callback or managed check is admitted. Apply this to both ordinary runtime tools and hook actions, including composition-wrapper validation, without holding a wrapper executor permit across children. Standalone broker users without this optional seam retain their current scheduling behavior; this is not a new sandbox or automatic global standalone callback cap.

The same independent timeout test failed for the agent's own input/output schemas. Run those actual validators through individual owning-run callback permits as well; already-admitted composed child inputs still skip duplicate transformation. A logical run deadline cannot free their slots for newly accepted roots while the old validators remain pending. Late schema values never revive a terminal result or disclose content.

Runtime-generated call IDs use `hook:<uuid>:<index>`. Colons are rejected in model-issued call IDs by the existing provider-envelope validator but accepted in bounded broker receipts/observer IDs. Register every generated ID in the run collision set. Models/callbacks do not choose these IDs or execution attempt identities. Per-run hook invocations are finite and never automatically retried. This is process-local identity, not durable effect deduplication.

Use fixed sanitized errors. Block maps to `GUARD_BLOCKED`, unavailable/malformed callbacks to `GUARD_UNAVAILABLE`, and cancelled/timed-out/over-budget calls retain their existing codes. Real tool outcomes/receipts are propagated without raw callback exception text. Do not classify unknown effects as known failures. Arbitrary in-process callbacks remain trusted code and can capture outside references; these APIs do not sandbox JavaScript.

## 5. Safe observations and compatibility

Emit `hook.started` and `hook.completed` metadata containing bounded hookId, hookVersion, stage, invocationId, step (use a documented sentinel only if the existing event primitive cannot carry null), attempt and status. No input, output, requested argument, category, policy text or error message. Completed status is one of continued, blocked, failed, cancelled, outcome_unknown. Callback timeout cannot later emit a successful completion. Expand core/client closed event-type sets and observer exact allowlists together; unknown fields remain rejected. Hook tool executions use ordinary tool events and receipts with their generated IDs.

Use `step: 0` for beforeExecution only with `stage` explicitly distinguishing it; other stages report their actual zero-based current reasoning step. This is correlation, not an additional consumed step. Hook invocation IDs are bounded generated UUIDs; run/parent/root correlation stays in ordinary run metadata and callback context. Optional observer metrics count accepted hook events as events; specific per-hook aggregation is not claimed in this first slice.

No SQL/storage contract changes, new package dependency or implicit provider selection. Packed SDK types and optional managed/observer fixtures must continue passing. The base SDK exposes authoring without making guardrails, observer, server or provider packages mandatory.

## 6. Fail-first qualification

- Genuine definition/type inference, immutable capture, dense array/accessor rejection, safe errors, private tool registry, duplicate IDs, unsupported stages/effects/composition and forged handles.
- Required input guards precede hooks; before-tool denial causes zero original effects; output denial retains success/withheld evidence and prevents history/final release.
- Registration order, exact immutable candidate/proposal semantics, no transforms, no block+actions, whole action-list validation before first action, no result feedback and no recursive hooks.
- Exact scope/grants and ancestor model/tool/cost/hook limits; original output holds cannot be stolen; free callbacks/actions still consume their proper counters.
- One-permit callback→action→moderation progress, actual lifetime retained after timeout, cancelled queue cleanup, late callback cannot dispatch actions, known late action accounting and unknown receipts remain truthful.
- Required-child composition works for ordinary tools, hook actions cannot compose; hook tool IDs/receipts cannot collide with model proposals.
- Strict metadata/observer/client compatibility, packed positive/negative types, all existing agent/tool/workflow/guardrail tests and credential-free examples.

Optional observers, the remaining lifecycle stages, transforms, durable dedup/delivery, write/host approval and arbitrary plugins remain unimplemented. Passing this bounded slice must not close V01/V08/V12 or the full enterprise ledger.
