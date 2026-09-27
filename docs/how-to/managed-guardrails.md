# Runtime-managed moderation

This experimental integration lets an ephemeral agent own its configured moderation calls. Select the optional `@mayura/guardrails` package alongside the SDK. A guard definition captures policy and a model, not an account or runtime; Mayura binds it separately to each actual run and required child.

## Define a policy once

```ts
import { defineAgent, createRuntime } from '@mayura/sdk';
import { defineModerationGuard } from '@mayura/guardrails';

const moderation = defineModerationGuard({
  id: 'content-policy',
  version: '1',
  model: moderationModel,
  instructions: 'Apply our documented policy. Return decision and categories.',
  egressGuards: [localDestinationPolicy],
  limits: { timeoutMs: 5000, maxOutputTokens: 256 },
});

const agent = defineAgent({
  ...yourAgentOptions,
  guards: { input: [moderation], output: [moderation] },
});

const runtime = createRuntime({
  profile: 'ephemeral',
  scope: { principalId: 'developer', projectId: 'support' },
  permissions: { allow: ['model:primary', 'model:moderator'] },
  limits: { maxCostMicros: 100000, maxModelCalls: 12 },
});
```

Supply your explicit adapters, schemas and local policy; the snippet does not choose a provider, discover credentials or establish a content policy. Model grants must match the selected adapter IDs. The [credential-free example](../../examples/managed-guardrails.mjs) is executable after `pnpm build`; its deterministic models test the integration, not moderation quality.

`egressGuards` is required. Explicit `[]` means no local destination screening is provided. Each supplied local guard must capture the application's pinned destination policy; Mayura does not infer provider URLs. Input/output agent guards inspect admitted content, not every assembled system instruction or transcript component. A primary model may receive its input before an output-only policy evaluates the generated answer.

## What the runtime owns

- Input: schema admission, required local guards, then the complete managed-check barrier. A denied or unavailable check prevents primary/tool execution.
- Primary calls: atomically reserve the primary call **and** its required final-output checks before generation. A tool proposal cancels that never-used set of final-output tickets.
- Tools: separately reserve the tool's fixed charge and its required result checks before dispatch. Output rejection does not undo a successful effect or erase its succeeded/withheld receipt. A multi-tool proposal is preflighted, but future calls are not all prepaid at once.
- Children and composed workflows: use real ancestor funds, model/tool ceilings and operation permits. A waiting zero-cost wrapper does not occupy an executor slot or charge a child's maximum budget as a fee.

Auxiliary calls consume `maxModelCalls`, including free calls, but not agent reasoning steps. All ancestor consumed **and held** capacities apply. Insufficient required-check capacity denies the prospective operation; competing branches cannot spend its reserved follow-up allowance. See [shared budgets](shared-budgets.md) for the lower-level primitive.

The runtime releases the actual primary/tool executor slot before output checking. Input/output schemas and local egress checks used by managed moderation acquire separate, bounded callback slots through the same operation limiter. One execution slot therefore supports input moderation → primary generation → output moderation. A noncooperative callback retains its slot until it actually settles, even after the returned operation times out. Cancellation is not process isolation.

## Exact verdicts and private content

Moderation models receive one immutable candidate, the selected check's instructions, no tools, no primary transcript and no continuation. The complete request is bounded, including instructions. Defaults are 10 seconds, 64 KiB request/response bounds and 1,024 requested output tokens, further limited by the owning runtime. Instructions are at most 16,384 characters.

The exact result is `{ decision: 'allow' | 'block', categories: string[] }`, with at most 32 unique category IDs matching `[a-z0-9][a-z0-9._-]{0,63}`. Extra fields, tool proposals, continuations, malformed usage, accessor properties and coercing schemas fail closed. This slice does not transform candidates or permit a schema to replace a block verdict with an allow verdict.

Ordinary and managed guards share the 32-guard boundary limit and require unique IDs. The managed definition is frozen and has no `check` or `evaluate` method. Copies, proxies and serialized reconstructions are not registered definitions. Standalone tools and processor pipelines do not support managed definitions in their guard positions; they reject them rather than silently creating an account. Existing `createAuxiliaryCheck` and `createModerationGuard` remain explicitly caller-wired helpers.

Model events identify managed calls with `purpose: 'guardrail'`, bounded model/check/version/call IDs and the input/output boundary. Completed valid verdicts carry only an allow/block decision, not content, category text or protected instructions. The native observer counts both primary and auxiliary model calls. It remains optional process-local telemetry, not durable audit.

## Failure and accounting

Known usage is charged before checking a provider's content envelope. Unknown usage remains reserved. Cancellation or a deadline withholds output and cancels only never-dispatched tickets; independently known late charges still settle once without resurrecting the result. An over-bound charge records the full exact cost and stops further admissions. A reservation is not a provider billing guarantee.

Model moderation can be wrong. These mechanics do not certify compliance, prevent all prompt injection, detect all PII or contain arbitrary application JavaScript. The explicit `/host` integration entries are for trusted runtime authors, not public guard contexts or sandbox gateways. Durable auxiliary execution, retries, language processing and streaming checks require separate qualification. [Required control hooks](lifecycle-hooks.md) can request brokered actions with these output checks, but auxiliary moderation deliberately does not recursively invoke hooks. The full [integration contract](../specs/runtime-managed-guardrails.md) and [status ledger](../development-status.md) define the boundary.

## Redact instead of block

A local guard can rewrite content rather than only allow or block it. Return `{ decision: 'rewrite', value }`, or wrap
a guardrails pipeline with `pipelineGuard`:

```ts
import { createPipeline, pipelineGuard, redactPII } from '@mayura/guardrails';

const redact = pipelineGuard('pii.redact', createPipeline({ processors: [redactPII({ email: true, phone: true })] }));
const agent = defineAgent({ /* ... */ guards: { input: [redact], output: [redact] } });
```

Agent guards run in the order declared, each on the content the previous guard allowed or rewrote. A rewritten agent
input, final output or tool result is validated again against its schema, so a rewrite cannot hand on a value the
boundary would refuse; the model sees a rewritten tool result, never the original. Model-backed (managed) guards and
tool-level guards allow or block only, and treat a rewrite verdict as a block. For streamed output, see
[Stream an agent's answer](streaming.md).
