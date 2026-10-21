---
title: "Runtime"
description: "Create a runtime, submit agents, watch their events, cancel them and read their outcome, costs and evidence."
---

A runtime runs agents. You create it with `createRuntime`, telling it what runs may do (permissions), who they act for
(scope) and how far they may go (limits). Then you `submit` an agent with its input and get a handle to the run. One
runtime can run many agents and many runs at once; usually you create one per process, or one per request when
permissions or scope differ per user.

## Submit a run

```ts
import { createRuntime } from 'mayura';

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:orders.lookup', 'effect:read'] },
  scope: { principalId: 'customer-42', projectId: 'shop' },
  limits: { maxCostMicros: 100_000, maxDurationMs: 30_000 },
});

try {
  const run = runtime.submit(supportAgent, { input: { message: 'Where is order A-1001?' } });

  for await (const event of run.observe()) {
    console.log(event.sequence, event.type, event.metadata);
  }

  const outcome = await run.result();
  if (outcome.status === 'succeeded') console.log(outcome.output);
  else console.error(outcome.status, outcome.error.code, outcome.error.message);

  console.log(runtime.inspect(run).budget); // { spentMicros, reservedMicros, calls }
} finally {
  await runtime.close();
}
```

### A conversation history

A run starts from its input. To continue a conversation, pass the turns before it as `history`, oldest first:

```ts
const followUp = runtime.submit(supportAgent, {
  input: { message: 'And when will it arrive?' },
  history: [
    { role: 'user', content: { message: 'Where is order A-1001?' } },
    { role: 'assistant', calls: [{ id: 'call-1', toolId: 'orders.lookup', input: { orderId: 'A-1001' } }] },
    { role: 'tool', callId: 'call-1', toolId: 'orders.lookup', result: { status: 'shipped' } },
    { role: 'assistant', output: { reply: 'Order A-1001 has shipped.' } },
  ],
});
```

- **Whole turns:** every tool call has its result, in the order called, before the next message. An earlier final
  answer is `{ role: 'assistant', output }`. A history that breaks this is refused with `INVALID_INPUT` before the run
  starts.
- **Sent on every model call:** the history goes before the run's own messages on every model call of the run, and
  counts toward `limits.maxContextBytes`.
- **Adapter support:** only a model adapter that declares `capabilities.history` takes a history. Every Mayura
  provider does. With an adapter that doesn't, the submission is refused with `INVALID_CONFIG` rather than sent without
  it.
- **Across providers:** a history can come from another provider's run. Each adapter sends it in its provider's own
  format, with no reasoning or thinking state. Call ids a provider refuses (Anthropic and Bedrock allow fewer
  characters, Mistral needs nine letters and digits) are renamed on the wire only. Anthropic and Bedrock refuse tool
  blocks in a request without tools, so for an agent without tools, earlier calls and results are sent as JSON text.
- **No media yet:** history carries no media in this release.
- **Hooks:** they see the history in their content view of a model call.
- **Events:** `run.started` reports how many messages it has.

## Options

| Option | Default | What it is |
| --- | --- | --- |
| `profile` | required | Must be `'ephemeral'`. Anything else throws `UNSUPPORTED_PROFILE`. |
| `permissions` | `{ allow: [] }` | What runs may use. Nothing is allowed by default. See [Permissions](./permissions.md). |
| `scope` | `{ principalId: 'local', projectId: 'default' }` | Who runs act for. Tools, guards and hooks receive it. |
| `limits` | see below | Ceilings for every run. |
| `approvals` | none | `{ tools, expiresInMs, onExpired }`: tools whose calls need a person's approval, and how long a request waits. See [Approve a tool call](#approve-a-tool-call). |
| `checkpoints` | none | `{ store, agents?, replicaId?, leaseMs?, autoExpire? }`: save runs waiting for approval, so they survive a restart. See [Surviving a restart](#surviving-a-restart). |
| `recorder` | none | Host `RunRecorder` with idempotent `begin` and `complete` callbacks. For persisted conversation turns, use `threads.recorder`; the association and approval decisions survive checkpoints. See [Threads](../guides/threads.md#recording-across-restarts). |

`ephemeral` means the runtime keeps everything in memory. Runs, events and costs are lost when the process exits, and
a run interrupted by a crash is not resumed. For work that must survive restarts, use
[durable workflows](../guides/durable-workflows.md).

`scope.principalId` and `scope.projectId` must start with a letter or digit and may contain letters, digits, `.`,
`_`, `/` and `-`, up to 128 characters. Use an internal user id, not an email address.

## Limits

Each submitted run gets its own counters and its own cost budget, checked against these limits. `maxConcurrentRuns`
and `maxConcurrentOperations` also apply to the runtime as a whole. Child runs count against their parent's limits.

| Limit | Default | What it bounds |
| --- | --- | --- |
| `maxHandoffs` | `8` | Transfers within one root run; 0–64. History, budget and counters continue across targets. See [Agent handoffs](../guides/agent-handoffs.md). |
| `maxSteps` | `16` | Model turns in one run. Reaching it fails the run with `LIMIT_EXCEEDED`. |
| `maxModelCalls` | `16` | Model calls, including model-backed guards. |
| `maxToolCalls` | `64` | Tool calls. `0` is allowed. |
| `maxHookCalls` | `128` | Lifecycle hook calls. |
| `maxDurationMs` | `60000` | Wall-clock time for the run. |
| `maxInputBytes` | `1048576` | Size of the submitted input and of each tool input. |
| `maxOutputBytes` | `1048576` | Size of the final output and of each tool output. |
| `maxContextBytes` | `2097152` | Size of the conversation sent to the model, without media. |
| `maxMediaBytes` | `20971520` | All images and PDFs in one run, with the input and from tools. See [Vision](../guides/vision.md). |
| `maxOutputTokens` | `4096` | Output tokens the model may generate per call. |
| `maxCostMicros` | `0` | Total cost of the run, in micros. See [Costs and budgets](./costs-and-budgets.md). |
| `maxEventRetention` | `256` | Events kept in memory per run for `observe()`. |
| `maxConcurrentRuns` | `32` | Top-level runs in progress at once. |
| `maxDescendantRuns` | `64` | Child runs one run may start, counting their children. |
| `maxDepth` | `8` | How deep child runs may nest. |
| `maxConcurrentOperations` | `32` | Model calls, tool calls, validations and guards in progress at once. |

Every limit except `maxCostMicros` and `maxToolCalls` must be a positive integer. An unknown limit name throws
`INVALID_CONFIG`.

`maxCostMicros` defaults to 0, so a paid model is refused until you set it. Only free models (for example the
scripted test model, whose calls cost 0) work without it.

## The run handle

`runtime.submit(agent, { input })` returns a `RunHandle` right away; the run starts on its own.

| Member | What it does |
| --- | --- |
| `id` | The run's id. |
| `result()` | A promise of the run's outcome. It never rejects for a failed run; check `status`. Call it as often as you like. |
| `observe(options?)` | An async iterable of the run's events. Ends when the run ends. |
| `cancel()` | Asks the run to stop. Safe to call more than once. |

`submit` itself throws only when the run cannot start at all: the input is not plain JSON or is larger than
`maxInputBytes` (`INVALID_INPUT`), `maxConcurrentRuns` runs are in progress (`LIMIT_EXCEEDED`), or the runtime is
closed (`CONFLICT`). Everything after that, including invalid input for the agent's schema, arrives as the outcome.

## Events

Every event has `runId`, a `sequence` number that increases by one, a `timestamp`, a `type` and a small `metadata`
object (ids, counts and statuses, never prompts or secrets).

| Type | When |
| --- | --- |
| `run.started` | The run began. |
| `step.started`, `step.completed` | A model turn began or ended. |
| `model.started`, `model.completed` | A model call began or returned. |
| `tool.started`, `tool.completed` | A tool call began or ended, with its status. |
| `hook.started`, `hook.completed` | A lifecycle hook ran. |
| `delegate.started`, `delegate.completed` | A child run began or ended. |
| `output.delta`, `output.withheld` | A streamed batch of text was released, or streaming stopped. |
| `approval.requested` | The run is waiting for a person to approve a tool call: its `callId`, `toolId`, `digest` and `expiresAtMs`. |
| `approval.resolved` | The request was answered (`approved` or `rejected`, with the `actorId`) or `expired`. |
| `events.gap` | Older events were dropped before you read them. |
| `run.completed` | The run ended, with its status and cost totals. |
| `run.paused`, `run.resumed` | A run waiting for approval was saved to the checkpoint store, or continued from it. |

Events are kept in a buffer of `maxEventRetention` entries. If you start observing late, or read slower than the run
writes, the oldest events may be gone; you then get one `events.gap` event with the missing range instead of silence.
Pass `after: sequence` to resume after an event you already saw, and `signal` to stop observing. Observing never
changes the run, and stopping observation does not cancel it.

## Cancel a run

`run.cancel()` stops the run from starting new model calls, tool calls or child runs, and the outcome becomes
`cancelled`. Work already in progress is told through its `AbortSignal`; a tool that already sent a request may still
complete it. In that case the call is `outcome_unknown`, and so is the run. See [Outcomes and errors](./outcomes.md).

When `maxDurationMs` passes, the run is stopped the same way and fails with `TIMEOUT`.

## Approve a tool call

A tool can require a person to approve a call before it runs. Declare it on the tool, for every call or depending on
the input the model proposed:

```ts
import { createRuntime, defineTool, z } from 'mayura';

const refund = defineTool({
  id: 'orders.refund', version: '1', description: 'Refund part or all of an order.',
  input: z.object({ orderId: z.string(), amountCents: z.number().int().positive() }),
  output: z.object({ refundId: z.string() }), effects: 'write', capabilities: [],
  approval: input => input.amountCents > 10_000, // refunds over $100 wait for a person
  execute: async input => ({ refundId: `re_${input.orderId}` }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:orders.refund', 'effect:write'] },
  approvals: { expiresInMs: 30 * 60_000 },
});

const run = runtime.submit(refundAgent, { input: { message: 'Refund order A-1001 in full.' } });
for await (const event of run.observe()) {
  if (event.type !== 'approval.requested') continue;
  const { approval } = runtime.inspect(run); // the exact call: toolId, toolVersion, input
  if (approval && (await askManager(approval))) {
    await runtime.approve(run, { callId: approval.callId, digest: approval.digest, decision: 'approved', actorId: 'manager-7' });
  } else if (approval) {
    await runtime.approve(run, { callId: approval.callId, digest: approval.digest, decision: 'rejected', actorId: 'manager-7',
      reason: 'Refunds over $100 need a receipt.' });
  }
}
```

- **When it asks:** only for a call that passed the run's permissions, the tool's input schema and any
  `beforeToolCall` hook. An approval never grants anything the run lacks. Earlier calls of the same batch run first.
- **Waiting:** the run's status is `waiting`, and `runtime.inspect(run).approval` holds the call: `callId`, `toolId`,
  `toolVersion`, `input`, `digest` and `expiresAtMs`. The run holds no reservation while it waits, and waiting does
  not count against `maxDurationMs`. `result()` stays pending until the run ends.
- **Answering:** `runtime.approve(run or runId, { callId, digest, decision, actorId, reason? })`. The digest binds
  the answer to this run, call, tool version, input and expiry; a different one is refused with `CONFLICT`, as is an
  answer after the request expired. A call is answered once.
- **Approved:** the tool runs with exactly the approved input, under the run's limits as they are then.
- **Rejected:** the call does not run. The model gets `{ error: 'APPROVAL_REJECTED', message, reason? }` as the tool's
  result and carries on, for example by explaining to the user.
- **Expired:** after `approvals.expiresInMs` (default 15 minutes, at most 7 days), the model gets
  `{ error: 'APPROVAL_EXPIRED', message }`. With `onExpired: 'cancel'`, the run is cancelled instead.
- **Cancelling** a waiting run ends it `cancelled`; the call never runs.
- **Without editing tools:** `approvals: { tools: ['orders.refund'] }` makes every call of those tools wait.
- **Only root runs wait.** A child run, a speculative branch or a hook action that reaches a call needing approval
  fails with `APPROVAL_UNAVAILABLE`. So does calling the tool outside a run, for example from code mode or a workflow
  step: the tool checks for the runtime's proof that a person approved that exact call.
- **In memory:** without `checkpoints`, a waiting run lives in this process. If it exits, the run is lost, as any
  ephemeral run is.

### Surviving a restart

Give the runtime a checkpoint store, and a waiting run is saved there instead of held in memory. Any runtime with the
same store, scope and agent can then approve and continue it, after a restart or on another server:

```ts
import { createRuntime } from 'mayura';
import { createSqliteStore } from 'mayura/storage-sqlite';

const store = createSqliteStore({ filename: 'runs.sqlite' });
await store.initialize();
await store.threads.initialize(); // creates the thread and run-checkpoint tables

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:orders.refund', 'effect:write'] },
  scope: { principalId: 'support-team', projectId: 'shop' },
  checkpoints: { store: store.runCheckpoints, agents: [refundAgent] },
});

// Later, perhaps in another process: answer by run id. The run continues here.
const run = await runtime.approve(runId, { callId, digest, decision: 'approved', actorId: 'manager-7' });
console.log(await run.result());

// Now and then, continue saved runs whose request expired.
setInterval(() => void runtime.expireApprovals(), 60_000);
```

- **When a run is saved:** when it pauses at a safe point, with no child run still running and nothing reserved. It
  emits `run.paused`, holds no concurrency slot or active-run deadline, and its status is `waiting`. Otherwise, or if the store
  cannot take it (it holds at most 3 MiB), it waits in memory.
- **What is saved:** the conversation so far (with media), the paused batch's remaining calls, the provider
  continuation, its call counts, what it spent, its receipts, its permissions and limits, and the active time it had
  left. Waiting still does not count against `maxDurationMs`.
- **Answering:** `approve` checks the call and digest against the saved run, then claims it. A run this process paused
  continues on its own handle; otherwise `approve` returns a new handle, whose events start with `run.resumed`.
- **At most once:** before the approved call runs, the runtime removes the checkpoint. If another runtime took the
  run meanwhile, removing fails and nothing runs here: the run ends `failed` with `CONFLICT`.
- **The same agent:** `checkpoints.agents` lists the agents this runtime may continue when it did not start the run.
  If an agent's definition changed while the run waited (its instructions, model, tools, guards, hooks or schemas),
  the run cannot continue: `approve` throws `DEFINITION_CHANGED` and the saved run is removed.
- **Never wider:** a resumed run keeps its own permissions and limits, narrowed to this runtime's. Its budget counts
  what it spent before the pause.
- **Expiry:** a runtime continues the runs it paused when their request expires, while it lives.
  `runtime.expireApprovals()` handles the rest of this scope's expired runs, as their policy says. Set
  `checkpoints.autoExpire: false` when a host owns expiry scheduling. `runtime.expireApproval(runId)` handles one saved
  request and returns `not_due`, `cancelled`, or `{ status: 'resumed', run }`; observe and persist the returned handle.
  Hosted servers use [conversation recovery](../guides/server-and-client.md#hosted-conversation-recovery) for this.
- **Cancelling** a saved run removes its checkpoint first, so no other runtime continues it.
- **Closing** the runtime leaves saved runs in the store. Their handles in this process settle only if this runtime
  continues them.
- **Hosted approvals:** the [server and client](../guides/server-and-client.md) expose waiting calls and scoped decisions.

## Inspect a run

`runtime.inspect(handle)` returns a snapshot of a run and its children, while it runs or after:

- `status`: `running`, `waiting` (for an [approval](#approve-a-tool-call)) or the final status.
- `approval`: while the run waits, the call it asks a person to approve.
- `budget`: `spentMicros`, `reservedMicros` (cost held for calls in progress or with unknown cost) and `calls`.
- `runs`: the run and every child run, with ids, agent ids and statuses.
- `evidence`: for each tool call, whether it ran (`not_started`, `succeeded`, `failed` or `unknown`) and whether its
  result was released to the model.

## Child runs and speculation

Two methods start runs under a running parent, sharing its budget and limits:

- `runtime.spawn(parent, agent, { input, permissions, limits })` starts a child run. The child gets only the
  permissions you list that the parent also has, and its limits cannot exceed the parent's. The parent needs
  `agent:delegate`. Most apps use `agentAsTool` instead, so the model decides when to delegate.
- `runtime.speculate(parent, { branches, verify })` runs 1 to 8 read-only branches at once and keeps at most one
  result, the first that your `verify` function accepts.

Both are covered in [Child agents](../guides/child-agents.md).

## Close the runtime

`await runtime.close()` stops accepting runs, cancels the runs in progress and waits until each has an outcome.
Call it when your process shuts down, or in a `finally` block in scripts and tests.

## Good to know

- Limits are enforced between steps and at every call. Your own code in tools and hooks is not interrupted by force;
  it must respect `context.signal`.
- A runtime's permissions and scope are fixed when you create it. For per-user authority, create a runtime per user
  or request; it is cheap.
- For a runtime behind HTTP, with authentication and a client, see [Server and client](../guides/server-and-client.md).

## Related

- [Agents](./agent.md)
- [Outcomes and errors](./outcomes.md)
- [Permissions](./permissions.md)
- [Costs and budgets](./costs-and-budgets.md)
- [Observability](../guides/observability.md)

## Run recording

`RunRecorder`, `RunRecordingContext`, `RunRecording` and `RecordedApproval` describe an optional trusted host
persistence seam. A submission's `recording` is a JSON object of identifiers, bounded to 4096 UTF-8 bytes; `begin`
persists its association before execution. `complete` receives the run's released messages, retained approval
decisions and final outcome before the handle settles. Configure the recorder on every replica that resumes a bound
run. These callbacks are trusted storage code, not model tools or a sandbox.

A recording failure reports `STORAGE_UNAVAILABLE` while retaining the original completion for
`runtime.retryRecording(handle)`. This retries persistence only; it never reruns a model or tool, and does not change
the handle's already-settled outcome. [Threads](../guides/threads.md#recording-across-restarts) add a durable terminal
journal and recovery for this seam.

`runtime.cancelSaved(runId)` cancels an approval checkpoint in this runtime's scope without dispatching its pending
tool. It claims and deletes the checkpoint, and records the cancelled turn when a recorder is configured.

## Fine-grained execution authorization

Set `createRuntime({ authorization })` with a host-owned core authorizer to guard scoped root/child execution,
handoffs, model dispatch, approvals and the common tool broker. `submit`/`spawn` retain synchronous handles; asynchronous
admission can end a run as blocked before paid work. Existing static grants, target permissions, budgets and approvals
remain independent. Standalone `invokeTool` and `invokeBatch` accept the same authorizer. See
[agent runs and tool execution](../guides/authorization.md#agent-runs-and-tool-execution) for actions, audit lifecycle,
receipt preservation and trusted-handle semantics.

## History fitting metadata

`runtime.submit(agent, { input, history })` accepts either the existing readonly message array or a `RunHistory`
object with `messages`, `omittedTurns` and optional `scanTruncated`. The result of `threads.history(...)` fits this
shape directly. Only messages are passed to models; metadata is bounded informational data, not authorization.
Nonempty history still requires the adapter's `history` capability and counts toward `maxContextBytes`.

A fresh admitted run emits `history.applied` with exactly `{ entries, omitted, bytes, scanTruncated }`, once after
its input boundary succeeds. Entries count messages, omissions count known whole turns, and bytes measure the
UTF-8 JSON representation. Empty supplied history reports `{ entries: 0, omitted: 0, bytes: 2, scanTruncated: false }`;
a submission without history emits no such event. Resuming a checkpoint or handing off within the same run does not
reapply history. See [threads](../guides/threads.md#history-application-events) and
[approval observers](../guides/lifecycle-hooks.md#approval-request-observers).
