---
title: "Hard budgets: reserving the worst case before every model call"
description: "How Mayura keeps agent runs under their cost limit: each call's maximum is reserved before it starts and settled after, on one ledger shared by agents and workflows."
date: 2026-10-12
tags: budgets, costs, agents, durable workflows
---

A cost limit on an agent is only useful if it holds when things go wrong: when the model asks for ten tools at once,
when three child agents run in parallel, when a provider times out after billing, when a process restarts halfway.
This paper describes how Mayura enforces a hard budget, the alternatives it rejects, the code that implements it, and
the assumptions the guarantee rests on.

## Summary

- **The rule.** Every model call and tool call declares the most it can cost. That amount is reserved from the budget
  *before* the call starts, and the call starts only if it fits. Afterwards the actual cost is charged and the rest is
  released.
- **The guarantee.** Confirmed spending plus outstanding reservations never exceeds the limit at the moment a call is
  admitted, for the run and for every budget above it. The one exception is a call whose actual cost is above its own
  declared maximum; that is recorded in full, and the budget then admits nothing more.
- **Unknown costs stay reserved.** A call that may have been billed but reported no usage keeps its full reservation.
  A timeout, a cancellation or closing the runtime never turns an unknown cost into zero.
- **One ledger.** Child agents, agent steps in workflows and your own parallel tasks spend from the same ledger as
  their parent, under lower ceilings. Durable budgets keep the same ledger in a database across restarts.

## 1. Why a soft budget overshoots

There are two common ways to put a limit on what an agent spends, and both let a run go over.

**Check what was spent, then call.** Before each call, compare the running total with the limit; if there is room
left, make the call. The call that crosses the line still runs in full, so a run can end above its limit by up to one
call's cost. With parallel calls it is worse: five calls that start together all see the same remaining funds, all
pass the check, and the run can end above its limit by five calls. Child agents with counters of their own multiply
it again, because each child checks its own total, not its parent's.

**Estimate the cost, then call.** Count the prompt's tokens locally, multiply by the price, and refuse a call that
would not fit. This narrows the gap but cannot close it, for reasons that have nothing to do with the quality of the
estimate:

- A local token count is an approximation of the provider's. Tool schemas, message framing, images and cached tokens
  are counted by the provider, in the provider's way.
- The output is not known until the call ends. An estimate of the prompt says nothing about whether the model writes
  20 tokens or 4,000.
- One logical call can be several billed attempts: retries after a transient failure, a fallback to a second provider.
- A provider can bill a call that then fails, times out or is cancelled, and report no usage for it.

An estimate describes the expected case. A limit has to hold in the worst case, so Mayura does not estimate at all.
It needs to know only the most a call can cost, and it reserves that.

## 2. What a call declares

Mayura counts money in **micros**, millionths of a US dollar, as integers, so totals never drift by rounding. Every
call has a ceiling:

- A model adapter's `maxCostMicros` is the most one model call may cost. Providers compute the actual cost from the
  token usage they report and the prices you configure, rounded up to a whole micro. The arithmetic is exact, in
  `BigInt` (`packages/core/src/pricing.ts`):

  ```ts
  const cost = (BigInt(inputTokens) * BigInt(rates.inputMicrosPerMillionTokens)
    + BigInt(outputTokens) * BigInt(rates.outputMicrosPerMillionTokens) + 999_999n) / 1_000_000n;
  ```

- A tool's `costMicros` (default 0) is the most one tool call may cost, for tools that spend money themselves: a paid
  API, an SMS, a search query.

The ceiling is a promise about the worst case, and the runtime helps make it one: it sends `limits.maxOutputTokens`
(4,096 by default) to the provider as the output limit, so the output side of the worst case is bounded by the
provider, not guessed. The [Costs and budgets](../../../docs/concepts/costs-and-budgets.md) page works an example:
with input at 250,000 micros and output at 2,000,000 micros per million tokens, 20,000 input tokens and 4,096 output
tokens cost 5,000 + 8,192 = 13,192 micros, so a ceiling of 20,000 leaves room.

Wrappers that make one call into several attempts raise the ceiling to match. A model from the
[model registry](../../../docs/guides/model-registry.md) with `retry: { attempts: 3 }` has a ceiling of three times
the adapter's (`packages/runtime/src/models.ts`), and a
[model router](../../../docs/guides/model-routing.md) reserves the sum of its `maxAttempts` largest route ceilings,
because one call may try that many routes. A fallback that is never used still counts toward every reservation. That
is the cost of a ceiling that holds.

## 3. Reserve, call, settle

The ledger is `Budget`, in `packages/core/src/budget.ts`. `reserve(maxMicros)` checks the run's account and every
account above it, and only then commits:

```ts
if (path.some(ancestor => ancestor.heldCalls >= ancestor.maxCalls - ancestor.calls
  || bound > BigInt(ancestor.maxCostMicros) - ancestor.spent - ancestor.reserved)) {
  throw exhausted(path, 1, bound);
}
// No callback or await can interleave ancestor validation and commit.
for (const ancestor of path) { ancestor.calls++; ancestor.reserved += bound; }
```

Because the check and the commit run with no `await` between them, they are atomic within a process: JavaScript runs
one piece of synchronous code at a time, so no other call can slip in between. A refused reservation changes no
counter. The runtime reserves before the first `await` of a call, so parallel calls cannot spend the same funds.

The reservation returned is settled once, with the confirmed cost and any part that is still unknown:

```js
for (const ancestor of path) { ancestor.reserved -= bound; ancestor.reserved += unknown; ancestor.spent += known; }
```

The ceiling comes off, the known cost goes into `spent`, and an unknown remainder stays in `reserved`. The same
reservation cannot be settled twice.

### 3.1 In an agent run

Before each model call, the runtime reserves the model's ceiling. If the agent has output guards that call a model of
their own, their ceilings are reserved in the same step, as one all-or-nothing bundle (`reserveBundle`), so a call
can never start and then find it cannot pay for the check its output must pass. The model is called only after the
reservation succeeds; its reported cost settles it.

When the model asks for tools, the runtime adds up the `costMicros` of every call in the batch and checks that the
whole batch fits before the first tool runs. Each tool then reserves its own ceiling when it is dispatched, through
the same broker that checks its permissions and schema. A tool that reports its real cost with
`context.reportUsage` is charged that; one that reports nothing is charged its full `costMicros`.

### 3.2 What it looks like

The results in this section and the next come from running this code against the built workspace packages
(`pnpm build`, then Node.js 24 on Windows 11). The first shows five calls starting at once against $0.05, each with
a ceiling of $0.02:

```ts
import { Budget, MayuraError } from 'mayura';

const budget = new Budget(50_000, 10); // $0.05 and 10 calls in total
const outcomes = await Promise.all([1, 2, 3, 4, 5].map(async () => {
  try {
    const reservation = budget.reserve(20_000); // before the first await
    await new Promise(resolve => setTimeout(resolve, 10)); // the call itself
    reservation.settle(13_192); // what it actually cost
    return 'admitted';
  } catch (error) {
    return error instanceof MayuraError ? error.code : 'error';
  }
}));
console.log(outcomes, budget.snapshot());
```

Two calls are admitted and three are refused with `BUDGET_EXCEEDED`; the snapshot is
`{ spentMicros: 26384, reservedMicros: 0, calls: 2 }`. A check-then-call budget would have admitted all five, since
each would have seen $0.05 left.

The second is an agent run with a run limit of 50,000 micros and a model whose ceiling is 20,000, where every call
actually costs 18,000:

```ts
import { createRuntime, defineAgent, defineTool, z } from 'mayura';
import { scriptedModel } from 'mayura/testing';

const lookup = defineTool({
  id: 'lookup', version: '1', description: 'Look something up.', effects: 'none', capabilities: [],
  input: z.object({}), output: z.object({ ok: z.boolean() }), execute: async () => ({ ok: true }),
});
const step = (id: string) => ({ type: 'tool_calls' as const, calls: [{ id, toolId: 'lookup', input: {} }], usage: { costMicros: 18_000 } });
const agent = defineAgent({
  id: 'researcher', version: '1', instructions: 'Research.', input: z.object({}), output: z.object({ done: z.boolean() }),
  tools: [lookup], model: scriptedModel([step('c1'), step('c2'), step('c3')], { maxCostMicros: 20_000 }),
});
const runtime = createRuntime({
  profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:lookup'] }, limits: { maxCostMicros: 50_000 },
});
const run = runtime.submit(agent, { input: {} });
console.log(await run.result(), runtime.inspect(run).budget);
await runtime.close();
```

The run ends `blocked` with "The call may cost up to 20000 micros, but only 14000 of the budget's 50000 micros are
left; no new call was started." Its budget is `{ spentMicros: 36000, reservedMicros: 0, calls: 4 }`: two model calls
and two tool calls. The third model call never started.

## 4. When a call costs more than it said

A ceiling is a declaration, and Mayura cannot stop a provider from charging more than you expected: prices change,
and a misconfigured ceiling is easy to write. So the ledger treats an overrun as a fact to record, not an error to
hide. When a call settles above its ceiling, the full cost is recorded and the whole ledger stops admitting calls:

```js
if (known + unknown > bound) {
  account.ledger.blocked = true;
  throw new MayuraError('BUDGET_EXCEEDED', 'Reported usage exceeded its bound; known and unresolved usage were retained.');
}
```

The ledger is shared by the run and every account forked from it, so an overrun anywhere in a tree of agents stops
the whole tree. A model whose ceiling is 20,000 and whose call reports 25,000 ends its run `blocked` with that
message, and the budget shows `spentMicros: 25000`. Totals that grow beyond the safe-integer range are kept exactly,
as a decimal string, instead of being rounded.

This is the one way a run can end above its limit, and it is bounded by what the provider charged for the one call
that broke its promise. No further call starts.

## 5. Unknown costs

Sometimes Mayura cannot know what a call cost: the model call failed without the provider reporting usage, or a tool
with effects threw or timed out after it was dispatched. The safe assumption is that it cost its whole ceiling, so the
ceiling stays reserved. It appears as `reservedMicros` and counts against the budget like spending.

Adapters that do know can say so. A model adapter that fails after the provider reported usage throws
`ModelInvocationError` (or `ModelProviderError` with `costMicros`), and that amount is charged instead of the whole
ceiling. A tool reports `{ knownCostMicros, unknownCostMicros }`; any unknown part above zero makes the call
`outcome_unknown`, for the same reason a side effect would. Retries follow the same rule: an attempt whose cost is
unknown is counted at its full ceiling in the total for the call.

What never happens is the convenient answer. A timeout, a cancellation or `runtime.close()` releases reservations for
calls that never started, and leaves reservations for calls that might have been billed.

## 6. One ledger for agents and workflows

A budget is a tree of accounts on one ledger. `fork({ id, maxCostMicros, maxCalls })` makes a child account with a
lower ceiling, but the child spends the parent's funds:

```ts
import { Budget } from 'mayura';

const nightly = new Budget(5_000_000, 500); // $5 and 500 calls in total
const perTeam = nightly.fork({ id: 'team-a', maxCostMicros: 1_000_000, maxCalls: 100 });
perTeam.reserve(20_000).settle(12_400);
console.log(nightly.snapshot()); // { spentMicros: 12400, reservedMicros: 0, calls: 1 }
```

A child's ceiling is a ceiling, not an allocation: forking reserves nothing, and children compete for whatever their
ancestors have left at the moment they reserve. Every reservation checks and updates the whole path to the root, so a
child can never spend money its parent no longer has, and the totals of an account already include its children.
A ledger holds at most 1,024 accounts, 32 levels deep.

The runtime builds on this:

- **Child agents.** A child run, from `agentAsTool`, `runtime.spawn` or speculative branches, gets a fork of its
  parent's budget (`packages/runtime/src/runtime.ts`). Its limits may only be lower than its parent's, and its model
  and tool calls count against every ancestor's call limits too. See
  [Child agents](../../../docs/guides/child-agents.md).
- **Durable workflows.** A run has one budget shared by all its steps, kept in the run's record. A tool step's
  reservation is written in the same compare-and-set commit that marks the step `dispatching`, so two workers racing
  for the last funds cannot both win; the loser reloads and finds the money taken. A step that cannot be covered is
  `blocked`.
- **Agent steps.** `agentStep` runs an agent inside a workflow step. The step reserves the agent's `maxCostMicros`
  from the workflow's budget and is charged what the agent actually spent, or keeps the whole ceiling reserved if the
  agent's outcome is unknown. See [Durable workflows](../../../docs/guides/durable-workflows.md#agent-steps).
- **Sagas and loops** add up their worst case before they start (every tool's `costMicros`, times `maxIterations` for
  a loop) and refuse to start with `LIMIT_EXCEEDED` if it is above the limit.
- **Your own fan-out.** `runBudgetedTasks` from `mayura/helpers` reserves every task's ceiling in one step and runs
  nothing if they do not all fit.

All-or-nothing reservations use bundles. `reserveBundle` holds 1 to 128 future calls and their money on every
account in the path at once; each ticket in the bundle starts at most once, and closing the bundle releases only the
tickets that never started.

## 7. Durable budgets

`Budget` lives in one process. A ceiling across processes and restarts, such as "this tenant may spend $50 today
across every worker", needs the ledger in a database. `store.durableBudgets` keeps the same ledger in SQLite or
PostgreSQL (and the other stores in [Storage](../../../docs/guides/storage.md) that support it), with the same
operations: `create`, `fork`, `reserveBundle`, `start`, `markUnknown`, `settle`, `cancelReservation`, `closeSubtree`,
`inspect` and `events`.

The SQL implementation is built so that the database, not the caller, decides what a budget's totals are
(`packages/storage-sql/src/durable-budget-*.ts`):

- **One writer per budget.** Each command runs in one transaction that locks the budget's identity and its root row.
  Two processes reserving the last funds are serialized; one is refused.
- **Totals are recomputed, never trusted.** A pure reducer applies the command, then rebuilds every account's spent,
  reserved and call totals from the reservations themselves. In the code's words, "No supplied deltas are trusted".
- **State and history together.** The new state and one event are committed in the same transaction. On every load,
  the stored state is checked against its canonical form and its event journal must be complete and contiguous.
- **Retries are harmless.** Repeating a command that already happened, with the same content, changes nothing.
  `start` on a reservation that was already started returns `already_started`, so a restart can never turn an old
  start into permission for a new call.

`examples/durable-budgets.mjs`, which CI runs, shows the property that matters most after a crash. A reservation of 4
micros is started, marked unknown, and its account closed; the root still reports 4 micros reserved. After the store
is closed and reopened, `start` returns `already_started`, and the late confirmed cost of 3 settles it: 3 spent, 0
reserved, 1 call.

```ts
const key = { scope: 'example', id: 'shared-budget', policyHash: 'a'.repeat(64) };
await store.durableBudgets.create({ ...key, maxCostMicros: 10, maxCalls: 4 });
await store.durableBudgets.fork({ ...key, parentId: 'root', accountId: 'review', maxCostMicros: 6, maxCalls: 2 });
await store.durableBudgets.reserveBundle({ ...key, accountId: 'review', bundleId: 'review-pair',
  operations: [{ id: 'primary', maxCostMicros: 4 }, { id: 'check', maxCostMicros: 2 }] });
```

The storage conformance suite runs the same cases on each store, among them: only one of two concurrent sibling
reservations gets the last funds; unknown funds survive closure and restart and accept exactly one late known cost;
an overrun above the safe-integer range is committed exactly before further admission is blocked.

A durable budget is a building block that your code drives: you reserve before your own dispatch and settle with the
evidence you have. The agent runtime's per-run budget is the in-memory `Budget`.

## 8. Alternatives considered

**Post-hoc accounting with alerts.** Record every cost and alert when a total passes a threshold. That is useful and
compatible with Mayura's events (`model.completed` carries `costMicros`), but it is observability, not a limit.

**Token estimation before each call.** Rejected for the reasons in section 1. It would also tie the budget to a
tokenizer per provider, while the reserve-and-settle ledger needs nothing but a number from the adapter.

**Pre-allocating funds to children.** Giving each child its own slice of the parent's money is simple and never
overshoots, but it wastes budget: a child that finishes early strands its slice, and the right split is rarely known in
advance. Mayura's children have ceilings on shared funds instead, which gives the same safety with no stranded money.

**Refunding unknown costs after a timeout.** It would make budgets look healthier and would be wrong whenever the
provider did bill. Keeping the reservation is pessimistic on purpose; a person or a reconciliation job can settle it
later with real numbers.

## 9. Assumptions and limits

- **The prices and ceilings are yours.** Mayura computes costs from the prices you configure and does not look them
  up. Its totals are an estimate of your invoice, not the invoice. A wrong price makes every total wrong, in either
  direction.
- **Ceilings trade capacity for safety.** A call is refused when its ceiling does not fit, even if it would have cost
  much less. A generous ceiling admits fewer calls per budget; a tight one risks an overrun, which stops the run.
- **An overrun is bounded but real.** If a provider charges more than a call's ceiling, the run ends above its limit
  by the difference. Mayura records it and stops; it cannot undo the charge.
- **The runtime has no budget shared across runs.** Each `submit` starts with a fresh budget of
  `limits.maxCostMicros`. For a ceiling across many runs, use a shared `Budget` in one process, or durable budgets
  across processes, from your own code.
- **The default is zero.** A run's default limit is 0 micros, so a paid model is refused until you set one. Free calls
  still count toward `maxModelCalls`, `maxToolCalls` and `maxSteps`, which bound a run even when nothing costs money.
- **Unknown costs hold funds until reconciled.** A budget with many unknown calls can refuse new work although less
  was actually spent. That is the intended failure: it stops and asks, instead of guessing.

## Further reading

- [Costs and budgets](../../../docs/concepts/costs-and-budgets.md): micros, ceilings, tool costs and shared budgets.
- [Model providers](../../../docs/guides/model-providers.md): prices, `maxCostMicros` and reporting costs from an
  adapter.
- [Model routing](../../../docs/guides/model-routing.md): how failover attempts are reserved and charged.
- [Child agents](../../../docs/guides/child-agents.md): one budget, one permission ceiling and one cancellation for a
  tree of agents.
- [Never twice: side effects in durable agent workflows](side-effects-never-twice.md): the same pessimism applied to
  effects instead of money.
