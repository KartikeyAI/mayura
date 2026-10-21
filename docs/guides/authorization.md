---
title: "Fine-grained authorization"
description: "Authorize scoped resources with the core policy contract and built-in role-based access control."
---

Use authorization to decide whether a verified principal may perform an action on a particular resource. The core
contract is exported from `mayura`; built-in role-based access control (RBAC) is available at `mayura/authz`.
Hosts call `authorize` or `require` explicitly before the protected operation, or configure
[scoped HTTP enforcement](server-and-client.md#scoped-resource-authorization) with the server `authorization` option.
Creating a policy alone does not install it on routes, tools or storage adapters. Ordinary [run grants](../concepts/permissions.md) and
[server capabilities](server-and-client.md) still apply.

## A scoped role policy

```ts
import { createRbacAuthorizer } from 'mayura/authz';

const subject = { principalId: 'alice', projectId: 'shop' }; // From verified authentication.
const authorizer = createRbacAuthorizer({
  permissions: { allow: ['authz:evaluate'] },
  limits: { timeoutMs: 1000, maxConcurrent: 32 },
  policy: {
    version: 'shop-policy-v1',
    roles: [
      { id: 'reader', rules: [
        { id: 'read-threads', effect: 'allow', actions: ['read'], resource: { kind: 'thread', id: '*' } },
      ] },
      { id: 'reviewer', inherits: ['reader'], rules: [
        { id: 'deny-sensitive', effect: 'deny', actions: ['read'], resource: { kind: 'thread', id: 'sensitive' } },
        { id: 'compact-own', effect: 'allow', actions: ['compact'], resource: { kind: 'thread', id: '*', owner: 'subject' } },
      ] },
    ],
    bindings: [{ subject, roles: ['reviewer'] }],
  },
});
try {
  const resource = { kind: 'thread' as const, id: 'support-chat', scope: subject, ownerId: 'alice' }; // Trusted metadata.
  const decision = await authorizer.authorize(subject, 'read', resource);
  await authorizer.require(subject, 'compact', resource); // Throws PERMISSION_DENIED unless explicitly allowed.
  // Perform the independently permissioned operation here, using the same verified scope/resource.
} finally { authorizer.close(); }
```

An `AuthorizationSubject` is the verified `{ principalId, projectId }` scope. An `AuthorizationResource` contains
`kind`, `id`, its trusted `scope`, and optional stored `ownerId`. Supported kinds are `agent`, `tool`, `run`, `workflow`,
`thread`, `memory`, `rag_document`, `human_request` and `server`. Resource and subject scopes must match on both fields, even for broad allow rules.
Read resource ownership/scope from trusted storage or host registry metadata; never accept them or role memberships
from request bodies. Authentication identifies the subject; authorization decides access; grants bound execution.

Actions are exact lowercase names such as `read`, `compact`, `approve` or `thread:read`, with at most 128 letters,
digits, underscores, dots, colons and hyphens, starting with a letter. They are application-defined and do not grant
runtime capabilities. `*` is not an action. Identifiers and versions are bounded to 128 letters, digits, dots,
underscores, colons, slashes and hyphens, starting with a letter or digit.

## Role and inheritance rules

A role has an `id`, explicit `rules` and optional `inherits` role IDs. Each rule has a globally unique `id`, an
`effect` (`allow` or `deny`), exact `actions`, and one `resource` selector. Selectors match an exact kind and resource
ID, or explicitly use `id: '*'` for all IDs **within the verified scope**. There are no regular expressions, action
wildcards, special administrator roles or implicit memberships. An empty policy denies everything.

Bindings assign up to 32 role IDs to one exact principal/project. A principal needs a separate binding in another
project. Duplicate bindings are refused; put all memberships in one binding. `owner: 'subject'` additionally requires
trusted resource `ownerId` to equal the principal; missing ownership metadata does not match.

All inherited and directly bound roles contribute rules. Any matching deny overrides every allow. If there is no
matching deny, a matching allow permits the action; otherwise access is denied. A decisive rule is chosen in stable
rule-ID order. Compilation refuses duplicate identities, unknown fields/references, cycles and excessive inheritance
rather than silently weakening the policy. Roles, grants and bindings are captured immutably. Update a policy by
creating a new versioned authorizer, replacing the host reference and closing the old one.

| Policy limit | Default | Maximum |
| --- | --- | --- |
| `maxRoles` | 128 | 256 |
| `maxRules` (global) | 1,024 | 2,048 |
| `maxBindings` | 2,048 | 8,192 |
| `maxRoleDepth` | 16 | 32 |
| `maxPolicyBytes` | 1 MiB | 4 MiB |

Set these in `policy.limits`. Each rule accepts at most 32 actions, each role at most 32 inherited roles, and each
binding at most 32 memberships. JSON policy depth/nodes are bounded too. Unknown subjects create no cache entries.
RBAC performs no network calls and spends no model budget.

## Core policy contract

`AuthorizationPolicy` is a versioned port shared by local RBAC and future external adapters. `createAuthorizer` wraps
it with input validation, immutable snapshots, scope checks, explicit `authz:evaluate` admission, cancellation,
deadlines and concurrency limits. `authorizationRequest` validates and snapshots request data for adapters.

```ts
import { createAuthorizer, type AuthorizationPolicy } from 'mayura';

const policy: AuthorizationPolicy = {
  version: 'deny-all-v1',
  authorize: (_request, _context) => Object.freeze({
    effect: 'deny', reason: 'no_match', policyVersion: 'deny-all-v1', ruleId: null,
  }),
};
const authorizer = createAuthorizer({ policy, permissions: { allow: ['authz:evaluate'] },
  limits: { timeoutMs: 1000, maxConcurrent: 32 } });
try {
  const scope = { principalId: 'alice', projectId: 'shop' };
  const cancelled = new AbortController();
  const decision = await authorizer.authorize(scope, 'read', { kind: 'thread', id: 'chat', scope }, { signal: cancelled.signal });
} finally { authorizer.close(); }
```

Policies receive a frozen `AuthorizationRequest` and `{ signal }`. Only an exact, validated allow decision with the
captured policy version can authorize. Boolean answers, malformed decisions, accessors, unknown fields, stale versions,
throws and rejected promises deny. Adapter exception text never appears in the result or `require` error.

Decisions are frozen `{ effect, reason, policyVersion, ruleId }` receipts. Allows have `reason: 'allowed'`; denials use
`no_match`, `explicit_deny`, `scope_mismatch`, `permission_denied`, `invalid_request`, `unavailable`, `cancelled` or
`limit_exceeded`. `ruleId` is null for decisions without a decisive policy rule. An explicitly configured audit sink receives these receipts with validated request metadata, as described below.

The default deadline is one second (1–30,000 ms), with 32 admitted callbacks (1–1,024). Caller abort and `close()`
propagate to policy work. Timeouts, cancellation and late replies cannot release an allow. Callbacks that ignore
cancellation retain their capacity slot until they actually settle, bounding outstanding work even under timeout
floods. Trusted synchronous callbacks cannot be preempted, and replies after the wall-clock deadline are denied.

`authorize` returns a denial on malformed requests and policy failure. `require` throws only the fixed
`PERMISSION_DENIED` refusal for denied operations. Neither retries automatically. Authorization is a point-in-time
check; the host owns resource consistency, rechecks for changed state, and the protected operation's transaction.
A successful access decision does not bypass tool approvals, capability checks, cost ceilings or run permissions.

## Agent runs and tool execution

Pass a host-owned core `Authorizer` as `createRuntime({ authorization })` to enforce execution policy for every root,
child, speculative branch and handoff. The scoped server forwards its owned authorizer into its runtimes and dedicated compaction summarizer automatically.
Static grants, effect permissions, budgets, guards, approvals and checkpoint ownership remain independent gates.
Authorization never grants a missing capability or approves a tool call.

```ts
import { createRuntime, type AgentDefinition, type AuthorizationAuditSink } from 'mayura';
import { createRbacAuthorizer } from 'mayura/authz';

declare const agent: AgentDefinition;
declare const auditSink: AuthorizationAuditSink;
const scope = { principalId: 'alice', projectId: 'shop' };
const authorization = createRbacAuthorizer({
  policy: {
    version: 'execution-v1',
    roles: [{ id: 'operator', rules: [
      { id: 'execute-agents', effect: 'allow', actions: ['execute'], resource: { kind: 'agent', id: '*' } },
      { id: 'execute-runs', effect: 'allow', actions: ['execute', 'approve', 'cancel'], resource: { kind: 'run', id: '*' } },
      { id: 'execute-save', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'save' } },
    ] }],
    bindings: [{ subject: scope, roles: ['operator'] }],
  },
  permissions: { allow: ['authz:evaluate', 'authz:audit'] },
  audit: { sink: auditSink },
});
const runtime = createRuntime({
  profile: 'ephemeral', scope, authorization,
  permissions: { allow: [`model:${agent.model.id}`, 'tool:save', 'effect:write'] },
  limits: { maxCostMicros: 10000 },
});
try {
  const run = runtime.submit(agent, { input: { message: 'Hello' } });
  const outcome = await run.result();
} finally {
  await runtime.close();
  await authorization.flushAudit();
  authorization.close();
}
```

Direct `threads.compact` calls can pass `authorization` for their dedicated summarizer runtime too; a server uses its owned instance rather than a request-supplied override.

The runtime does not own or close the authorizer. Its scope is the verified subject for all checks; approval
`actorId`, model messages, tool arguments, saved inputs and handoff payloads never supply the policy subject or roles.
Agent/tool resources have no inferred owner; run resources use the scoped principal as `ownerId`.

| Boundary | Resource and exact action |
| --- | --- |
| New or resumed execution | Current agent ID → `agent/execute`; concrete run ID → `run/execute` |
| Child or speculative branch | Above checks, plus target agent ID → `agent/delegate`; existing delegation grants still apply |
| Handoff | Target agent ID → `agent/handoff` and `agent/execute`; source run remains subject to `run/execute` |
| Resumed handoff path | Current agent `execute`, run `execute`, and saved target IDs `handoff` |
| Tool proposal and actual invocation | Tool ID → `tool/execute`; static tool/effect/capability grants are checked independently |
| Human approval | Run ID → `run/approve`, current agent/run `execute`; an approved answer also checks pending tool `execute` |
| Expired saved approval | Run `approve`, current agent/run `execute`; no expired call is executed |
| Explicit `cancelSaved` | Run ID → `run/cancel` |

`submit` and `spawn` still return handles synchronously. Policy admission runs asynchronously before recorder startup,
input guards, execution hooks or paid model work. A denial becomes a blocked outcome with `PERMISSION_DENIED` and no
model call. It does not synchronously throw a policy denial from `submit`. Source/target execution is rechecked before
model dispatch, after scheduler admission, before managed guard-model calls, before streamed output batches and
before final result disclosure. Child delegation and saved handoff-path policy remain checked as execution proceeds.
A denied target cannot receive a model request merely because its declared static permissions allow it.

Tool proposals are checked before approval requests or tool proposal hooks. The shared tool broker checks again
before input/schema/guard work, after scheduler waits, after the mandatory dispatch seam, and before releasing output.
A person approving a call does not override current policy. Live approvals are checked before their pending answer is
consumed; saved approvals are checked before an exclusive checkpoint claim. The resumed runtime and broker recheck
again before execution. Rejected/expired approvals never turn into tool writes. A checkpoint claim or write already
committed is not undone if a later recheck denies access; use its existing recovery/reconciliation controls.

Standalone tools and batches accept the same host-owned authorizer:

```ts
import { invokeTool, type AnyTool, type InvokeToolContext } from 'mayura/tools';
import type { Authorizer, JsonValue } from 'mayura';

declare const tool: AnyTool;
declare const input: JsonValue;
declare const context: Omit<InvokeToolContext, 'authorization'>;
declare const authorization: Authorizer;
const outcome = await invokeTool(tool, input, { ...context, authorization });
```

`invokeBatch` inherits this option, preflights policy for the whole graph before schema callbacks or writes, and forwards it to each broker call. A preflight denial rejects the batch with `PERMISSION_DENIED`, as missing static grants already do; execution failures retain the configured batch failure policy. Executors receive the ordinary execution
context without the authorizer, policy configuration, role bindings or audit sink. An application making its own
nested invocations must pass its trusted authorization configuration explicitly; arbitrary callbacks are not a sandbox.

A pre-dispatch refusal returns `execution: 'not_started'` without executor cost. If execution succeeded but access
changes before disclosure, the output is withheld while its receipt remains `execution: 'succeeded'` and
`disclosure: 'withheld'`; cost and persistence evidence remain settled. Previously released output cannot be
retracted, and cancellation does not prove an external write did not occur. No policy failure, timeout or denial
retries a handler, repeats a model call, or replays an approved write automatically.

Keep runtime handles and synchronous `inspect`/`transcript` methods inside trusted host code. These are not an
authenticated read transport; the server still applies `run/read` to HTTP snapshots and streams. A genuine handle's
`cancel()` remains a host-owned stop capability and can stop active work without a policy round trip. A blocked
execution result does not remove receipts or grant access to previously withheld content.

Every check that reaches the core authorizer emits its existing audit receipt when audit delivery is configured,
including dispatch and disclosure rechecks. There is no one-event-per-run/call promise. Events contain bounded
subject/action/resource/decision metadata, never prompts, private instructions, tool arguments/results, media or
approval reasons. The same sink can feed the OpenTelemetry adapter. Static admission refusals before a core check
remain outside core audit events. See [authorization audit events](#authorization-audit-events).

## Memory and document enforcement

Memory stores, remote memory bridges and context assembly accept an optional host-owned `authorization: Authorizer`.
Static capabilities and existing scope/sensitivity checks still gate operations. Policy checks guard direct reads,
mutations, embedding/publication and per-record query results; sealed memory cursors hide denied row IDs. Document
context checks `rag_document/read` on source identity, omits denied evidence without citations or diagnostic IDs,
and bypasses cached assemblies to reevaluate membership. Policies and audit sinks remain owned by the host.
See [fine-grained memory and document access](memory-and-context.md#fine-grained-memory-and-document-access) for
exact action names, graph/import/export rules, pagination and shared RBAC/audit examples.

## External HTTP policies

`@mayurajs/authz-http` implements a bounded external policy-decision protocol behind the same core contract.
`createHttpAuthorizationPolicy` plugs into `createAuthorizer` or scoped server enforcement;
`createHttpAuthorizer` owns the complete core, audit and transport lifecycle. Explicit `authz:http` admits transport,
while `authz:evaluate` and `authz:audit` retain their existing meanings. Responses must match a per-check request ID
and pinned policy version, with no retries, fallback allow or implicit decision cache. Local scope refusals happen
before transport, and only core emits the final audit receipt. See [HTTP authorization policies](../integrations/authz-http.md)
for the exact protocol, install command, server wiring and bounds.

## Provider-specific policy adapters

[OpenFGA](../integrations/authz-openfga.md) is implemented as the optional `@mayurajs/authz-openfga` extension.
`createOpenFgaAuthorizationPolicy` and `createOpenFgaAuthorizer` use the same core enforcement/audit contract with
pinned native store/model IDs, explicit action/relation mappings and full-scope tuple identities. Transport requires
`authz:openfga`; core evaluation and audit retain their separate grants. Provider errors fail closed, without retries
or a local allow cache. Offline tests passed locally; provider interoperability remains unqualified.

[Cedar](../integrations/authz-cedar.md) is implemented as the optional `@mayurajs/authz-cedar` extension.
`createCedarAuthorizationPolicy` and `createCedarAuthorizer` use host-supplied native evaluation with pinned static
policies/schema, trusted attributes, scoped identities, explicit `authz:cedar` admission and bounded cancellation-safe
callbacks. Evaluation diagnostics fail closed even alongside a native allow. Core audit/OTel remain shared.
Offline tests passed locally; native engine interoperability remains unqualified; Amazon Verified Permissions is separate future work.

[Permit.io](../integrations/authz-permit.md) is implemented as the optional `@mayurajs/authz-permit` extension.
`createPermitAuthorizationPolicy` and `createPermitAuthorizer` perform native PDP checks with explicit environment
credentials, exact action mappings, scoped user/resource keys, project tenants and bounded cancellation-safe Fetch.
Provider I/O requires `authz:permit`; core evaluation and audit keep their separate grants. Configured environment
and policy revisions are host assertions because the native API does not attest them. Offline tests passed locally; live interoperability remains unqualified.

[Oso](../integrations/authz-oso.md) is implemented as the optional `@mayurajs/authz-oso` extension.
`createOsoAuthorizationPolicy` and `createOsoAuthorizer` perform native Oso Cloud checks with scoped typed IDs,
exact actions, explicit `authz:oso` admission, bounded cancellation-safe Fetch and shared core audit/OTel. The host
owns Polar/fact provisioning and deployment revisions; no inline facts or native version receipt are assumed.
Offline tests passed locally for all four adapters; real provider/native engine interoperability remains unqualified. See [release validation status](release-readiness.md). Embedded Oso library and
local SQL evaluation are outside this adapter; Amazon Verified Permissions service integration remains future work.

## Authorization audit events

Configure `audit` on `createAuthorizer`, `createRbacAuthorizer`, or the server's `authorization` option. This requires
an additional `authz:audit` grant; configuring a sink without it is an `INVALID_CONFIG` error before any delivery.
No sink is enabled by default, and importing or constructing an authorizer sends no data.

```ts
import { createAuthorizer, type AuthorizationAuditSink, type AuthorizationPolicy } from 'mayura';

declare const policy: AuthorizationPolicy;
declare const sink: AuthorizationAuditSink;
const authorizer = createAuthorizer({
  policy,
  permissions: { allow: ['authz:evaluate', 'authz:audit'] },
  audit: { sink, maxConcurrent: 4, timeoutMs: 1000 },
});
try {
  const scope = { principalId: 'alice', projectId: 'shop' };
  await authorizer.authorize(scope, 'read', { kind: 'thread', id: 'chat', scope });
  await authorizer.flushAudit();
  const counters = authorizer.auditSnapshot();
} finally { authorizer.close(); }
```

Each completed check produces one immutable `AuthorizationAuditEvent`: `type: 'authorization.decision'`, a unique
`id`, ISO `timestamp` at completion, integer `durationMs`, validated `request`, and the final `decision`. Local
refusals (missing evaluation grants, invalid requests, scope mismatches, capacity, cancellation) and policy failures
produce events too. Invalid requests have `request: null`; rejected fields, provider diagnostics, credentials,
HTTP bodies, model inputs and tool arguments never enter events. Valid requests include principal, project,
resource and optional owner identifiers: treat the sink as a trusted security destination. The exported
`snapshotAuthorizationAuditEvent` rejects accessors and fields outside this exact catalog for consumers accepting
untrusted event records.

Delivery is independent of the decision and uses its own cancellation signal. Synchronous sink throws, rejected
promises, cancellation and export timeouts do not change an allow or denial, and never retry a protected operation.
The default limit is four outstanding deliveries (1–64), with a one-second deadline (1–30,000 ms). There is no queue:
overflow drops a delivery. A timed-out sink keeps its capacity slot until it actually settles, so a sink that ignores
cancellation cannot create unbounded work. Trusted synchronous callbacks cannot be preempted; keep sinks short and
asynchronous. Delivery order is not guaranteed.

`auditSnapshot()` exposes bounded counters (`produced`, `delivered`, `failed`, `timedOut`, `cancelled`, `dropped`,
`inFlight`) without retaining event history. `delivered` means only that the sink resolved within its deadline.
`flushAudit()` waits for already admitted deliveries to complete or reach their deadlines, and does not await
non-cooperative work afterward. Stop new producers, flush, then close the authorizer and your exporter. `close()`
aborts outstanding deliveries; checks completing after closure count as dropped deliveries. Auditing is best effort,
not durable storage, guaranteed delivery, or proof that the protected operation committed. Use event IDs for sink
idempotency and monitor delivery gaps if the host requires durable audit retention.

Server enforcement forwards `authorization.audit` to its owned authorizer. `inspectAuthorizationAudit()` and
`flushAuthorizationAudit()` are host-only methods on the fetch server and both Node hosts; neither is exposed as an
HTTP route. A disabled authorizer reports null counters. Admission, dispatch, response, row filtering and stream
rechecks each produce their own decision events, including denied rows. There is no one-event-per-HTTP-request
promise. Authentication failures and legacy capability refusals that occur before core policy evaluation do not
produce core authorization events. Host recovery and reconciliation retain their own authorization boundaries.

## OpenTelemetry authorization

Use the application's existing OpenTelemetry SDK through `mayura/exporter-otlp/opentelemetry`. This adapter installs
no exporter, sampler, transport or credentials, and needs no provider-specific authorization integration.

```ts
import { createAuthorizer, type AuthorizationPolicy } from 'mayura';
import { createOpenTelemetryAuthorization } from 'mayura/exporter-otlp/opentelemetry';
import type { Meter, Tracer } from '@opentelemetry/api';

declare const policy: AuthorizationPolicy;
declare const tracer: Tracer;
declare const meter: Meter;
const telemetry = createOpenTelemetryAuthorization({ tracer, meter });
const authorizer = createAuthorizer({
  policy,
  permissions: { allow: ['authz:evaluate', 'authz:audit'] },
  audit: { sink: telemetry.sink },
});
try {
  const scope = { principalId: 'alice', projectId: 'shop' };
  await authorizer.authorize(scope, 'read', { kind: 'thread', id: 'chat', scope });
  await authorizer.flushAudit();
} finally { authorizer.close(); telemetry.close(); }
// Flush/shut down the application's SDK separately after stopping all telemetry producers.
```

Provide a tracer, a meter, or both. Each event creates an internal `authorization.decision` span using the recorded
evaluation times and the application's active context (or the explicit `context` callback). Attributes include
`mayura.authorization.effect`, `.reason`, `.resource.kind` and, for valid requests, `.action`. Policy denials have
unset status; allows have OK status; `unavailable` marks ERROR, without exception text.

Identifiers are omitted by default. `includeIdentifiers: true` adds event, policy version, decisive rule, principal,
project, resource and optional owner identifiers to spans only, including resource scope for cross-scope denials.
Enable this only for an authorized destination. Sampling and SDK resource attributes remain application-owned.

Metrics are `mayura.authorization.decisions` (counter, `{decision}`) and `mayura.authorization.duration` (histogram,
seconds). Their only labels are effect, reason and resource kind, all closed enumerations (`invalid_request` replaces
kind for malformed requests). They never label by action, identity, event, policy, rule or resource ID. These are
observed deliveries, so dropped audit events or SDK sampling/export loss prevent treating telemetry as a complete
security ledger. SDK failures become fixed local delivery errors and feed the authorizer's audit failure counters.

## Threads, approvals and compaction

`createThreads` accepts a shared host-owned core `authorization` instance and an optional service/request `signal`.
Pass the same authorizer to a standalone agent runtime as well as its thread service; a recorder cannot reconfigure
a runtime's independent execution policy. The scoped server forwards its authorizer to both services automatically,
including its compaction service and claimed-approval reconciliation controls. Static grants remain required.

| Resource kind | Resource ID | Actions | Boundary |
| --- | --- | --- | --- |
| `thread` | `collection` | `list` | Scoped list admission and response |
| `thread` | Exact thread ID | `create`, `read`, `update`, `archive`, `restore`, `delete` | Service operations; writes and disclosure recheck current policy |
| `thread` | Exact thread ID | `append` | Turn admission, durable start-marker admission and bound runtime execution |
| `thread` | Recorded thread ID | `approve` | Live approval acceptance and saved approval/expiration before any claim |
| `thread` | Exact thread ID | `recover` | Explicit recovery of an existing terminal recording outbox |
| `thread` | Exact thread ID | `compact`, `read` | Source access, reservation, starting the summarizer and publishing/reusing a summary |
| `thread` | Exact thread ID | `inspect_compaction`, `cancel_compaction` | Compaction service inspection and cancellation; both also require `read` |
| `run`, `thread` | Claimed run ID and its recorded thread ID, when bound | `inspect_approval`, `reconcile_approval` | Claimed-approval inspection or terminal reconciliation |

The verified runtime/service scope supplies the subject and thread/run owner. `actorId` is attribution only; it never
substitutes for that subject. Run `approve`, execution, tool permissions, human-verification rules, approval digests,
leases and existing reconciliation service grants/callbacks remain independent gates. A denied saved approval is
left waiting without claiming or replaying a tool write. Reconciliation only fences and closes the existing attempt;
it cannot approve, resume or execute a tool. Live approval acceptance rechecks that the pending request still exists
and has not expired after asynchronous policy evaluation.

Direct scoped thread lists scan one bounded storage page, filter read-denied rows and preserve the scanned
continuation even if that page has no visible rows. The continuation is encrypted, expires after five minutes and
is bound to scope and list status. It is portable between thread services sharing the same authorizer instance,
not between process restarts or distinct authorizers. Membership decisions are never cached. Policy failure,
capacity refusal or cancellation fails the operation rather than returning a misleading empty result. HTTP lists
retain their existing server cursor codec, identity/agent binding and per-row policy checks instead of nesting the
service cursor inside it.

An admitted durable thread start marker remains the run/thread association. Terminal recorder settlement is a
trusted capability of that existing turn and requires its exact persisted marker. It can finish its immutable
outbox, receipts and terminal status after append/read permission is revoked; it cannot open another turn or rerun
an effect. Explicit `recoverRun` is separately authorized. `runInThread().done` rechecks read permission before
returning recorded entries. Runtime handles, raw stores and administrative `purgeIdleThreads` remain trusted host
capabilities; do not expose them directly to unverified callers.

Compaction inherits the thread service's authorizer; an explicitly supplied per-command instance must match it.
For legacy unguarded services, a per-command authorizer also enforces thread compaction checks. The dedicated
summarizer still requires its own agent/run execution and model capabilities. A successful paid summary is staged
privately with its cost before publication authorization is rechecked. If publication is denied, the ready journal
remains available: a later authorized retry of the same command publishes it without another model call. Pending
or failed commands never become replay authority. Cancellation and read checks cannot undo an already committed
summary. An in-flight model callback cannot be continuously revoked or have its spent cost undone.

The shared core authorizer emits its existing metadata-only audit events and can use the existing OpenTelemetry
sink. No thread text, title, model input/output, approval input or reconciliation evidence is added to audit events.
Services do not create another audit queue or close the host-owned authorizer. Claimed-approval reconciliation may
also receive an `authorization` instance in its host options when no server-wide policy is configured; omit that
nested option when the server creates its own authorizer.

## Workflow execution and child workflows

Pass the host-owned core `authorization` instance to `createWorkflowRuntime`, `createScheduledWorkflowRuntime`,
`createWorkflowGraphRuntime`, `createWorkflowTreeRuntime` or `createWorkflowLifecycleRuntime`. Loop and saga runtimes,
composite fleets and lifecycle fleets inherit this option; graph and tree coordinators forward it to their workers.
Omitting it preserves the existing explicit static permissions, approvals, leases and budget checks. When configured,
each matching policy rule must allow the additional actions below. An RBAC action is matched together with its
resource kind; `execute` on a tool does not authorize a workflow or run.

| Resource kind | Resource ID | Action | Boundary |
| --- | --- | --- | --- |
| `workflow` | Genuine definition's `digest` | `execute` | Submission, continuation, step scheduling, dispatch and output publication |
| `run` | Deterministic scoped workflow run ID | `execute` | The concrete root or child execution |
| `workflow` | Target child's definition `digest` | `delegate` | Child admission and continuation, loop iterations, forward saga steps and compensation |
| `tool` | Registered tool ID | `execute` | Preparation, approval proposal, broker admission, dispatch and disclosure |
| `run` | Target run ID | `approve` | Before human verification and immediately before approval is recorded |
| `run` | Target run ID | `resume` | Explicit operator resume; driving the resumed run separately requires `execute` |

Tree approvals require `approve` on the root and, for child approvals, on that child. Identity comes from the host's
runtime scope; human approval credentials, actor IDs and workflow input never change the authorization subject.
Run resources carry the verified scope's principal as owner; workflow and tool resources do not infer an owner.
The child retains its own static permission set and persisted budget allocation. A parent grant never expands it.

Admission checks precede input-schema callbacks and durable creation. Execution checks repeat on every driver wave,
after asynchronous preparation, before claimed effects start and before output publication. Child broker checks also
recheck the parent and delegation authority. Loop and saga drivers install a temporary parent gate while submitting
or driving lifecycle children, and discard it afterwards. Restarted drivers rebuild that gate from their verified
parent definition and existing child links. Core policy decisions and authority objects are never checkpointed.

A denial before scheduling rejects with the fixed `PERMISSION_DENIED` code and leaves the pending step available for
an explicit later continuation. A broker denial settles the admitted attempt as blocked. Revocation after a handler
has written preserves its execution receipt and known charge while withholding output. Policy refusal never grants
a retry of a dispatched or uncertain write. Existing recovery and receipt settlement remain available independently
of execution permission, so operators can preserve evidence even after execution authority is revoked. In-flight
trusted callbacks cannot be interrupted continuously or have their effects undone by policy checks.

The injected authorizer owns all evaluation limits, metadata-only audit events and any OpenTelemetry sink. Workflow
engines do not add a separate audit queue, persist decisions, log inputs or close that shared instance. Closing an
engine cancels its own outstanding policy waits and tools. A policy timeout, cancellation or provider error fails
closed. Several checks per operation intentionally produce several audit events.

Workflow HTTP transports remain separate trusted host adapters: configuring server authorization alone cannot
configure a separately constructed workflow worker. Pass the appropriate authorizer to that worker too. Direct
inspection, event history, reconciliation, cancellation, migration and recovery remain trusted host controls; expose
them through the scoped server's independently authorized routes. Durable agent phases and `agentStep` accept their
own `authorization` option for their inner agent execution. Ephemeral workflow compositions use the owning agent
runtime's agent/run/tool policy boundary.

## Offline example

After building a checkout, run `node examples/authorization.mjs` to inspect local RBAC decisions for an inherited role,
an explicit deny and a denied cross-project request. It uses no credentials, server, network or model.

## Frontend-result recovery

Checkpointed [AG-UI frontend tools](ag-ui.md#safe-native-owner-recovery) require a separate `run/resume_tool` action
for native-owner recovery. The scoped HTTP route also requires the `runs:resume` token capability and run/thread
read plus thread write capabilities. Existing agent/run/tool execution and thread read/append policies are rechecked;
saved runtime permissions can only narrow. Frontend dispatch/result policy still controls publication and stored
result consumption. Human approval permissions cannot resume this boundary. The trusted recovery scanner requires
an explicit per-item `kind: 'frontend'` decision in addition to its service grant. These checks use the existing
core audit and OpenTelemetry path; input/result payloads do not enter authorization events.

## Related

- [Authentication](authentication.md)
- [Permissions](../concepts/permissions.md)
- [Server and client](server-and-client.md)
- [Agent handoffs](agent-handoffs.md)
