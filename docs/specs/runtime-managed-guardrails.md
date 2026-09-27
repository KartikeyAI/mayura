# Runtime-managed auxiliary guardrails

Status: implemented experimental ephemeral integration, locally exercised on 2026-09-20. Core accounting, genuine host bindings, runtime barriers and packed optional consumers have independent regression evidence; this does not close the enterprise release gates or qualify model quality.

Governing requirements: [framework plan §§8–9 and V08/V09/V12](../create-mayura-agentic-framework-plan.md), [technical proposal §7](../mayura-technical-proposal.md), [existing auxiliary helpers](auxiliary-guardrails.md), [processor boundaries](processors.md), [ephemeral orchestration](agent-orchestration.md), and [current status](../development-status.md).

## 1. Smallest useful delivery

Automatically run explicitly configured auxiliary moderation checks at the existing ephemeral agent input and output barriers. Their calls belong to the actual run: its account, ancestor counters, operation permits, verified scope, grants, deadline and cancellation. Developers do not obtain or manufacture a runtime budget to configure a guard.

The first slice includes immutable managed-check definitions, runtime binding, local pre-egress checks, typed tool-free moderation responses, whole-candidate required barriers, protected output-check reservations, safe evidence and late accounting. It supports root agents and the existing required ephemeral children, including agents/workflows composed through the existing runtime broker.

It does **not** add the lifecycle-hook catalog, hook-triggered effects, transforms, language detection/translation provisioning, streaming moderation, retries, dynamic provider routing, durable auxiliary calls, durable budget bundles, background delivery, general injection prevention or semantic-quality certification. Existing explicitly wired auxiliary helpers remain supported under their existing narrower contract.

Lifecycle hooks are the next dependent phase. They must reuse this admission layer rather than introduce another model/budget path. Their ordering, action requests, recursive-hook policy and durable delivery are not implicitly settled here.

## 2. Why the current implementation is insufficient

`createAuxiliaryCheck` currently captures a caller-supplied `Budget` and permissions when constructed. It has sound bounded validation and late-usage behavior, but it cannot obtain the owning runtime's private account, increment that run's model-call counters or acquire its operation permits. A real but unrelated account is not shared runtime accounting.

The runtime currently calls ordinary `Guard.check` callbacks and owns money/call/operation accounting only for primary models and tools. Passing another callback through that surface cannot, by itself, establish mediated auxiliary execution.

Before this slice, `Budget.reserve` reserved money and consumed a call immediately, with no protected future-call bundle or independently cancellable never-dispatched ticket. A child ceiling is not an earmark. Checking a snapshot and reserving later races other branches.

## 3. Minimal authoring API

Implemented authoring API:

```ts
import { defineModerationGuard } from "mayura/guardrails";
import { defineAgent, createRuntime } from "mayura/runtime";

const moderation = defineModerationGuard({
  id: "content-policy",
  version: "1",
  model: moderationModel,
  instructions: "Apply the application's explicit content policy.",
  egressGuards: [localDestinationCheck],
  limits: { timeoutMs: 5000, maxInputBytes: 65536 },
});

const agent = defineAgent({
  ...agentDefinition,
  guards: { input: [moderation], output: [moderation] },
});

const runtime = createRuntime({
  profile: "ephemeral",
  scope: applicationScope,
  permissions: {
    allow: ["model:primary-model", "model:moderation-model"],
  },
  limits: { maxCostMicros: 100000, maxModelCalls: 12 },
});
```

The factory returns an opaque immutable managed-guard definition, not a callable model executor. It accepts no budget, permissions, runtime, scope override, credential discovery callback or arbitrary execution gateway. Model/price/destination selection remains explicit application configuration. The typed moderation result is the existing bounded `{ decision: 'allow' | 'block', categories: string[] }` structure.

`AgentOptions.guards` accepts both existing local guards and these registered managed definitions. Definition snapshots preserve their registration identity and callable/schema references without mutating caller-owned configuration. Duplicate IDs, foreign/forged definitions, unknown fields, invalid limits and unsupported model capabilities fail before model work.

Managed definitions cannot be evaluated through a detached `check`/`evaluate` method or serialized runtime identity. The explicit trusted-host bridge below lets the runtime recognize the definition; the runtime's private evaluator binds each invocation to its actual run. No execution gateway is passed through `GuardContext`. Never put a `Budget`, dispatch ticket, parent handle or mutable permission object into public guard context or events.

The existing `createModerationGuard`/`createAuxiliaryCheck` helpers retain explicit caller-wired semantics. They do not silently acquire a different account. Ordinary application callbacks remain trusted code; the framework cannot prove that a captured callback makes no direct network call.

### 3.1 Public definition and agent types

The core type is an opaque handle whose visible fields contain correlation metadata only. A module-private registration, not the discriminator or a copied TypeScript shape, establishes its identity:

```ts
// mayura/core: metadata/types only; no callable executor on this handle.
interface ManagedGuardDefinition {
  readonly kind: "mayura.managed-guard";
  readonly id: string;
  readonly version: string;
}
interface ManagedModerationVerdict {
  readonly decision: "allow" | "block";
  readonly categories: readonly string[];
}
type AgentGuard = Guard | ManagedGuardDefinition;

// Additive substitutions in mayura/runtime's existing generic agent types:
// AgentOptions<I, O>.guards?: {
//   readonly input?: readonly AgentGuard[];
//   readonly output?: readonly AgentGuard[];
// }
// AgentDefinition<I, O>.guards: {
//   readonly input: readonly AgentGuard[];
//   readonly output: readonly AgentGuard[];
// }
```

`mayura/guardrails.defineModerationGuard` accepts the authoring fields in §3 and returns `ManagedGuardDefinition`; its public options do not expose input/output schema replacement in this first moderation-only slice. The helper supplies the existing identity JSON input schema and strict moderation-result schema: exactly `decision` and `categories`, an `allow`/`block` decision, and at most 32 unique category IDs matching `/^[a-z0-9][a-z0-9._-]{0,63}$/`. No reason strings, extra fields, coercion or transforms are introduced. The verdict shape remains structurally compatible with the existing guardrails `ModerationVerdict`, rather than introducing another classification vocabulary.

Require an explicit `egressGuards` list on the new factory, allowing `[]` only as an explicit choice that supplies no local screening guarantee; every supplied local guard is mandatory. This does not change existing standalone helper defaults. `GuardContext` retains its existing run/call/scope/signal/boundary fields and does not acquire model, check or destination descriptors. Destination-specific local guards must capture the application's explicitly selected and pinned adapter/destination policy when defined. The framework does not infer a destination URL or certify that arbitrary content is safe to send there.

`defineAgent` retains each genuine managed handle by exact object identity when it freezes a new guard array. It must not spread the handle, wrap it in a synthetic `check`, bind an absent callback or clone a private descriptor into the agent's public metadata. Existing local `Guard` callbacks retain their current captured-function snapshots. The combined boundary still allows at most 32 uniquely identified guards; local/managed ID collisions fail before model work. A foreign package-instance handle, proxy, structural copy or serialized reconstruction is not registered, even when its visible fields match.

### 3.2 Explicit trusted-host core bridge

The `mayura/core/host` subpath exports the following small integration seam. It shares the same core module registrations as the main entry point; neither package relies on an inaccessible private import, a global symbol registry or an implicitly shared context slot.

```ts
interface ManagedGuardLimits {
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
}
interface ManagedGuardDescriptor {
  readonly kind: "moderation";
  readonly id: string;
  readonly version: string;
  readonly model: ModelAdapter;
  readonly instructions: string;
  readonly input: Schema<JsonValue>;
  readonly output: Schema<unknown, ManagedModerationVerdict>;
  readonly egressGuards: readonly Guard[];
  readonly limits: ManagedGuardLimits;
}
function registerManagedGuardDefinition(
  descriptor: ManagedGuardDescriptor,
): ManagedGuardDefinition;
function readManagedGuardDefinition(
  value: unknown,
): Readonly<ManagedGuardDescriptor> | undefined;
```

Registration validates and snapshots the complete descriptor before installing a frozen handle in a private `WeakMap`. It captures the model's ID, capability flags, maximum cost and bound `generate` reference; Standard Schema metadata/validator references; local egress IDs/bound callbacks; bounded instructions; and fully resolved finite limits. It freezes its owned nested metadata/arrays without freezing caller-owned models or schema-library objects. It rejects unknown fields, accessor-driven configuration, invalid limits/capabilities and managed definitions in local egress positions. The first kind requires structured output but does not require a model's `tools` capability to be false: the auxiliary request itself always has `tools: []`, and a tool-call response is invalid.

Resolved factory defaults are `timeoutMs: 10000`, `maxInputBytes: 65536`, `maxOutputBytes: 65536` and `maxOutputTokens: 1024`; descriptor limits contain all four positive safe-integer fields, with timeout within the supported timer range. The runtime further clamps these limits to its actual run/ancestor ceilings. Authoring-field/model metadata snapshots use captured data values, not repeated getter reads. Host registration can capture trusted custom schema references, but this first profile introduces no transformations: the runtime independently enforces the exact bounded raw moderation-verdict shape and unchanged admitted candidate/verdict values before and after schema validation. A schema cannot coerce malformed categories into an allow result or replace a block verdict.

The descriptor contains **no** budget, permission list, scope, run handle, dispatch ticket, context-binding slot, executor override or invocation callback. It contains a captured model and schema/local callbacks because a custom runtime must be able to execute the configured policy through its own admission layer. `readManagedGuardDefinition` is a registration lookup, not an invocation, and returns `undefined` for unregistered values without inspecting arbitrary properties. Its returned descriptor is immutable and is never attached to `GuardContext`, model messages, run inspection or events.

These host exports are trusted-computing-base integration APIs, not a sandbox boundary. Application code already supplied the model and can call its original reference directly; obtaining a descriptor does not make malicious local code contained or accounted. Mayura's claim is narrower: its own supported managed execution paths always use its private runtime evaluator. The bridge adds no dependency from runtime to guardrails and no provider/native/database dependency to core.

The host entry also supplies `snapshotLocalGuards(guards: readonly Guard[]): readonly Guard[]` as shared configuration validation. It reads bounded dense own array data, captures local IDs/method references without invoking getters, rejects reserved managed markers (including inherited/accessor markers), and preserves unrelated data metadata such as an application's different `kind`. It creates no execution authority. Consumers retain their existing ID/uniqueness rules; mixed agent lists separately preserve genuine managed handles. No supported guard-list path calls a caller-overridden array `map` or iterator to establish registration.

### 3.3 Runtime binding and fail-closed consumers

The runtime reads a recognized descriptor into its private run-state evaluation record. That record pins the exact managed handle, boundary, immutable candidate, invocation identity, account, model-kind ticket, deadline and operation permit; none is minted from fields supplied in `GuardContext`. Reusing the same definition across roots or children creates separate records against each actual owning account and its ancestors, not a shared captured account.

A missing descriptor is never an allow verdict. An object declaring `kind: 'mayura.managed-guard'` without a matching registration is invalid and cannot fall back to a local callback. Consumers that do not support this profile—standalone tool guard arrays, ordinary processor/pipeline guard positions, explicit caller-wired auxiliary helpers and durable runtimes—reject managed handles before dispatch rather than call a synthetic executor, ignore them or allocate a new budget. Preserve existing local-guard compatibility; rejection of a managed marker must not execute its supplied getters or `check` method.

The host bridge is the only cross-package recognition mechanism in this proposal. `mayura/guardrails` supplies definitions, core supplies identity and types, and `mayura/runtime` owns invocation admission and execution. No managed gateway is added to the public context. Duplicate copies of core deliberately fail closed instead of accepting serialized brands; packed-consumer tests must verify the supported package graph resolves the shared registration correctly.

## 4. Mandatory prerequisite: atomic reservation bundles

The core accounting primitive was independently tested before runtime integration. Its concrete API is additive:

```ts
interface BundleOperation {
  readonly id: string;
  readonly maxCostMicros: number;
}
interface BudgetTicket {
  readonly id: string;
  readonly maxCostMicros: number;
  start(): Reservation;
  cancel(): void;
}
interface BudgetBundle {
  readonly tickets: readonly BudgetTicket[];
  close(): void;
}

// Add to the genuine core Budget class:
reserveBundle(operations: readonly BundleOperation[]): BudgetBundle;
capacitySnapshot(): Readonly<{ heldCalls: number }>;
```

`Reservation` remains the existing settlement-only handle. Bundle/ticket objects and their arrays are frozen; authoritative transitions live in private registrations. There is no application-supplied ticket constructor, alternate account or executor on the public ticket.

### 4.1 Atomic creation

A bundle contains a finite list of immutable execution tickets, each with a unique bounded identity and fixed maximum cost. Its owning account is the genuine run account. Creating it synchronously validates **all** ancestors and reserves the total money and required call slots atomically, without callbacks or awaits. Failure changes no account or ticket state, including identity registration. Runtime operation kinds are bound in its separate private admission registry, not inferred by parsing ticket IDs.

Every ordinary reserve and every later child admission/reserve must account for outstanding bundle holds. Siblings cannot spend the held funds or use held calls. Ancestor totals include descendants; do not sum them as separate charges.

Keep `Budget.reserve` and `snapshot()` unchanged: the latter remains `{ spentMicros, reservedMicros, calls }`. Bundle-held money is included in `reservedMicros`; a held future ticket does not increment `calls`. `capacitySnapshot().heldCalls` reports the distinct held future-call slots, including the account's descendants. `ticket.start()` converts one held slot to one consumed call on every ancestor without changing the monetary reservation. Historical started calls are never refunded. Exposing this additional capacity view in runtime inspection/events requires explicitly additive contracts, corresponding observer allowlists and packed type tests; do not silently insert fields into existing event payloads.

### 4.2 Genuine single-use tickets

Ticket authority is private state, not a TypeScript-only `readonly` field. Structural copies, proxies, serialized IDs and reused/cancelled tickets cannot authorize a core transition. Core tickets bind their genuine account lineage; the runtime additionally binds operation kind, pinned adapter/tool identity and intended invocation. Another run cannot borrow a valid ticket. Output checks bind their exact candidate at consumption.

`ticket.start()` is the only held-to-started transition and returns one genuine `Reservation`. It rechecks account/ancestor closure and ledger overrun before changing counters. Repeated start, start after cancel and start after bundle closure fail with `CONFLICT` without returning another reservation. After all local validation, queueing, grants and cancellation checks, the runtime calls it immediately before invoking the selected executor and records its single-dispatch state synchronously. No reusable start acknowledgement, alternate handler or ordinary `reserve` may turn that ticket into another execution. The broker needs a trusted ticket-consumption seam for an already-reserved tool; it must not reserve the same operation again or accept a fake `Budget` facade.

`ticket.cancel()` releases only a held ticket's money and call slots, once, including after its owning account closes. Repeating cancel on the already-cancelled ticket is an idempotent no-op. Cancel on a started, unknown or settled ticket fails with `CONFLICT` and cannot refund it. `bundle.close()` is idempotent: cancel its remaining held tickets but leave every started reservation intact. Runtime terminal/abort paths close their bundles; `Budget.close()` still stops new admissions and never forgives started unknown usage. Do not use `settle(0)` to represent cancellation; zero is valid known usage of a started operation and still consumes its call.

Once dispatched, unknown usage retains the monetary reservation and consumed call. Known cost settles once, even after timeout, cancellation, account closure or another operation's overrun. An overrun records the full exact charge and stops new admissions; it does not make prior output-check holds a promise of available credit after a provider violates its bound. Repeated/conflicting settlement fails without changing totals a second time.

Never emulate bundles with a new budget, a prepaid child account, a snapshot balance check, reserve-and-refund, or an unvalidated caller-supplied reservation object. Proposed first qualification limits are 1–128 operations per bundle, 1,024 outstanding held/unsettled tickets and 16,384 lifetime ticket identities per entire shared ledger. IDs are unique across that ledger, including after cancellation/settlement, and use bounded ASCII identifiers of 1–256 characters. Bounds fail before mutation; no silent identity reuse or history eviction. Revisit these documented correctness-first limits only with resource evidence.

### 4.3 Money and kind-specific counters agree

`maxModelCalls` includes primary **and auxiliary** model calls. Auxiliary calls do not consume agent reasoning steps. `maxToolCalls` retains tool-attempt meaning. All relevant counters and holds apply to every ancestor, including an intermediate child ceiling. Zero-cost calls consume the same call capacity as paid calls.

The core bundle protects generic call slots **only**. It does not solve the runtime's separate model/tool counter ownership. That later runtime prerequisite must reserve corresponding model/tool slots in the same synchronous admission step: validate every predicate before mutating either ledger, then commit core holds and the nonthrowing runtime counter projection without an intervening callback/await. The admission transitions specified below convert holds to consumed counters once; cancellation releases only unconsumed holds. Passing core bundle tests alone does not qualify runtime counters. Ordinary reserves and bundles created from any child account must include all ancestor held calls in admission checks; a fork remains a ceiling over the same ledger, never a way to copy reserved capacity.

Preserve the runtime's existing distinction between model dispatches and tool **broker attempts**. A model-kind hold converts to its historical model-call count together with its model ticket's dispatch. A tool-kind hold converts once immediately before `invokeTool` starts that broker attempt; its financial/generic-call ticket starts later, only at the broker's existing reserve point after input guards and permit admission. If broker admission fails before executor dispatch, cancel the never-started financial ticket and release its money/generic-call hold, but retain the historical tool-attempt count. Do not describe that attempted call as refunded. This preserves `maxToolCalls` behavior without a callback from the tool broker that mutates runtime counters.

The runtime therefore keeps a private per-operation kind-hold registry separate from core's generic tickets. It snapshots and validates all operation records and every ancestor's consumed-plus-held counters before calling `reserveBundle` with newly created plain internal data. After core admission succeeds, it commits only nonthrowing private counter increments in the same synchronous turn, without a user callback, getter, hook, logger or await in between. Kind-limit failure leaves core untouched; core failure leaves kind counters untouched. Invocation/cancellation transitions follow the same no-callback rule. Caller-controlled objects must not reach the middle of this commit path, even though core separately protects against reentrant configuration inspection.

### 4.4 Pre-reserved tool broker seam

The existing `InvokeToolContext.budget` remains a genuine `Budget`. Do not replace it with a facade or let the caller provide a `Reservation`, `reserve` implementation or arbitrary ticket-consumption callback. The host APIs are:

```ts
// mayura/core/host: validates private ticket and exact account identity.
function assertBudgetTicket(
  value: unknown,
  owner: Budget,
): asserts value is BudgetTicket;

// mayura/tools/host: captured, opaque binding; no public start/settle methods.
interface ToolBudgetTicketBinding {
  readonly kind: "mayura.tool-budget-ticket";
}
function bindToolBudgetTicket(
  tool: AnyTool,
  ticket: BudgetTicket,
  context: Pick<InvokeToolContext, "budget" | "runId" | "callId" | "scope" | "signal">,
): ToolBudgetTicketBinding;

// Additive trusted option in the existing mayura/tools invocation contract:
// InvokeToolContext.budgetBinding?: ToolBudgetTicketBinding;
```

`assertBudgetTicket` checks the ticket and `Budget` through their private registrations and requires the ticket's **exact owning account**, not a matching string ID, common root, ancestor or sibling. It does not transfer a ticket, return its owner, start it or mint funds. The usual core state transition still rejects cancelled, started or closed-account tickets.

The tools host factory first requires the exact registered `AnyTool`, a genuine owner-matching ticket and a ticket cost bound equal to the captured tool's fixed `costMicros`. It snapshots the exact account reference, exact tool registration/definition reference, run ID, call ID, principal/project scope and original invocation signal into a tools-private binding. The visible frozen handle contains none of those authorities. A ticket cannot be rebound to a different tool or invocation; copied/proxied bindings and serialized IDs carry no authority.

`invokeTool` recognizes and claims that binding once before any asynchronous admission work; a second or concurrent attempt with it fails closed. It checks the captured invocation against the actual `options` and tool, then still performs its ordinary grant, input-schema, input-guard, cancellation, operation-permit and `beforeDispatch` checks. At the existing `budget.reserve(tool.costMicros)` point, it rechecks genuine owner/binding state and synchronously consumes `ticket.start()` instead of making a second reservation. That single reservation remains broker-owned for exact settlement and existing receipt/disclosure behavior. No alternate path can bypass permissions or invoke an alternate executor using a returned start acknowledgment.

Claiming the binding is not financial dispatch. An attempt that fails before ticket start cannot reuse its binding; the owning runtime closes/cancels the still-held ticket in its attempt cleanup. If ticket start already occurred, cleanup must not refund it, including when the handler is still pending or its result is unknown. Binding identity/state checks must not expose an account, ticket, raw input or callback through the tool's `ExecutionContext`, `GuardContext`, `contextBindings`, receipts or events. Missing `budgetBinding` preserves standalone `invokeTool`'s existing ordinary-reservation behavior.

Like the descriptor bridge, the binding factory is explicit trusted-host plumbing. A host that possesses a genuine account and ticket already possesses those accounting capabilities; the factory is not a sandbox or an authentication system. Within Mayura's runtime, only its private admission code creates these bindings, and it never accepts a caller-supplied binding for a run. Thus a model, local guard context or unrelated run cannot borrow another operation's capacity through an exposed gateway.

## 5. Where bundles are created

- **Input:** after bounded schema admission and required local checks, atomically reserve the configured managed input checks. Complete the entire required barrier before primary generation or tool execution. This is not prepayment for the whole run.
- **Primary generation:** before invoking the primary model, reserve that call together with one complete set of required managed final-output checks. Validate destination grants/configuration up front. If the response is a final candidate, those exact tickets guard it. If it is instead a complete validated tool proposal, cancel the never-used final-output tickets; they do not pay for some unrelated later call.
- **Tool result:** before each tool dispatch, reserve its fixed cost and its required managed output checks together. A successful effect followed by blocked output still charges the effect and preserves its receipt. No prospective tool effect starts merely because a later output-check reservation might succeed.
- **Composition:** wrapper output-check holds remain on the true ancestor account while required children execute. They hold money/calls, not operation permits. Child work competes only for the remaining shared capacity. Do not charge child maxima to the zero-cost wrapper.

The first profile uses a fixed finite guard set at each boundary. It does not reserve for every possible future loop iteration or invent the number of tool calls before the primary response exists. Each subsequent operation establishes its own bundle before dispatch. Cancellation, local output rejection or an unusable provider envelope cancels only that operation's remaining undispatched tickets.

Required checks can still be unavailable, deny content or be prevented by cancellation, revocation, deadlines or an over-bound provider. In those cases withhold output; preallocation is not a guarantee that checks always run or content will be released.

## 6. Operation permits and lifetime

Use the existing atomic ancestor `OperationPermits` path for every primary/auxiliary model and ordinary tool executor. Acquiring a financial bundle does not acquire compute capacity. An auxiliary call queues with the owning run's abort signal and earliest deadline, then rechecks active authority before consuming its ticket.

Never hold a primary/tool execution permit while awaiting that operation's output moderation. Release it when the actual executor settles; acquire a separate permit for each auxiliary call. A guard barrier waiting for permits holds no partial ancestor permits. The one-permit configuration must make progress through primary generation followed by required output checks.

On timeout, a noncooperative model continues owning its operation permit until its actual promise settles. The returned failure does not free capacity for an unlimited number of hanging callbacks. Pending queues, concurrent local guard callbacks and admission attempts also need finite ownership limits. Repeated timeouts cannot evade limits by moving the same unresolved work into new wrappers.

Run cancellation closes new ticket consumption, cancels undispatched tickets and stops queued calls. Actual pending model responses retain accounting callbacks and settle known late cost. Inspection may show later accounting changes; the original terminal outcome remains immutable and no late content is admitted.

## 7. Non-recursive auxiliary admission

The managed path receives only its selected immutable candidate, check instructions and minimal scoped metadata. It never inherits the primary transcript, system instructions, tools, provider continuation, sibling input or credentials through a generic context object.

For each check: validate bounded plain JSON and schema → run configured required **local** destination-aware egress guards → obtain the operation permit → recheck live authority → consume its ticket → send one explicit tool-free request → settle independently known usage → validate the complete final envelope/schema → produce a bounded verdict.

Use existing auxiliary defaults where compatible: 10-second check timeout, 64-KiB complete request/response bounds and 1,024 requested output tokens, clamped to the owning runtime's stricter limits and deadline. Bound instructions plus serialized messages together. No hidden provider, credential lookup, retry, repair, fallback, token streaming, tool execution or continuation forwarding.

Auxiliary egress does not reenter the primary moderation pipeline or future general lifecycle hooks. Local egress-guard configuration cannot contain managed auxiliary definitions; reject such graphs rather than recursively invoking them. Reentry through an already-claimed private evaluation record also fails closed; there is no managed gateway in a public context to reuse. Trusted local callbacks can capture arbitrary code; this is not process isolation or prevention of all direct calls by malicious application code.

## 8. Exact barriers and disclosure

Preserve existing input/output boundary semantics: input guards inspect the schema-admitted agent input; output guards inspect admitted tool results before they enter model history and final agent output before release. This slice does not pretend those barriers newly inspect the entire assembled model request or every instruction source.

Run required local guards before auxiliary egress when they are intended to prevent disclosure to that destination. Required managed checks then evaluate the same frozen candidate and policy/definition snapshot; their completion order cannot select or mutate content. A single block, malformed verdict, unavailable check or deadline prevents release. Do not reuse an input verdict for output, a previous version, another run or a later same-content invocation without a separately qualified cache contract.

No transforms are introduced here. Input/output schema transformations remain explicit and the exact admitted value is fingerprinted. A future transform invalidates previous verdicts and output-check ticket bindings; lifecycle-hook design must preserve that rule.

Record only safe check/model IDs, run/call lineage, boundary, candidate/check version or digest, status and accounting metadata. Do not emit original/derived content, category text outside its bounded schema, raw provider messages, protected instructions or continuation. Known malformed-response usage and `ModelInvocationError` cost remain settled before rejecting the payload. Unknown usage is visible as retained reservation, not zero cost.

The implemented observer contract reuses `model.started` and `model.completed` with `purpose: 'guardrail'`, `modelId`, `checkId`, `checkVersion`, `boundary` and `callId`. Started calls add `modelCall`; completed validated verdicts add `response: 'final'` and `decision: 'allow' | 'block'`. No `step` is fabricated for these calls. Primary event shapes remain unchanged. Categories and candidate content are not emitted. Native observer allowlists and the isolated packed managed-consumer fixture exercise this additive form.

## 9. Profiles and package independence

Managed definitions are not tied to Arth or a concrete provider. `mayura/guardrails` remains optional and core-based; core owns the minimal identity/admission contracts, while the runtime implements execution. The base SDK does not gain a mandatory guardrail/provider/native/database dependency.

The same definition may eventually be bound by another qualified runtime profile, but only the ephemeral agent profile is implemented by this slice. A durable or standalone caller lacking the managed capability fails explicitly before side effects; it cannot fall back to a fresh volatile account. Existing durable/scheduled format-2 storage is untouched. Durable reservations, call tickets, restart reconciliation and durable auxiliary evidence require a separate transaction/version contract.

Existing local guards and caller-wired standalone helpers retain their documented behavior. Only runtime-managed definitions carry the automatic-accounting claim. Do not advertise that arbitrary trusted TypeScript callbacks are mediated merely because they are registered as guards.

## 10. Fail-first acceptance tests

These tests precede implementation, use deterministic fake adapters, and require no credentials or paid requests.

1. Atomically reserve a multi-ticket bundle across root/intermediate/child accounts; competing ordinary and bundled calls cannot consume its money or held calls. Failed admission changes nothing.
2. Reject forged, reused, wrong-kind, wrong-owner and cancelled tickets; consuming one ticket cannot dispatch twice. Zero-cost tickets still protect and consume call capacity.
3. Cancel only never-dispatched tickets, once. Dispatched unknown usage stays reserved; late known settlement after closure/overrun records the exact charge once.
4. A primary call cannot begin when its required output checks cannot be reserved. A competing child cannot consume their protected capacity while generation runs.
5. A tool effect cannot begin without its output-check bundle. Successful effects retain succeeded/withheld receipts when output moderation fails or times out.
6. Input moderation denial/unavailability causes zero primary/tool dispatch. A known unavailable required output destination is rejected before generation.
7. One operation permit progresses through input checks, primary generation and output checks; queued children hold no partial ancestor permits. Hanging auxiliary callbacks retain actual capacity after logical timeout.
8. Concurrent checks and child checks consume ancestor model-call limits and money once. No fresh account, duplicate reservation, parent counter bypass or free-call amplification occurs.
9. Cancellation before permit/ticket consumption produces zero adapter calls and releases only undispatched holds. Cancellation after dispatch preserves unknown/late accounting without outcome resurrection.
10. Reject auxiliary recursion, managed egress guards, forbidden tool proposals/continuation, malformed/accessor verdicts, missing model grants and foreign/detached contexts.
11. Complete parallel barriers bind all verdicts to the same immutable candidate; mutation attempts, delayed stale verdicts and input-to-output reuse cannot authorize release.
12. Known usage from invalid envelopes/provider errors settles before rejection; raw exceptions, original content, prompts and continuation never enter public metadata.
13. Reusing a managed definition across independent roots/children binds the correct account every time. An incompatible profile rejects rather than silently provisioning standalone execution.
14. Preserve existing standalone auxiliary, tool, child-agent and ephemeral-workflow behavior; verify packed positive/negative types and unchanged optional-dependency boundaries.
15. Through actual packed core/guardrails/runtime entries, recognize the same genuine managed handle and preserve it in agent snapshots. Reject copied, proxied, foreign-instance and serialized handles before any callback; unsupported consumers never ignore or execute a managed marker. Mutating original descriptor/model/schema/guard metadata cannot replace captured references. Neither context nor public metadata exposes a descriptor, account, ticket or evaluator.
16. Reject a pre-reserved tool binding for the wrong exact account (including a same-root sibling), tool registration, run/call/scope or original signal. Reject fake/copied bindings, rebinding and concurrent/repeated use. Correct use consumes only its pre-held ticket, never an additional ordinary reservation, while missing grants and failed guards still cause zero handler executions.
17. A failed broker admission consumes one historical `maxToolCalls` attempt, releases only the never-dispatched financial/generic-call hold and leaves model-kind holds unchanged. Successful broker dispatch consumes its financial ticket once; output rejection or late unknown effects never refund it. No runtime-counter callback is required inside the broker.
18. Failed core or kind-counter admission changes neither half of the private combined commit. Competing siblings, free calls and reentrant caller configuration cannot observe or exploit a partially installed money/model/tool hold; invocation inputs are completely snapshotted before this callback-free commit.

Delivery order: review the contract and finite accounting limits → add failing core bundle tests → implement/verify core accounting → add failing runtime barrier/permit tests → bind managed definitions → run existing and packed-consumer regressions. Only then design the dependent lifecycle-hook slice. V08/V09/V12 and enterprise release qualification remain open.
