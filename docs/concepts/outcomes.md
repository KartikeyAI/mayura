---
title: "Outcomes and errors"
description: "Every run ends with one outcome: succeeded, failed, blocked, cancelled or outcome_unknown. What each means and what to do."
---

Every run ends with exactly one outcome. `run.result()` resolves to it and does not throw when a run fails, so you
handle success and failure with one `switch`. Only a successful outcome has an `output`; every other outcome has an
`error` with a stable `code` and a safe `message`. One status needs special care: `outcome_unknown` means Mayura cannot
tell whether an external change happened, and you must check before retrying.

## Handle an outcome

```ts
const run = runtime.submit(agent, { input: { message: 'Cancel my order A-1001' } });
const outcome = await run.result();

switch (outcome.status) {
  case 'succeeded':
    console.log(outcome.output);
    break;
  case 'blocked':
  case 'failed':
  case 'cancelled':
    console.warn(outcome.status, outcome.error.code, outcome.error.message);
    break;
  case 'outcome_unknown':
    // A change may or may not have happened. Check the other system before doing anything again.
    await flagForReview(run.id, runtime.inspect(run).evidence);
    break;
}
```

## Statuses

| Status | Meaning | What to do |
| --- | --- | --- |
| `succeeded` | The run finished, and its output passed its schema and every output guard. | Use `outcome.output`. |
| `failed` | Something went wrong: invalid data, a model or tool error, a limit or a timeout. Nothing uncertain happened outside. | Read `error.code`. Fix the cause, or retry if the cause was temporary. |
| `blocked` | The run was stopped on purpose: a missing permission, the budget, or a guard or hook said no. | Don't retry as is. Grant the permission, raise the budget, or accept the refusal. |
| `cancelled` | You, `runtime.close()` or a parent run cancelled it. | Nothing, unless you want to submit again. |
| `outcome_unknown` | An external change may have happened, and Mayura cannot confirm it did or did not. | Reconcile before retrying (see below). |

Codes and statuses go together like this:

- `blocked`: `PERMISSION_DENIED`, `BUDGET_EXCEEDED`, `GUARD_BLOCKED`, `GUARD_UNAVAILABLE`.
- `cancelled`: `CANCELLED`.
- `outcome_unknown`: `OUTCOME_UNKNOWN`.
- `failed`: everything else, for example `INVALID_INPUT`, `INVALID_OUTPUT`, `MODEL_FAILED`, `TOOL_FAILED`,
  `LIMIT_EXCEEDED`, `TIMEOUT` and `NOT_FOUND`.

A parent run takes on a child run's result when it is worse: if any child is `outcome_unknown`, so is the parent.

You will meet a few other statuses elsewhere. `runtime.inspect()` reports `running` for a run in progress. A call in a
[tool batch](./tools.md) can be `skipped` or `waiting`. Workflows have statuses of their own, described in
[Workflows](./workflows.md).

## Errors

All public errors are `MayuraError` instances with a `code` and a `message`. `toJSON()` returns just those two fields,
so they are safe to log and send to a client.

Errors reach you in two ways:

- **Thrown** when you misuse the API: an invalid definition, an invalid runtime option, or a run that cannot start.
  These are mistakes to fix in code.
- **Returned** in the outcome for everything that happens during a run.

```ts
import { MayuraError, createRuntime } from 'mayura';

try {
  createRuntime({ profile: 'ephemeral', limits: { maxSteps: 0 } });
} catch (error) {
  if (error instanceof MayuraError) console.error(error.code); // INVALID_CONFIG
  else throw error;
}
```

Messages never contain the text of an exception your tool or a provider threw, or anything a guard saw. A tool that
throws `new Error('db password rejected')` is reported as `TOOL_FAILED` with a generic message. Log details inside
your tool if you need them. The one exception is `ToolRefusal`, whose reason you wrote on purpose.

## Error codes

| Code | Meaning |
| --- | --- |
| `INVALID_CONFIG` | A definition, option or limit is invalid. Usually thrown when you define or create something. |
| `INVALID_INPUT` | Input did not match its schema or size limit: the run's input, or a tool's input from the model. |
| `INVALID_OUTPUT` | The model's final answer or a tool's result did not match its schema. |
| `INVALID_JSON` | A value is not plain JSON, or is too large or too deeply nested. |
| `PERMISSION_DENIED` | The model, tool, effect or capability was not allowed. |
| `BUDGET_EXCEEDED` | A call did not fit in the cost budget, or reported more than its ceiling. |
| `LIMIT_EXCEEDED` | A count or size limit was reached: steps, calls, depth, concurrent runs. |
| `CANCELLED` | The work was cancelled. |
| `TIMEOUT` | A deadline passed: the run's `maxDurationMs` or a tool's `timeoutMs`. |
| `TOOL_FAILED` | A tool threw (for a tool with `effects: 'none'`), refused with `ToolRefusal`, or a child agent did not succeed. |
| `MODEL_FAILED` | The model call failed. The message says why: refused credentials, a rate limit, the provider unavailable or too slow, a rejected request, a refusal, or an unusable answer. See [Model providers](../guides/model-providers.md). |
| `GUARD_BLOCKED` | A guard or hook blocked the content or the action. |
| `GUARD_UNAVAILABLE` | A guard or required hook could not decide, for example because it threw or timed out. |
| `OUTCOME_UNKNOWN` | An external effect may have happened and could not be confirmed. |
| `UNSUPPORTED_PROFILE` | `createRuntime` was given a profile other than `ephemeral`. |
| `NOT_FOUND` | Something requested does not exist, for example a tool the model asked for that the agent does not have. |
| `CONFLICT` | The request conflicts with current state: a closed runtime, a reused id, a record changed meanwhile. |
| `STORAGE_UNAVAILABLE` | Storage could not be reached. |
| `INTEGRITY_VIOLATION` | Stored or packaged data failed an integrity check. |

Storage adapters report their own failures as `StorageError`, a `MayuraError` whose `code` is one of the codes above
and whose `storageCode` names the exact storage condition, such as `STORE_CLOSED`. See
[Storage](../guides/storage.md#errors).

## Retries

Mayura never retries a run or a tool call by itself. Whether a retry is safe depends on the error:

- `failed` with `MODEL_FAILED` for a rate limit, an unavailable provider or a timeout, or with `TIMEOUT`, is usually
  temporary: submit the run again. Refused credentials or a rejected request repeat until you fix the configuration.
  `BUDGET_EXCEEDED` messages give the call's cost and what the budget had left. To fail over between model
  providers inside one run, use a model router; see [Model routing](../guides/model-routing.md).
- `failed` with `INVALID_OUTPUT` means the model answered in the wrong shape. A retry may work; if it keeps
  happening, tighten the instructions or the provider's output schema.
- `blocked` repeats until you change something: a permission, the budget, or the content a guard blocked.
- `outcome_unknown` must not be retried blindly.

For retrying your own operations inside a tool, `retry` from `mayura/helpers` asks you to state that the operation is
`idempotent` or `read-only` before it allows more than one attempt. See [Helpers](../guides/helpers.md).

## Reconciling outcome_unknown

`outcome_unknown` means a tool that changes things outside (`effects` of `write` or `host`) started, and then
something went wrong before Mayura got a clear answer: the tool threw, timed out, was cancelled mid-call, or reported
a cost it could not settle. The payment may have been taken, or not. The email may have been sent, or not.

Retrying could do the change twice, so Mayura stops and tells you. To resolve it:

1. Find the call. `runtime.inspect(run).evidence` lists each tool call with its run id, call id, tool id and whether
   it ran: `not_started`, `succeeded`, `failed` or `unknown`.
2. Check the other system. If your tool used `runId` and `callId` as an idempotency key, look the operation up by
   that key.
3. Act on what you find: continue if it happened, submit again if it did not.

You can make this rare. Return structured results for ordinary answers instead of throwing, throw `ToolRefusal` when
nothing happened yet, and make write tools idempotent so a repeat is harmless. See [Tools](./tools.md).

The in-memory runtime loses its evidence when the process exits. Durable workflows store each call's record before
and after it runs, so an interrupted call can be found and reconciled after a restart. See
[Durable workflows](../guides/durable-workflows.md) and [Workflow operations](../guides/workflow-operations.md).

## Related

- [Runtime](./runtime.md)
- [Tools](./tools.md)
- [Permissions](./permissions.md)
- [Costs and budgets](./costs-and-budgets.md)
- [Guardrails](../guides/guardrails.md)
