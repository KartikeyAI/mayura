---
title: "AG-UI adapter"
description: "Expose scoped run events, stored messages, state snapshots/deltas, durable frontend-tool claims/outboxes and approval interrupts through an AG-UI 1.0 Fetch adapter."
---

`mayura/ag-ui` is an **experimental AG-UI 1.0 subset** over the existing [server and client](server-and-client.md).
It serves one agent on one same-origin Fetch route. The native server remains responsible for authentication,
scopes, resource authorization, spending limits, durable run records and approval claims. SDK interoperability and
protocol conformance remain unqualified. Local adapter tests and server integration checks passed; see [release validation status](release-readiness.md).

## Configure and mount

Configure the native server with `threads` and durable `runRecords`, using its default background run execution.
The `runApprovals` session feature is advertised for identities with `runs:approve`. For approval recovery across restarts, configure the thread checkpoint store and register
the agent versions as described in [approvals](approvals-and-human-input.md). The adapter does not own or close the
server. All callers need `runs:read`, `threads:read` and access to the configured agent. Fresh submissions additionally
need `runs:submit` and `threads:write`; only human-approval resumes need `runs:approve`. Native resource policies
can narrow these grants. The verified session must advertise `threads` and `runRecords`, plus `runApprovals` for
human-approval resumes. Frontend claims/results do not require or grant human-approval permission.

```ts
import { createAgUiAdapter } from 'mayura/ag-ui';
import type { AgentServer } from 'mayura/server';

export function chatEndpoint(server: AgentServer, interruptKey: Uint8Array) {
  const adapter = createAgUiAdapter({
    server,
    publicOrigin: 'https://agents.example.com',
    path: '/ag-ui',
    agentId: 'support',
    permissions: { allow: ['ag-ui:serve'] },
    interruptKey,
    // Match the registered agent's input schema; keep this mapping deterministic.
    input: message => ({ message: message.content }),
    limits: { maxConcurrentStreams: 32, durationMs: 300_000 },
  });
  return {
    fetch(request: Request) {
      return ['/ag-ui', '/ag-ui/frontend-tools/claim'].includes(new URL(request.url).pathname)
        ? adapter.fetch(request)
        : server.fetch(request);
    },
    close() { adapter.close(); },
  };
}
```

Load exactly 32 cryptographically random key bytes from host secret storage. Keep the same key, origin and agent ID
on all replicas and across restarts. Rotating the key invalidates outstanding interrupt IDs. Keys and credentials
never belong in browser configuration or thread messages. HTTPS is required outside loopback development.
Use a Bearer header on every request. Cookies and client-supplied identities are not forwarded. Browser requests must
come from the configured origin; cross-origin browser mounting and CORS preflight are outside this profile.

The host permission `ag-ui:serve` enables the adapter. It grants no model, tool, effect or resource access. Configure
those on the native server and runtime, including [fine-grained authorization](authorization.md). Their existing
policy decisions and audit events also cover requests made through this route. Use background execution for this event-streaming profile. `runExecution: 'request'` waits for settlement or a
durable checkpoint before replying, so live event delivery is outside this adapter's supported configuration.

## Start a turn

POST JSON to the configured route:

```json
{
  "protocolVersion": "1.0",
  "threadId": "support-chat-7",
  "runId": "ui-turn-1",
  "messages": [{ "id": "user-1", "role": "user", "content": "Refund order 7" }],
  "tools": [],
  "context": [],
  "state": {}
}
```

A missing thread is created in the authenticated scope and pinned to the configured agent. Existing threads must be
active and belong to that agent. Only the newest user text is mapped to native input. Earlier user, assistant and
tool messages are bounded UI echoes: the server loads model history from its stored thread. Unregistered browser tools, arbitrary nonempty
context/forwarded properties, branching (`parentRunId`), multimodal messages and system/developer messages are
refused before native run submission. Without a configured state source, nonempty state is also refused. With a source,
bounded browser state is accepted as an echo and ignored. A resume request does not submit another user message.

The combination of authenticated native scope, agent, thread and external `runId` determines a stable native
idempotency key. Retry the exact fresh request after a lost submission reply; do not assign a new external run ID to
retry the same action. The native server rejects a changed input under the same key. This protection lasts for the
native run-record/idempotency retention period; it is not permanent deduplication after those records are removed.
The host input mapper must stay deterministic for in-flight idempotency keys across deployments.

## Events and stored messages

The response is `text/event-stream`, with one JSON event in each `data:` frame. No AG-UI SDK is installed or required.
`RUN_STARTED.metadata.mayura.runId` and the `X-Mayura-Run-Id` response header correlate the UI request with the native
run for inspection and recovery. Each UI request has its own external run ID; approval resumes keep the native run.

| Event | Source and meaning |
| --- | --- |
| `RUN_STARTED` | External thread/run identity and native run correlation. |
| `STEP_STARTED`, `STEP_FINISHED` | Native step boundaries observed in this stream segment. An interrupted step can remain unfinished; unmatched resumed completions are omitted. |
| `STATE_SNAPSHOT` | Full authoritative host state, with its revision in metadata. Every state-enabled stream starts with a snapshot. |
| `STATE_DELTA` | Bounded RFC 6902 changes from the last state emitted on this stream, with previous/current revisions in metadata. |
| `MESSAGES_SNAPSHOT` | Full bounded projection of stored user, assistant, tool-call and released tool-result entries. At an interrupt, the pending proposal is included. |
| `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` | Final released assistant text, when that message was not already in the opening snapshot. Structured output is JSON text. Empty start/end boundaries also introduce pending tool-call messages. |
| `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` | A pending approval proposal or registered frontend call; a frontend call carries a scoped claim token in metadata. |
| `TOOL_CALL_RESULT` | The resumed proposal's released result, after terminal recording. References its original tool-call ID. |
| `RUN_FINISHED` | Success, cancellation, approval interrupt, or success with `pendingToolCallIds` for frontend execution. A pending call is not native run completion. |
| `RUN_ERROR` | Sanitized failure, blocked/unknown outcome, authorization loss, event gap or exhausted observation limit. |

Message IDs derive from stored sequence numbers; tool-call IDs include the durable turn identity, so native call IDs
can repeat in later turns. Native inputs and outputs that are objects are displayed as JSON strings. Approval and
internal run markers are not chat messages. Compaction summaries are omitted because source entries remain stored.
Turns are recorded at settlement: intermediate successful tool results are not fabricated while a run is waiting.
Only stored history and the currently inspected pending proposal are published at an interrupt.

In the default buffered profile, native provisional `output.delta` events are omitted: final text is published only
after guards release it and terminal thread recording succeeds. Opt-in guarded text streaming and opaque image/PDF
references are described in [guarded text, media and the runnable notebook](#guarded-text-media-and-the-runnable-notebook).
Tool events without a pending approval are represented in the final thread snapshot; metadata-only native tool
events cannot supply authoritative arguments or results. Activities, conversation branching, audio/video media and
broader client compatibility remain outside the qualified profile.

## State snapshots and deltas

State is opt-in. Configure a host-owned `AgUiStateSource` and explicitly grant `ag-ui:state` alongside `ag-ui:serve`.
The source reads an authoritative state value and a nonnegative safe-integer revision for one **verified scope and
thread**. Increment the revision whenever its visible state changes. Store these revisions with your application
state if they must survive restarts; the adapter does not create a state database or a write API.

```ts
import { createAgUiAdapter, type AgUiStateContext, type AgUiStateVersion } from 'mayura/ag-ui';
import type { Authorizer } from 'mayura/core';
import type { AgentServer } from 'mayura/server';

export function statefulChat(
  server: AgentServer,
  interruptKey: Uint8Array,
  authorization: Authorizer,
  readState: (context: AgUiStateContext) => Promise<AgUiStateVersion>,
) {
  return createAgUiAdapter({
    server,
    publicOrigin: 'https://agents.example.com',
    agentId: 'support',
    permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] },
    interruptKey,
    input: message => ({ message: message.content }),
    state: { read: readState, authorization },
    limits: {
      maxStateBytes: 262_144,
      maxStatePatchBytes: 65_536,
      maxStatePatchOperations: 128,
      maxStateReads: 1000,
      maxConcurrentStateReads: 32,
      stateReadTimeoutMs: 5000,
    },
  });
}
```

`read` receives only `scope`, `agentId`, `threadId`, external `runId` and `signal`. It receives no browser state,
credentials, model deltas, approval arguments or tool-write capability. Load state using both scope fields and the
thread ID, and return only data that caller may see. Keep it read-only and honor cancellation; this observer does not
reserve model/tool budget or run application writes. Native thread/read authorization always applies. The optional
borrowed core `authorization` adds **`thread` / `read_state`** decisions and existing audit events before and after
reads and immediately before state disclosure. Add an explicit allow rule to your policy for that action; policies
without a matching rule deny it. The adapter does not close this shared authorizer.

The source returns `{ revision, state }`. State may be any bounded plain JSON value, including null, arrays and
scalars. Revisions belong to the scoped thread, not the browser. A version going backwards, or changing its value
without advancing its revision, ends observation with `STATE_REVISION_CONFLICT`. Object key order is immaterial.
Increasing the revision without changing the value produces an empty, valid no-op delta. Source values are copied
and frozen before publication; getters, prototype keys, unsafe numbers and non-JSON values are rejected.

An initial read occurs before native submission or approval. A source failure or denial there prevents that paid
submission/approval attempt, although an absent thread may already have been created. After `RUN_STARTED`, the
adapter publishes a `STATE_SNAPSHOT` from that read. It rereads state at subsequent outgoing native event boundaries
and quiet-run heartbeats, emitting a delta before the associated event when a newer revision is available. This is
bounded observation, not a push subscription: external state changes during silence can take up to the next
15-second heartbeat to appear. An admitted callback may additionally take up to its configured read timeout.

Snapshots have `snapshot: <state>`; deltas have `delta: [...]`. Revision fields live under
`metadata.mayura.stateRevision` and `metadata.mayura.previousStateRevision`, keeping AG-UI's top-level event fields
unchanged. Apply events in delivery order. Generated patches use `add`, `remove` and `replace`, escape `/` and `~` in
JSON Pointer paths, replace arrays atomically, and use the empty path for a root replacement. If a patch exceeds
its operation or byte limit, the adapter sends a complete snapshot instead; it never emits a partial patch.

Every new request, submission replay and approval-resume stream begins with a fresh authoritative snapshot. No
process-wide last-state cache or browser-provided baseline is used. A bounded `RunAgentInput.state` echo may contain
any JSON value when state is enabled, but is never persisted, patched into application state, passed to `input`, or
used to authorize a run or approve a tool. Snapshot resets make reconnects and replica changes independent of a
client's previous patch cursor. Approval tokens continue binding only the native approval; they confer no state
write authority.

Default state bounds are 256 KiB per value, 64 KiB per patch, 128 operations per patch, 1,000 source reads per stream,
32 concurrent source reads across this adapter and five seconds per callback. State and patch limits must leave
512 bytes of room in `maxEventBytes` for event framing/metadata. State events also count toward normal stream
frame/byte/lifetime limits. Only one native event can wait behind a state update under backpressure.

A callback that ignores cancellation keeps occupying a global source slot until it actually settles, even after its
request times out or disconnects. Further reads fail with `STATE_READ_BUSY` when that pool is full. Invalid state,
source failures, read exhaustion and timeouts are sanitized HTTP errors during admission or `RUN_ERROR` after
streaming starts. They end observation, not the native run, and never retry a paid submission or approval. Existing
native run/thread disclosure checks still apply to every emitted frame. Local regression tests passed; reference SDK interoperability remains unqualified.

## Answer an approval

`RUN_FINISHED` with `outcome.type: 'interrupt'` contains one `tool_call` interrupt. Its opaque `id` seals the native
run, thread, turn, exact call/digest, expiry, prior external run and observation cursor to the verified principal,
project, configured agent and origin. Tool arguments are not stored in the token. The pending proposal is separately
shown through authorized run/thread reads.

POST to the same endpoint with the **same thread ID**, a **new external run ID**, and the returned interrupt ID:

```json
{
  "protocolVersion": "1.0",
  "threadId": "support-chat-7",
  "runId": "ui-resume-1",
  "messages": [],
  "resume": [{
    "interruptId": "<id from RUN_FINISHED.outcome.interrupts[0]>",
    "status": "resolved",
    "payload": { "approved": true }
  }]
}
```

Use `approved: false` to reject. `status: 'cancelled'` without a payload also rejects the proposal; it does not cancel
the native run directly. Exactly one pending answer is supported. Tool argument edits, caller actor IDs, changed
threads/owners/agents, expired tokens and stale digests are refused. The native authenticated identity supplies the
approval actor. The resumed native run keeps its continuing budget and original thread/run association.

The route makes one native approval attempt, with no retries. A second claim or changed pending approval returns a
conflict. If the response is lost or uncertain, inspect the correlated native run through `mayura/client`; do not
submit a fresh run or automatically repeat the approval. Already-claimed approval recovery stays with the existing
host reconciliation controls and never replays a tool write. See [approvals](approvals-and-human-input.md).

## Permissioned frontend tools

`createAgUiFrontendTools` bridges **host-registered native tools** to browser handlers. Browser advertisements select
from that registry; they cannot inject executable code, new schemas, descriptions, models, permissions or budgets.
The native agent must include each returned tool. Normal native tool admission, hooks, optional human approval,
effect grants, cost reservations, input guards and output validation still apply.

```ts
import { createAgUiFrontendTools } from 'mayura/ag-ui';
import type { Authorizer } from 'mayura/core';
import { z } from 'zod';

export function registerFrontendTools(authorization: Authorizer) {
  const frontendTools = createAgUiFrontendTools({
    agentId: 'support',
    permissions: { allow: ['ag-ui:frontend-tools'] },
    authorization,
  });
  const choose = frontendTools.defineTool({
    id: 'ui.choose', version: '1', description: 'Choose an item.',
    input: z.object({ item: z.number() }),
    output: z.object({ selected: z.number() }),
    effects: 'none', capabilities: [],
    costMicros: 0, timeoutMs: 30_000,
  });
  return { frontendTools, choose };
}
```

Put `choose` in the `support` agent's `tools` **before** creating the native server. Its runtime needs explicit
`tool:ui.choose` and `frontend:ui.choose` grants, plus its declared `effect:*` grant when applicable. Specify both
`costMicros` (including zero) and `timeoutMs`; native budget accounting conservatively charges the declared tool bound.
Browser waits consume native run/operation time, so configure the agent's duration and tool timeouts accordingly.
A tool's optional normal `approval` still asks a person first; frontend result submission cannot supply approval proof.

Pass `frontendTools` to `createAgUiAdapter` and add `ag-ui:frontend-tools` to the adapter's host permissions.
Without a shared store, it must be the same instance used to define the native agent tools. With a shared store,
each replica can use its own instance with identical registrations. The service is pinned to that adapter's agent. Mount `/ag-ui/frontend-tools/claim` alongside `/ag-ui`;
the earlier mount example includes it. The host owns the service: close it after closing the adapter during shutdown.

The service requires a core authorizer. Configure explicit `tool` rules for `frontend_advertise`,
`frontend_dispatch`, `frontend_execute` and `frontend_result` in the authenticated principal/project scope.
These use existing core authorization auditing and do not replace native run/thread/tool policies. A permission
revoked before dispatch, claim, result acceptance or buffered frame disclosure denies that step. Claims additionally
require fresh native run/read and thread/read access, an active thread pinned to the agent and a running native run.
Tool resources carry `ownerId` from the verified scope; browser actor or project claims are never accepted.

Each new run advertises the permitted frontend subset through `RunAgentInput.tools`. Copy the exact host registration:
`{ name: choose.id, description: choose.description, parameters: choose.inputJsonSchema }`. Unknown names, duplicate
names and changed schemas/descriptions are refused before native submission. Keep the same advertised subset on
submission retries and native approval resumes. Frontend result continuations cannot expand the original binding.
The native model sees only its registered host tool definitions; a browser advertisement grants no new capability.
If the model proposes a tool unavailable in this browser, no browser dispatch is granted and observation fails.

When a native tool reaches its executor, the bridge waits for a browser result. The adapter emits normal tool-call
frames and a `RUN_FINISHED` success outcome with `pendingToolCallIds`. The **native run remains active**, holding its
existing budget and thread association. Frontend `TOOL_CALL_START.metadata.mayura.frontend` contains an opaque scoped
`token`, `expiresAtMs`, and `claimPath`. This is separate from native human-approval interrupts.

Use `createAgUiFrontendExecutor` in the browser to claim the call before invoking a local handler:

```ts
import { createAgUiFrontendExecutor, type AgUiEvent } from 'mayura/ag-ui';

export function browserTools(token: () => Promise<string>) {
  const executor = createAgUiFrontendExecutor({
    publicOrigin: 'https://agents.example.com', token,
    permissions: { allow: ['ag-ui:frontend-execute', 'frontend:ui.choose'] },
    handlers: {
      'ui.choose': async (input, context) => {
        context.signal.throwIfAborted();
        // Replace with your own UI interaction. Use context.executionId as an idempotency key for external writes.
        return { selected: (input as { item: number }).item };
      },
    },
  });
  return async (event: AgUiEvent) => {
    if (event.type !== 'TOOL_CALL_START' || !event.metadata) return undefined;
    return executor.execute({ toolCallId: event.toolCallId, toolCallName: event.toolCallName, metadata: event.metadata });
  };
}
```

The helper makes **one** authenticated claim request, checks the server's authoritative tool name/call ID/input and
runs only a locally registered handler with explicit `frontend:<name>` permission. The server atomically consumes the
claim before replying. A duplicate executor, lost claim reply or uncertain browser timeout never retries that action.
The handler receives a cancellation signal and stable `executionId`; independently authorize any backend API it calls
and use that ID for application-level idempotency where effects can commit before a reply. Browser-side permission
checks are convenience guards; server/core policy is the authority.

After the helper returns, submit a new AG-UI request with the **same thread**, a **new external run ID**, exactly
`messages: [returned.message]` and `forwardedProps: returned.forwardedProps`. Include the same tools if your client
normally advertises them. The adapter resolves the scoped claim to the **existing native run**, checks the exact
wire tool-call ID and claim ID, then accepts the JSON result once. It does not submit a new paid native run.
Before the call token expires, retry an uncertain result submission with the **exact same message and external run ID**; a matching accepted result
is idempotent, while a changed result or different continuation run ID conflicts. Never rerun the browser handler.

Successful browser content must be a JSON string. It is bounded and treated as **untrusted client data**: the native
tool's output schema and guards still decide whether it reaches the model or stored thread. Frontend return values
are not attestations that an external write succeeded and cannot grant permissions or approve backend tools.
A client tool message with `error` rejects the wait with a fixed native tool error; raw browser error text and stack
traces are not passed to the model. The helper normalizes ordinary handler failures and oversized/non-JSON returns.
An aborted/timed-out handler leaves an uncertain claim rather than inventing a successful result. Only released,
terminally recorded results become `TOOL_CALL_RESULT` and thread messages.

### Durable claims and result outboxes

Supply `store` to remove HTTP session affinity. All replicas must share an initialized `AggregateStore`, the same
agent/tool definitions, native run records and thread store, and the adapter's interrupt key. The journal uses
existing aggregate create-if-absent and compare-and-set operations; it needs no backend-specific migration.

```ts
import { createAgUiFrontendTools } from 'mayura/ag-ui';
import { createAggregateFrontendToolStore, type AggregateStore } from 'mayura/storage-contracts';
import type { Authorizer } from 'mayura/core';

export function durableFrontendTools(database: AggregateStore, authorization: Authorizer) {
  const journal = createAggregateFrontendToolStore(database, {
    permissions: { allow: ['frontend-tools:store'] },
    limits: { maxCallsPerRun: 64, maxRecordBytes: 262_144, maxAttempts: 8 },
  });
  const frontendTools = createAgUiFrontendTools({
    agentId: 'support', authorization, store: journal,
    permissions: { allow: ['ag-ui:frontend-tools'] },
    limits: { storageTimeoutMs: 5_000, maxStorageOperations: 32, pollIntervalMs: 100 },
  });
  // Define the same native tools on every replica before serving requests.
  return { frontendTools, journal };
}
```

The journal pins one token to each scoped native run/call before exposing the call. Registrations include a digest
of the tool version, input/output schemas, description, effects, capabilities, cost and timeout. Replicas with a
different definition fail closed. Bump the tool version when changing executable guards or other behavior that a
schema cannot describe; retain matching definitions while their calls remain active.

A claim is committed before the browser receives execution permission. Its state never returns to pending: process
loss, timeouts, lost replies and cancellation cannot release it for another browser execution. A lost claim reply
therefore requires reconciliation. Never retry the handler merely because a claim/result request failed.

Any HTTP replica can accept the bounded result. Settlement and its immutable outbox commit atomically before
acknowledgment. Resubmit the **same** result message, claim proof and continuation run ID after an uncertain result
reply; exact retries are idempotent. Changed content or continuation identity conflicts. Claimed results may be
retained after the execution deadline until `retainUntilMs`, but this preserves evidence without restarting an
expired native execution. New claims are refused after the execution deadline.

Without native recovery, the original native execution polls the shared journal, rechecks `frontend_result` authorization and permanently
reserves the outbox to its unique consumer before applying normal output validation/guards. Other consumers cannot
take over this reservation. This preserves the existing native budget and thread association without paid replay.
A reservation means delivery was reserved; it is **not** proof of schema acceptance or terminal thread recording.
Use the native run and stored thread as completion evidence.

Without `nativeRecovery`, the native run requires its live background execution owner. Losing that owner preserves
claims/outboxes for reconciliation and never launches another native run or repeats model spending. Enable the
checkpointed mode below for safe continuation of frontend waits. Inspect metadata through the authorized host API:

```ts
import type { AgUiFrontendTools } from 'mayura/ag-ui';
import type { Scope } from 'mayura/core';

export async function frontendRecoveryView(frontendTools: AgUiFrontendTools, scope: Scope, runId: string) {
  return frontendTools.outboxes({ scope, runId });
}
```

Each row includes call/tool identity, status, deadlines, result digest, continuation ID and delivery metadata.
Recoverable calls also expose `waitState`: `prepared` before native checkpoint publication, then `parked`.
`delivery: 'pending'` means a committed result has no native consumer reservation; `'reserved'` means one consumer
owns delivery. Claim tokens, claim proofs, inputs and result values are omitted. Every row requires scoped
`frontend_result` authorization. There is deliberately no browser retry, claim reset or reservation-transfer API.

Call `journal.purgeExpired(scope, agentId, runId, signal)` from a host retention job to redact expired input/result
payloads. Permanent non-executable tombstones and stable run/call slots remain, so purging never recreates an
executable identity. The host owns the underlying store; closing a bridge stops local waiters without deleting
claims/outboxes or closing shared connections.

### Safe native-owner recovery

Opt in **before defining tools** on every replica:

```ts
import { createAgUiFrontendTools } from 'mayura/ag-ui';
import { createAggregateFrontendToolStore, type AggregateStore } from 'mayura/storage-contracts';
import type { Authorizer } from 'mayura/core';

export function recoverableFrontendTools(database: AggregateStore, authorization: Authorizer) {
  const store = createAggregateFrontendToolStore(database, {
    permissions: { allow: ['frontend-tools:store'] },
  });
  return createAgUiFrontendTools({
    agentId: 'support', store, authorization,
    permissions: { allow: ['ag-ui:frontend-tools'] },
    nativeRecovery: { permissions: { allow: ['ag-ui:frontend-recover'] } },
  });
}
```

Configure the native server with shared `threads` and `runRecords` in background execution mode. The server's
existing thread checkpoint store holds the native continuation. Browser tokens that resume these waits need the
new explicit `runs:resume` capability plus `runs:read`, `threads:read` and `threads:write`; the session advertises
`toolContinuations`. Human `runs:approve` authority does not resume frontend results. Core policies must explicitly
allow `run/resume_tool`, normal run/agent/tool execution and thread read/append, as well as the existing frontend
policy actions. Recovery narrows saved permissions and limits to the current host configuration.

At an idle root boundary, the runtime finishes input validation, input guards, proposal hooks and any required
human approval before preparing the browser call. It saves the settled model response, messages, remaining batch,
provider continuation, admitted input, receipts, approval evidence, counters, spent budget and remaining active time.
The declared frontend cost and call count are conservatively charged once before publication and included in that
checkpoint, so losing an owner or result cannot make a possible browser write free. Result consumption does not
charge that tool bound again; new output-guard/model work uses the remaining budget.
Only after that checkpoint commits can the browser call become dispatchable. An uncommitted or ambiguously saved
checkpoint never causes a live fallback that could expose an unsafe browser write. Nested/speculative runs or an
unsettled sibling operation cannot use this boundary and fail closed before publication.

Result submission still commits the immutable outbox first. The AG-UI adapter then asks the scoped native server
to wake its saved wait. A different server replica can claim the same native run and continue from its saved batch.
The result goes through normal tool output validation, output guards, release hooks and terminal thread recording.
Previously completed models, tools, input guards and proposal hooks are not executed again; remaining work makes
new bounded calls using the continuing budget. There is no budget reset and no new user turn.

The native API is `POST /v1/runs/:id/tool-results/resume` with exactly `{ callId, digest }` from `snapshot.toolWait`.
It accepts no browser result payload. `client.run(id).resumeTool({ callId, digest })` makes one request without
implicit retries. If a committed checkpoint has not yet published its browser call, this command repairs
publication; without an outbox, it leaves the run waiting. Replaying the original AG-UI submission can also repair
publication using its existing native submission identity. It never calls the model again to recreate the proposal.

The headless run store also exposes `store.resumeTool({ callId, digest })` as an explicit one-shot command. It blocks concurrent local submissions, propagates disposal/cancellation and sanitizes errors. Refresh or observe the existing run separately; transport uncertainty never triggers a retry.

For recovery without an active browser request, configure the existing trusted `conversationRecovery` worker and
explicitly authorize work with `kind: 'frontend'`. `server.recoverConversations()` scans parked checkpoints, publishes
an interrupted preparation and consumes a committed outbox when ready. Expired frontend waits cancel without
calling a model or tool. The worker retains its `conversations:recover` grant, per-scope authorization callback,
page/cursor bounds and current core policies. This is separate from the browser's `runs:resume` capability.

Before any result consumption or further paid work, the runtime atomically deletes the exact claimed checkpoint
using its holder, live lease, version and pending digest. The digest fences later checkpoints even if versions
restart for the same run ID. A stale owner cannot consume a later epoch. An expired claim can be reclaimed only
while that **frontend checkpoint still exists**, which proves its continuation was not admitted. Human approval
claims keep their existing reconciliation-only behavior.

Once that consume boundary succeeds, the continuation is one-shot. If the owner fails after consuming it, its next
model/tool might already have started: there is deliberately no automatic replay. An uncertain consume reply also
stops recovery rather than assuming work never started. Inspect the native run, thread and retained outbox evidence.
Native delivery reservations remain permanent. This slice recovers parked frontend waits; it does not resume
arbitrary in-flight paid operations or retroactively recover older outboxes that have no native checkpoint.

The host owns both shared stores and all registry versions. Custom checkpoint adapters must implement atomic
`delete({ runId, holderId, expectedVersion, expectedDigest })` with a live claimed-lease check; silently ignoring those
fields is unsafe. The runtime also claims with `expectedDigest`; adapters must check that digest and the frontend
discriminator atomically before ownership transfer, so stale commands cannot claim a later frontend or approval epoch.
Built-in SQL and document backends use the shared fenced implementation without a schema migration.
Update all serving replicas together when enabling this mode. Custom frontend stores must implement `park` and keep
prepared calls unclaimable. Local regression tests passed; this does not establish reference SDK interoperability.

### Limits and process-local mode

Both modes default to 32 definitions, 128 local pending waits, 64 KiB per input/result, a five-minute binding lifetime
and a further 60-second call retention. A binding cannot outlive `maxRunMs`; tool waits also expire at their declared
timeout. The durable journal defaults to 64 calls per native run, 256 KiB per aggregate and eight CAS attempts.
Its hard caps are 128 calls, 768 KiB and 32 attempts. Storage operations default to five seconds and 32 concurrent
operations per bridge; native owners poll every 100 ms. Uncooperative storage work retains its slot until settlement.
CAS contention retries cannot reopen a claim; ambiguous backend failures are returned without retrying admission.
Permanent tombstones retain storage, so size retention infrastructure for the expected number of runs.

Omitting `store` selects the existing process-local mode: 1,024 live run bindings and 1,024 retained calls by default.
That mode requires dispatch, claim and result requests to reach the same service instance. Process loss makes its
tokens unavailable. Neither mode replays uncertain browser effects. Observer disconnects do not cancel the native
wait; explicit cancellation, timeout or closing the bridge stops the local wait.

The browser helper defaults to a 30-second claim/handler deadline, 64 KiB results, 128 KiB claim responses, 32
concurrent executions and 1,024 claim attempts per helper instance. Claim and handler attempts are one-shot;
uncooperative work retains its slot until settlement. Local regression tests passed; this does not establish reference SDK interoperability.

## Bounds, disconnects and errors

Defaults are 256 KiB per request, 256 incoming messages, 2,000 stored entries, 1 MiB per scanned history/snapshot,
1,100,000 bytes per outgoing event, 8 MiB per stream, 10,000 outgoing frames/native events, 32 concurrent observers, a
five-minute observer lifetime and a 30-second native request timeout. All limits must be finite positive integers;
configuration also caps their maximum values. The stream reserves space for one terminal error frame.

An incomplete, omitted, media-bearing or oversized stored history is refused rather than silently truncated into a
full snapshot. Use the native history APIs for larger conversations; compaction fits model history but retains
source entries and therefore does not reduce this UI snapshot scan. Explicitly choose an appropriate history limit.

Every outgoing frame rechecks native run/thread disclosure rights. Quiet streams send SSE keep-alive comments every 15 seconds, subject to the same authorization and output bounds.
Slow readers exert backpressure; unread streams still expire and free capacity. Cancelling a request or reader, reaching a limit, or calling `adapter.close()` ends
observation and releases capacity. It does **not** cancel the native durable run or undo tool effects. Explicit run
cancellation remains on the native client. Event gaps and truncated streams produce visible errors without silent
reconnection or invented completion. Transport failure can end delivery before a terminal event reaches the client.

Errors before streaming are JSON HTTP errors; errors after `RUN_STARTED` use `RUN_ERROR`. Error responses carry no
provider exception text, stack traces, credentials or raw events. Native policy/audit configuration remains the source
of authorization diagnostics. Local regression tests passed; SDK conformance for this experimental profile remains unqualified.




## Guarded text, media and the runnable notebook

The offline `examples/ag-ui-chat` notebook wires native approvals, thread history, shared state, durable browser
claims/outboxes, parked native continuation checkpoints and an idempotent local note write. It uses a deterministic
zero-cost model, binds to loopback and retains SQLite plus the interrupt secret. Its README documents running and
restarting the host and delivering a saved browser result without rerunning the handler. The notebook source and its opt-in reference `HttpAgent`/schema harness are present. Adapter and native server tests passed locally, but the notebook's browser flow and reference-client harness have not been qualified; SDK conformance is not claimed.

Set `streaming: 'guarded'` with explicit `ag-ui:stream` to project native batch-guard-released `output.delta` frames as
incremental text. The runtime's agent streaming policy owns batch guards. These batches are irrevocably disclosed:
a later final guard can still withhold/rewrite the final output. `mayura.output.withheld` is a safe counts-only custom
event, not permission to retract or replay already visible text. A final message snapshot replaces segment-local
provisional messages with authoritative stored output. Buffered final-only behavior remains the default. Step/tool
and interrupt boundaries stay explicit; a truncated stream never invents completion.

`history.applied` now projects as the metadata-only `mayura.history.applied` CUSTOM event. Raw model reasoning,
provider exceptions and unrestricted native events remain private. This extends event families without inventing
reasoning messages or authority-bearing browser state.

Set `media: true` with `ag-ui:media` to project stored user image/PDF references as typed `image`/`document` content
parts with a `file` source, `provider: 'mayura'`, MIME type and opaque `sha256:` value. Tool references stay inside the
released tool-result text envelope. No byte data, remote URL, third-party provider handle or file fetch is accepted.
The host input mapper may interpret newly supplied reference parts only through its own separately authorized
lookup. Echoes never become trusted thread history. Fresh multipart input still requires a nonempty text part;
32 media parts plus text fit the message bound. Unsupported media and old omission markers fail explicitly.

The typed file-source profile and CUSTOM/text events follow the upstream documentation reviewed on 2026-10-20.
The reference-client harness is intentionally opt-in. Local builds, tests and package checks passed. Actual SDK/CopilotKit interoperability and the notebook's rendered browser flow remain unqualified. Arbitrary in-flight paid-operation recovery, conversation branching, audio/video media
and reasoning disclosure are outside this bounded profile.
