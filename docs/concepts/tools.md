---
title: "Tools"
description: "Define typed tools with defineTool: schemas, effects, capabilities, cost, timeouts, refusals and batches."
---

A tool is a typed function an agent can ask to run: look up an order, search documents, open a ticket. You define it
once with `defineTool`, give it input and output schemas, and say what kind of effect it has. Every call goes through
the same checks, whether a model asked for it, a workflow step runs it or your own code calls it: the caller must be
allowed to use it, its input is validated before your code runs, and its output is validated before anyone sees it.

## A read-only tool

```ts
import { defineTool } from 'mayura';
import { z } from 'zod';

export const lookupOrder = defineTool({
  id: 'orders.lookup',
  version: '1',
  description: 'Look up one order by id. Returns found=false when there is no such order.',
  input: z.object({ orderId: z.string().min(1).max(64) }),
  output: z.object({
    found: z.boolean(),
    orderId: z.string(),
    status: z.string().nullable(),
  }),
  effects: 'read',
  capabilities: [],
  timeoutMs: 5_000,
  execute: async ({ orderId }, context) => {
    const order = await db.findOrder(orderId, { signal: context.signal });
    if (!order) return { found: false, orderId, status: null };
    return { found: true, orderId, status: order.status };
  },
});
```

To call this tool, a runtime must allow `tool:orders.lookup` and `effect:read`. Add the tool to an agent's `tools`
list to let the model use it.

## Options

| Option | Default | What it is |
| --- | --- | --- |
| `id` | required | Stable name, used in permissions as `tool:<id>`. Starts with a letter; letters, digits, `.`, `_`, `/`, `-`; up to 128 characters. |
| `version` | required | Version of the tool's behavior and schemas, for example `1`. Change it when either changes. |
| `description` | required | What the tool does and returns, written for the model. Up to 4096 characters. |
| `input` | required | Standard Schema validator for the input. `execute` receives the validated value. |
| `output` | required | Standard Schema validator for the result. The result is checked before anyone sees it. |
| `inputJsonSchema` | generated | The input as JSON Schema, which the model reads. Generated from `input` when the validator can describe itself (Zod 4.2 and later); give it otherwise. |
| `effects` | required | `'none'`, `'read'`, `'write'` or `'host'`. |
| `capabilities` | required | Extra permission names a caller must hold, for example `['payments:refund']`. Pass `[]` for none. |
| `costMicros` | `0` | The most one call can cost, in micros (millionths of a dollar). |
| `timeoutMs` | `30000` | How long one call may take before it is stopped. |
| `guards` | none | `{ input, output }` lists of guards that allow or block this tool's input and output. |
| `execute` | required | `(input, context)` returning the output or a promise of it. |

## Input schemas for real models

`input` is what Mayura enforces. The model also needs to know how to call the tool, as JSON Schema: Mayura generates
it from `input` (validators that implement Standard JSON Schema can describe themselves, as Zod 4.2 and later do), and
you can see it as `tool.inputJsonSchema`. Pass `inputJsonSchema` yourself only when your validator cannot describe
itself, or to tell the model something narrower.

Model providers accept only strict schemas: every field present, no extra keys. So for a field the model may leave
empty, use `.nullable()` rather than `.optional()` or `.default()`, and avoid open records (`z.record`). You don't have
to remember this: when you pass the tool to `defineAgent` with a real model, it checks every tool and throws an error
that names the field and the fix, for example:

```text
Agent support: Tool "orders.find" input schema: property "query" is optional, but model providers require every
property. Make it nullable instead (with Zod, .nullable() rather than .optional() or .default()).
```

The scripted test model accepts any schema.

## Effects and capabilities

`effects` says what a call can change, and decides which permission a caller needs:

| Effect | Use it for | Extra permission required |
| --- | --- | --- |
| `none` | Pure computation, no outside state. | none |
| `read` | Reads outside state: databases, APIs, files. | `effect:read` |
| `write` | Changes outside state: sends, updates, payments. | `effect:write` |
| `host` | Runs work on your own infrastructure, such as a nested agent run inside a durable workflow. | `effect:host` |

`capabilities` are names you invent for finer control, such as `payments:refund` or `email:send`. A caller needs
every one of them. See [Permissions](./permissions.md).

The effect also changes what Mayura reports when something goes wrong. If a `none` or `read` tool throws, the call
simply failed: it changed nothing outside, so there is nothing to check (its declared `costMicros` is still charged,
since a paid lookup may have been billed). If a `write` or `host` tool throws or times out after it started, Mayura
cannot know whether the change happened, so the call ends as `outcome_unknown`. See [Outcomes and errors](./outcomes.md).

## The execute context

`execute` receives the validated input and a context:

| Field | What it is |
| --- | --- |
| `runId` | The run this call belongs to. |
| `callId` | The call's id, unique within the run. `runId` plus `callId` makes a good idempotency key. |
| `scope` | `{ principalId, projectId }`: who the run acts for. Use it to scope data access. |
| `signal` | An `AbortSignal` that fires on cancellation or timeout. Pass it to `fetch` and database calls. |
| `reportUsage` | Report the real cost of this call, once: `{ knownCostMicros, unknownCostMicros }`. |

If you never call `reportUsage`, a successful call is charged its full `costMicros`. Reported cost cannot exceed
`costMicros`. Reporting any `unknownCostMicros` makes the call `outcome_unknown`, because the cost is not settled.

## Return "not found", don't throw it

Inside a run, a tool call that does not succeed ends the whole run. And a thrown error from a `write` or `host` tool
is reported as `outcome_unknown`, which asks a person to check what happened. So for ordinary answers the
model should act on, such as "no such order", "not eligible" or "already done", return a structured result and
describe it in the tool's description. The model reads it and continues.

Throw only when something is really broken, and the run should stop.

## Refusing a call: ToolRefusal and withPreflight

Sometimes a tool decides not to act, before it has changed anything: the request is not allowed, or a person
declined it. Throw `ToolRefusal` for that. Mayura records the call as not started, releases its reserved cost, and
reports `failed` with code `TOOL_FAILED` and your reason as the message, never `outcome_unknown`. Only throw it when
nothing happened yet; a refusal after the tool reported usage is not believed.

`withPreflight` wraps an existing tool with a check that runs on the validated input before `execute`. It returns a
tool with the same id; `extraTimeoutMs` lengthens its timeout for checks that wait, and `description` replaces the
description.

```ts
import { ToolRefusal, defineTool, withPreflight } from 'mayura';
import { z } from 'zod';

const refundOrder = defineTool({
  id: 'orders.refund',
  version: '1',
  description: 'Refund a delivered order in full. Safe to repeat: an order is never refunded twice.',
  input: z.object({ orderId: z.string().min(1).max(64) }),
  output: z.object({ status: z.enum(['refunded', 'already_refunded', 'not_found', 'not_eligible']) }),
  effects: 'write',
  capabilities: ['payments:refund'],
  costMicros: 1_000,
  execute: async ({ orderId }, context) => {
    const order = await db.findOrder(orderId, { signal: context.signal });
    if (!order) return { status: 'not_found' as const };
    if (order.status !== 'delivered') return { status: 'not_eligible' as const };
    const result = await payments.refund(orderId, { idempotencyKey: `${context.runId}/${context.callId}` });
    return { status: result.created ? 'refunded' as const : 'already_refunded' as const };
  },
});

export const guardedRefund = withPreflight(refundOrder, async ({ orderId }) => {
  if (await fraud.isFlagged(orderId)) throw new ToolRefusal('Refunds for this order need a manual review.');
});
```

For a person approving each call, see [Approvals and human input](../guides/approvals-and-human-input.md).

## Calling tools without an agent

`invokeTool(tool, input, options)` runs one tool through the same checks, outside any agent. You pass the permissions,
scope, a `Budget` and an `AbortSignal` yourself, and get an outcome back instead of an exception.

`invokeBatch(calls, options)` runs 1 to 128 calls together. Each call has an `id`, a `tool` and an `input`. An input can
refer to an earlier call's result with `batchOutput(callId, path)`, which also makes the call wait for that one.
Mayura checks every permission and every literal input before the first call starts, then runs ready calls in
parallel (4 at a time by default, `concurrency` up to 32).

```ts
import { Budget, batchOutput, invokeBatch } from 'mayura';

const results = await invokeBatch([
  { id: 'customer', tool: findCustomer, input: { email: 'ada@example.com' } },
  { id: 'orders', tool: listOrders, input: { customerId: batchOutput('customer', ['customerId']) } },
], {
  runId: 'nightly-sync',
  scope: { principalId: 'ops', projectId: 'shop' },
  signal: AbortSignal.timeout(30_000),
  permissions: { allow: ['tool:customers.find', 'tool:orders.list', 'effect:read'] },
  budget: new Budget(0, 2),
});
for (const { id, outcome } of results) console.log(id, outcome.status);
```

Results come back in input order. Besides the usual outcomes, a call can be `skipped` (for example because a call it
depends on failed, or `failurePolicy: 'fail-fast'` stopped the batch) or `waiting`. Batches are process-local: they do
not survive a restart and never retry on their own.

## Good to know

- `execute` is ordinary JavaScript in your process. Effects and capabilities control who may call a tool; they do not
  sandbox what it does.
- Tool guards can allow or block, not rewrite. An agent's output guards also see every tool result, and can rewrite it.
- A timeout aborts `context.signal`, but code that ignores the signal keeps running. Always pass the signal on.
- Output is limited to 1 MiB by default (the runtime's `maxOutputBytes`).

## Related

- [Agents](./agent.md)
- [Permissions](./permissions.md)
- [Costs and budgets](./costs-and-budgets.md)
- [Outcomes and errors](./outcomes.md)
- [MCP](../guides/mcp.md)
