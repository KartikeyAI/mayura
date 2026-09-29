---
title: "Never twice: side effects in durable agent workflows"
description: "How Mayura dispatches each workflow step at most once, surfaces the calls it can't be sure about, and recovers from crashes without paying, emailing or deleting twice."
date: 2026-09-29
tags: durable workflows, reliability, recovery
---

An agent that can only read is easy to make reliable: if something fails, run it again. An agent that can refund a
payment, send an email or delete a record is not, because "run it again" might do the thing twice. This paper
describes what Mayura guarantees about side effects in durable workflows, the mechanism behind the guarantee, the
evidence that it holds, and the assumptions it rests on.

## Summary

- **The guarantee.** Each tool step in a durable workflow run is dispatched at most once. Mayura never calls a tool
  again once it may have acted: not after a crash, a timeout, a lost connection or a race between workers.
- **The price.** Some calls end in a state Mayura can't resolve on its own. A step cut off after it started, before
  its result was recorded, ends **unknown**, and its run ends `outcome_unknown`. Mayura says so, instead of guessing.
- **Exactly once, end to end,** needs one thing from the other side: an idempotency key the provider honours, or a way
  to look the operation up. Mayura gives every call a stable key for that.
- **The evidence.** Tests kill real processes at each point of a step, race independent workers against the same step,
  and stop serverless invocations mid-effect; a live run on Vercel did the same on real infrastructure.

## 1. The problem: retries and effects don't mix

A workflow engine has two options when a step fails partway.

**Retry it.** Nothing is ever lost, but a step that did its work and then failed to report it runs again. Engines that
work this way deliver steps *at least once* and rely on every step being idempotent. For a model-driven agent calling
arbitrary APIs, that is a large assumption: many APIs have no idempotency key, and the ones that do need the caller to
send the same key every time.

**Don't retry.** Nothing runs twice, but a failure has to go somewhere. If the engine just marks the step failed, a
refund that was actually paid looks unpaid, and the next person to look at it pays it again by hand.

Mayura takes the second path and closes its gap: a step that *may* have acted is never marked plain `failed`. It is
marked `unknown`, the run stops, and someone reconciles it. The rest of this paper is about making that distinction
reliably, under crashes and concurrency.

## 2. What a tool declares

Every tool declares its **effects**: `none`, `read`, `write` or `host`. The declaration decides two things. A tool with
effects needs an explicit `effect:<kind>` permission to run at all, and its failures are classified differently:

```ts
const changesNothing = (effects: Effect): boolean => effects === 'none' || effects === 'read';
```

A `none` or `read` tool that throws, times out or is cancelled simply failed: running it again is harmless. A `write`
or `host` tool that fails *after it was dispatched* may have acted, so its outcome is `outcome_unknown`.

A tool can also say, explicitly, that it did nothing. Throwing `ToolRefusal` before any effect records the call as
not started and releases its reserved cost, and the outcome is an ordinary failure:

```ts
import { ToolRefusal, defineTool, z } from 'mayura';

const refund = defineTool({
  id: 'payments.refund', version: '1', description: 'Refund an order.', effects: 'write', capabilities: ['payments:refund'],
  input: z.object({ orderId: z.string(), amountCents: z.number().int() }), output: z.object({ refundId: z.string() }),
  execute: async (input, context) => {
    if (!(await payments.isRefundable(input.orderId))) throw new ToolRefusal('This order cannot be refunded.');
    return payments.refund(input, { idempotencyKey: `${context.runId}/${context.callId}` });
  },
});
```

The idempotency key in that example is the other half of exactly once, covered in section 6.

## 3. The mechanism

### 3.1 Write ahead: record the dispatch, then call

Before a durable step calls its tool, the runtime moves the step to `dispatching` and **commits that to storage**. The
new state and a `lifecycle.step.dispatching` event are written in one transaction, conditional on the run's version:

```ts
step.status = 'dispatching';
step.candidateHash = candidateHash;
await save(record, state, 'lifecycle.step.dispatching', { nodeId: node.id, callId: step.callId });
// Only after this commit is the tool called.
const result = await invokeTool(/* … */);
```

This ordering is the whole foundation. After the commit, the database knows the tool *may* have been called. If the
process dies at any later point, whoever looks at the run next sees a step that was dispatching and knows not to call it
again.

Just before `execute`, a last check re-reads the run and refuses to call the tool unless the step is still
`dispatching`, the run is still running under the same policy, and the step's input digest still matches. A process
that was paused, or lost a race, stops here.

### 3.2 Receipts: evidence, persisted early

When a tool returns, the runtime writes an **execution receipt** (`succeeded`, `failed`, `not_started` or `unknown`)
before it validates the output and runs output guards. If that write can't be confirmed, the call's outcome is
`outcome_unknown`, with the message "Do not replay this operation".

Receipts only move forward. A later receipt that says `unknown` never erases an earlier one that says `succeeded`,
and a contradicting known receipt is rejected as corrupt. So the one fact that matters most, "the effect happened",
survives whatever happens afterwards.

### 3.3 Completion only from `dispatching`

The step's final status is written only if the step is still `dispatching`. A late result from a process that was
presumed dead can't overwrite a decision already made about its step. Its receipt is still merged, so the evidence
isn't lost.

### 3.4 Concurrency: compare and set, not locks

Several workers, or a worker and a serverless invocation, may advance the same run. Every write to a run is a
compare-and-set on its version. On PostgreSQL:

- the row is read `FOR UPDATE`;
- the update is refused with `CONFLICT` unless the version matches;
- the new state and its events are committed together.

When two workers race to dispatch the same step, both read `pending`, both try to write `dispatching`, and exactly one
commit succeeds. The loser reloads the run, finds the step `dispatching`, and leaves it alone.

Worker leadership (one lease per duty, with a fence that increases on every change of holder) only stops replicas
from duplicating host work. It is not what keeps effects single: the compare-and-set is. The code says so where the
lease is defined: leadership "is not the correctness mechanism".

### 3.5 Abandoned steps: a deadline, then a decision

A step left `dispatching` by a process that died must eventually be settled, or its run waits forever. But a step that
is `dispatching` because a live process is still running it must never be touched. Mayura separates the two with a
deadline:

```ts
export const ABANDONED_STEP_MARGIN_MS = 60_000;
export function abandoned(dispatchedAtMs: number | undefined, timeoutMs: number, nowMs: number): boolean {
  return dispatchedAtMs !== undefined && nowMs >= dispatchedAtMs + timeoutMs + ABANDONED_STEP_MARGIN_MS;
}
```

- **Dispatch time** is the timestamp of the step's `dispatching` event. On PostgreSQL that is the database's
  transaction time, so it doesn't depend on any one machine's clock.
- **The timeout** is the tool's `timeoutMs`. A live process always settles a call within it, because the tool
  invocation enforces it.
- **The margin** of one minute covers slow storage and the difference between machines' clocks.

Once the deadline has passed, the next process that advances the run settles the step:

```ts
target.status = target.receipt?.execution === 'succeeded' ? 'blocked' : 'unknown';
```

- If the receipt shows the tool succeeded, the effect happened but its output was never checked and released, so the
  step is `blocked`.
- Otherwise it is `unknown`.

Either way, the tool is not called again. The runtime also never settles a step that it is running itself, however
late it is. The decision is recorded as a `lifecycle.step.abandoned` event, and it needs no operator: any process that
advances the run can make it, including a scheduled serverless invocation.

## 4. What happens to the run

A run whose steps are all settled ends as follows:

- `outcome_unknown` if any step is `unknown`;
- `blocked` if a step was stopped by policy (a missing permission, the budget, a guard) or by the recovery above;
- `failed` otherwise.

There are no automatic retries anywhere. For `outcome_unknown`, the [Outcomes](../../../docs/concepts/outcomes.md)
page gives the procedure:

1. Find the call from the run's evidence: run id, call id, tool id and receipt.
2. Look the operation up in the other system, by its idempotency key if the tool used one.
3. If it happened, continue. If it didn't, submit again.

Durable runs are also pinned to the exact definition they started with, checked on every advance. An upgrade can't
change what a run in flight does next; only an explicit, reviewed migration can. A migration never alters a step that
is `dispatching` or `unknown`.

## 5. Evidence

The guarantee is tested where it can break, with real processes, real databases and real kills. The tests span Mayura's three durable runtimes: the lifecycle runtime the docs recommend, the format-2 runtime and
the scheduled runtime.

| What is tested | How |
|---|---|
| A process killed after each commit point (start, receipt, completion) | A child process is terminated at each point, on SQLite and PostgreSQL; recovery runs and the test asserts nothing was replayed |
| A process killed while an external effect is in flight | The effect is written to disk with `fsync`; after the kill the step is `unknown` and the effect file has one entry |
| A crash after success, before the output was checked | The persisted success receipt is kept, and the output is never rebuilt by running the tool again |
| Independent workers racing one step | Six runtimes race the same pending step; exactly one effect happens |
| A step abandoned by another process | Settled after its deadline, never run again; a late result is dropped |
| A step this process is still running | Never settled, however late; it then succeeds with one effect |
| Serverless invocations stopped mid-effect | Each invocation is a fresh process that exits after answering; one is killed mid-effect and the ledger still has one entry after recovery |

The same scenario was run live on Vercel Functions with Neon PostgreSQL:

1. A charge step with a 30 s timeout was dispatched by a function limited to 10 s. Vercel stopped the function at
   10.4 s with the step `dispatching`.
2. The next invocation left the step alone, because it was within its deadline of 90 s.
3. The first invocation after the deadline, at 95 s, settled it as `unknown` and the run as `outcome_unknown`.
4. The charge was never attempted twice.

[Deploy Mayura on Vercel](../integrations/vercel.md) describes that setup.

## 6. From at most once to exactly once

At-most-once dispatch plus an explicit `unknown` is as far as any system can go alone. A call can always be cut off
after the other side acted and before it answered, and no amount of local bookkeeping can tell those cases apart. The
missing piece has to come from the other side.

Mayura gives every call a stable identity for that: `runId` and `callId`. In a durable workflow the call id is derived
from the run and the step, so the same step always presents the same key. Pass it as the provider's idempotency key, as
in the example in section 2, and a repeated request becomes harmless even outside Mayura: if an operator resubmits
after reconciling, the provider recognises the key.

The division of labour is:

| Layer | Responsible for |
|---|---|
| Mayura | Never dispatching a step twice; recording what it knows; saying `unknown` when it doesn't know |
| The tool | Sending the stable key; refusing with `ToolRefusal` before acting when it can |
| The provider | Honouring the key, or letting you look the operation up |
| You | Reconciling the rare `unknown` |

## 7. Assumptions and limits

The guarantee rests on assumptions. They are listed here so you can check them against your deployment.

- **The one-minute margin must cover storage latency and clock differences.** The deadline assumes that a live
  process finishes writing a step's result within a minute of its tool's timeout. If a write took longer, another
  process could settle the step as `unknown` or `blocked` while the first was finishing. The effect still would not be
  repeated, and the receipt would still be kept, but the step's output would be withheld.
- **Timestamps come from the database on PostgreSQL only.** On SQLite, the writing process stamps events with its own
  clock, which is fine for one host and the reason SQLite isn't meant for several.
- **A timeout is not a kill switch.** When a tool times out, Mayura stops waiting and aborts the tool's signal, but it
  can't interrupt code that ignores the signal. A frozen serverless instance that thaws may also finish its call later.
  `unknown` means exactly that: the effect may or may not have happened.
- **The last check and the effect are not atomic.** The runtime re-reads the run just before calling the tool, but
  another process could act between that read and the call. That window can't cause a second dispatch: recovery never
  redispatches.
- **Recovery is per step.** Inside an agent step, the model's loop isn't checkpointed: a crash mid-step settles the
  step, it doesn't resume the conversation.
- **Settling early is manual.** Before the deadline, only `recoverAbandoned` from code settles a step, for an operator
  who knows its process is gone. There is no HTTP or CLI command for it yet.
- **Concurrency is tested most directly on one runtime.** The race of six independent drivers runs against the
  format-2 runtime (`createWorkflowRuntime`). The lifecycle runtime uses the same compare-and-set pattern and has the process-kill
  and abandonment tests, but not yet its own multi-driver race test.

## Further reading

- [Durable workflows](../../../docs/guides/durable-workflows.md): steps, approvals, timers and recovery.
- [Tools](../../../docs/concepts/tools.md): effects, `ToolRefusal` and idempotency keys.
- [Outcomes](../../../docs/concepts/outcomes.md): what each outcome means and how to reconcile.
- [Workflow operations](../../../docs/guides/workflow-operations.md): pausing, migrating and recovering runs.
- [Build a refund agent that pays only after a person approves](../guides/refund-approval.md): the guarantee in an
  application.
