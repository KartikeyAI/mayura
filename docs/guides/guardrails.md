---
title: "Guardrails"
description: "Check, redact or block what goes into and comes out of an agent with local guards, processor pipelines and model-backed moderation."
---

A guard is a check that runs on content at an agent's boundaries: on the input before the model sees it, on every tool
result before it goes back to the model, and on the final answer before your application receives it. A guard can
allow the content, block it, or rewrite it (for example to redact an email address). Use guards for policy you want
enforced on every run, whatever the model decides to do.

```ts
import { defineAgent, type Guard } from 'mayura';
import { z } from 'zod';

const noInternalCodes: Guard = {
  id: 'no-internal-codes',
  check: value => JSON.stringify(value).includes('INTERNAL-') ? { decision: 'block' } : { decision: 'allow' },
};

const agent = defineAgent({
  id: 'support.assistant',
  version: '1',
  instructions: 'Answer questions about orders.',
  model,
  tools: [],
  input: z.string(),
  output: z.string(),
  guards: { input: [noInternalCodes], output: [noInternalCodes] },
});
```

When a guard blocks, the run ends with status `blocked` and error code `GUARD_BLOCKED`. When a guard throws, times out
or returns something other than a valid verdict, the run also ends `blocked`, with `GUARD_UNAVAILABLE`. Nothing is
released on a failure: guards fail closed.

## Where guards run

| Position | Checks | Runs |
| --- | --- | --- |
| `guards.input` | The agent's input, after its schema validated it | Once, before the first model call |
| `guards.output` | Every tool result the model would see | After each successful tool call |
| `guards.output` | The final answer, after the output schema validated it | Before the run succeeds |

A blocked tool result is withheld: the model never sees it and the run stops. The tool itself already ran, so any
effect it had (an email sent, a row written) stays done. Put checks that must happen before an effect on the tool
(below) or in a [lifecycle hook](lifecycle-hooks.md).

## Verdicts

A guard is an object with an `id` and a `check(value, context)` function, which may be async. `value` is plain JSON.
`context` carries `runId`, `callId`, `scope`, `boundary` (`'input'` or `'output'`) and an abort `signal`.

| Verdict | Effect |
| --- | --- |
| `{ decision: 'allow' }` | The content passes unchanged. |
| `{ decision: 'block' }` | The run ends `blocked`. An optional `reason` is not shown to callers. |
| `{ decision: 'rewrite', value }` | `value` replaces the content. |

Guards in one list run in the order you declare them, each on the content the previous one allowed or rewrote. A
rewritten value is validated again against the same schema (the agent's input or output schema, or the tool's output
schema), so a rewrite can never hand on a value the boundary would refuse. The model sees the rewritten tool result,
never the original. Each boundary accepts up to 32 guards with unique ids.

## Tool guards

Tools accept guards too. They run in the tool broker around that one tool, and they only allow or block:

```ts
import { defineTool } from 'mayura';
import { z } from 'zod';

const refund = defineTool({
  id: 'orders.refund', version: '1', description: 'Refund an order.',
  input: z.object({ orderId: z.string(), cents: z.number().int().positive() }),
  output: z.object({ refundId: z.string() }),
  effects: 'write', capabilities: ['orders:refund'],
  guards: { input: [{ id: 'refund-cap', check: value => {
    const cents = (value as { cents?: number }).cents ?? 0;
    return { decision: cents <= 50_000 ? 'allow' : 'block' };
  } }] },
  execute: async ({ orderId }) => ({ refundId: `refund-${orderId}` }),
});
```

A tool input guard runs after the input schema and before `execute`, so a block prevents the effect.

## Processors and pipelines

`mayura/guardrails` builds reusable content pipelines. A pipeline runs ordered **processors**, which transform the
content, then all of its **guards** in parallel on the final result. It returns an outcome, and only a successful
outcome carries the processed content.

```ts
import { createPipeline, normalizeUserMessage, protectLiterals, redactPII } from 'mayura/guardrails';

const pipeline = createPipeline({
  processors: [normalizeUserMessage(), redactPII({ email: true, phone: true })],
  guards: [protectLiterals({ literals: ['BEGIN INTERNAL POLICY'] })],
  timeoutMs: 2_000,
});

const outcome = await pipeline.process(untrustedMessage, {
  runId: 'run-1', callId: 'message-1', boundary: 'input',
  scope: { principalId: 'customer-42', projectId: 'support' }, signal: AbortSignal.timeout(5_000),
});
if (outcome.status === 'succeeded') {
  // Use outcome.output.value, never the original message.
}
```

| Helper | What it does |
| --- | --- |
| `normalizeUserMessage()` | Turns a string or a `{ content }` envelope into `{ role: 'user', content }`, discarding any role or tool fields a client supplied. |
| `redactPII({ email, phone })` | Replaces email addresses (on by default) and phone numbers (off by default) in every string with fixed labels such as `[EMAIL]`. |
| `protectLiterals({ literals })` | A guard that blocks when any configured string appears in a value or key. Optionally case-insensitive. |

Pipelines take up to 32 processors and 32 guards, a `timeoutMs` (default 5 seconds) and a `maxBytes` (default 1 MiB).
An `onBlocked` callback receives metadata about a block, never the content. A processor is any object with an `id`, a
`version` and `process(snapshot, context)`, which returns the new JSON value from `snapshot.value`.

To use a pipeline as an agent guard, wrap it with `pipelineGuard`. It blocks when the pipeline blocks, rewrites when a
processor changed the content, and allows otherwise:

```ts
import { createPipeline, pipelineGuard, redactPII } from 'mayura/guardrails';

const redact = pipelineGuard('pii.redact', createPipeline({ processors: [redactPII({ email: true, phone: true })] }));
// Pass it to an agent: guards: { input: [redact], output: [redact] }
```

## Personal data

`redactPII` is a heuristic safety net, not complete PII detection or a compliance guarantee. It can miss unusual
formats and can flag long digit strings that are not phone numbers. The
[support-agent starter](https://github.com/KartikeyAI/mayura/blob/main/packages/cli/starters/support-agent/src/guardrails.ts)
shows a sturdier setup:

1. A custom processor redacts payment card numbers (checked with the Luhn algorithm), then `redactPII` handles emails
   and phone numbers.
2. The agent's input and output schemas run that pipeline, so the model, memory and the reply never hold the raw values.
3. An output guard re-runs the redaction on every tool result and the final answer and blocks if anything would still
   change, as a backstop.

## Model-backed moderation

`defineModerationGuard` creates a guard that asks a model for a verdict. The agent's runtime makes the call, charges it
to the run's budget, and counts it against `maxModelCalls`.

```ts
import { createRuntime, defineAgent } from 'mayura';
import { defineModerationGuard } from 'mayura/guardrails';

const moderation = defineModerationGuard({
  id: 'content-policy',
  version: '1',
  model: moderationModel,
  instructions: 'Apply our content policy. Return a decision and the categories that apply.',
  egressGuards: [],
  limits: { timeoutMs: 5_000, maxOutputTokens: 256 },
});

const agent = defineAgent({ ...options, guards: { input: [moderation], output: [moderation] } });

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: [`model:${primaryModel.id}`, `model:${moderationModel.id}`] },
  limits: { maxCostMicros: 100_000, maxModelCalls: 12 },
});
```

- The moderation model receives the one piece of content, your instructions, no tools and no conversation. It must
  answer exactly `{ decision: 'allow' | 'block', categories: string[] }`; anything else counts as unavailable and
  blocks.
- The runtime needs `model:<id>` for the moderation model, and the run cost limit must cover the moderation calls. The
  runtime reserves the cost of the output checks before each model or tool call, so a run cannot start work it cannot
  afford to check.
- `egressGuards` is required. List local guards that must allow the content before it is sent to the moderation
  provider, or pass `[]` explicitly to send without that check.
- Default limits: 10 seconds, 64 KiB in and out, 1,024 output tokens.
- Moderation guards run after the local guards at the same boundary. They allow or block; they never rewrite.

For moderation outside an agent run, `createModerationGuard`, `createAuxiliaryCheck` and `detectAndTranslate` take an
explicit model, `Budget` and permissions, and you call them yourself.

## Streaming

When an agent streams its answer, each batch of text passes the local guards in `stream.guards` before it is
released. Text already released cannot be taken back, and the complete answer still passes `guards.output` before the
run succeeds. See [streaming](streaming.md).

## Good to know

- Guards are your code running in your process. They are not a sandbox, and a guard can do anything your code can.
- Nothing here detects prompt injection in general. `protectLiterals` matches exact strings; moderation models can be
  wrong. Keep tool permissions narrow so a manipulated model cannot do much.
- Input guards see the agent's input, not its instructions or the full prompt. To inspect each model request, use a
  `beforeModelCall` [lifecycle hook](lifecycle-hooks.md).
- Guard evidence and block callbacks never include the content or the guard's reason, so logs do not leak what was
  blocked.

## Related

- [Lifecycle hooks](lifecycle-hooks.md)
- [Streaming](streaming.md)
- [Agents](../concepts/agent.md)
- [Outcomes](../concepts/outcomes.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
