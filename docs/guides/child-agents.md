---
title: "Child agents"
description: "Let one agent call another as a tool, spawn child runs from your code, or race speculative branches, under one shared budget."
---

A child agent is an agent that runs on behalf of another run: a summarizer the assistant calls, a researcher a
coordinator hands a topic to. Use child agents to split work between specialists with their own instructions, tools
and output schemas, while one budget, one permission ceiling and one cancellation cover the whole tree.

There are three ways to start one:

- **`agentAsTool`**: the parent's model decides when to call the child, like any other tool.
- **`runtime.spawn`**: your code starts a child of a running parent.
- **`runtime.speculate`**: your code runs a few alternative children and keeps at most one verified answer.

```ts
import { agentAsTool, createRuntime, defineAgent, type JsonObject } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const openai = (outputJsonSchema: JsonObject) => openAIResponses({
  apiKey: process.env.OPENAI_API_KEY!, model: process.env.OPENAI_MODEL!, outputJsonSchema,
  maxCostMicros: 20_000, pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000 },
});

const SummaryInput = z.object({ text: z.string() });
const Summary = z.object({ summary: z.string() });
const summarizer = defineAgent({
  id: 'summarizer', version: '1', instructions: 'Summarize the text in two sentences.',
  model: openai(jsonSchema(Summary)), tools: [], input: SummaryInput, output: Summary,
});

const summarize = agentAsTool(summarizer, {
  id: 'text.summarize',
  description: 'Summarize a long text in two sentences.',
  inputJsonSchema: jsonSchema(SummaryInput), // providers need every tool's JSON Schema
  permissions: { allow: ['model:openai.responses'] },
  limits: { maxCostMicros: 40_000 },
});

const Reply = z.object({ reply: z.string() });
const assistant = defineAgent({
  id: 'assistant', version: '1', instructions: 'Help the user. Summarize long documents before answering.',
  model: openai(jsonSchema(Reply)), tools: [summarize], input: z.object({ message: z.string() }), output: Reply,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'agent:delegate', 'tool:text.summarize'] },
  limits: { maxCostMicros: 200_000 },
});
```

`jsonSchema` is the Zod-to-JSON-Schema helper from [Model providers](model-providers.md).

## Agents as tools

`agentAsTool(agent, options)` returns a tool that runs `agent` as a child and returns its validated output. The parent's
model sees an ordinary tool; the child's output is the tool result.

| Option | Meaning |
|---|---|
| `id`, `description` | The tool's id and the description the parent's model reads. |
| `permissions` | Required. What the child may do: `{ allow: [...] }`. |
| `limits` | Optional ceilings for the child, such as `maxCostMicros`. |
| `inputJsonSchema` | The child input's JSON Schema. Required with real model providers. |

The runtime must grant `agent:delegate` (to start children at all), `tool:<id>` (to call this tool) and everything the
child itself needs. If the child fails, the tool call fails and the parent run ends with the child's failure.

## Spawning from your code

`runtime.spawn(parentRun, agent, options)` starts a child of a run that is still in progress:

```ts
const parentRun = runtime.submit(coordinator, { input: { goal: 'Plan the launch' } });
const childRun = runtime.spawn(parentRun, researcher, {
  input: { topic: 'competitor pricing' },
  permissions: { allow: ['model:openai.responses', 'tool:web.search'] },
  limits: { maxCostMicros: 50_000 },
});
const research = await childRun.result();
```

The parent run must come from the same runtime, be still running, and hold `agent:delegate`. Spawning after the parent
finished throws `CONFLICT`. Every accepted child is required: the parent's result waits for its children, and a failed
child fails the parent.

Do not call `spawn` and wait for the child inside a tool's `execute`; that tool holds an execution slot while it waits.
Use `agentAsTool` for model-driven nesting.

## Shared authority, budgets and cancellation

Children never get more than their parent:

- **Permissions** are intersected: a child gets only the grants that are both in its `permissions` and in its
  parent's. Listing a grant the parent lacks does not add it.
- **Limits** are ceilings, not extra money. A child's `limits` default to the parent's and may only be lower; asking
  for more throws `INVALID_CONFIG`. A child's spending comes out of the parent's budget, so a child with
  `maxCostMicros: 40_000` can spend at most 40,000 of the parent's remaining funds.
- **Call counts are shared.** Model and tool calls count against every ancestor's `maxModelCalls` and `maxToolCalls`,
  so children cannot multiply the number of calls.
- **Cancellation and deadlines flow down.** Cancelling a parent cancels all its descendants; a child's deadline is
  never later than its parent's. Cancelling one child does not cancel its siblings.
- **The tree has size limits.** `limits.maxDepth` (default 8, at most 32) and `limits.maxDescendantRuns` (default 64, at most
  1,023) cap nesting and the number of children. An agent cannot appear twice in its own ancestry: a child with the
  same agent id as one of its ancestors is refused.

A child sees only its own input, instructions and tools. It does not inherit the parent's conversation, memory or
provider state, and the parent's model sees only the child's validated output.

`runtime.inspect(run)` returns the run tree with statuses and the shared budget. The budget of a parent already
includes its children; do not add them up again.

```ts
const view = runtime.inspect(parentRun);
console.log(view.runs.map(entry => `${entry.agentId}: ${entry.status}`), view.budget.spentMicros);
```

## Speculative branches

`runtime.speculate(parentRun, options)` starts 1 to 8 alternative children at once, for example a fast and a thorough
planner, and promotes at most one answer. Each successful branch is passed to your `verify` function as it finishes;
the first for which `verify` returns exactly `true` wins, and the others are cancelled.

```ts
const result = await runtime.speculate(parentRun, {
  branches: [
    { id: 'quick', agent: quickPlanner, input: request, permissions: { allow: ['model:openai.responses'] },
      assumptions: { inventoryVersion: 41 } },
    { id: 'thorough', agent: carefulPlanner, input: request, permissions: { allow: ['model:openai.responses'] },
      assumptions: { inventoryVersion: 41 } },
  ],
  verify: async ({ branchId, output }) => await stillValid(branchId, output),
  verifyTimeoutMs: 5_000,
});
if (result.status === 'promoted') console.log(result.branchId, result.output);
```

- Branches run under the parent's shared budget, and a failed or losing branch never fails the parent.
- Branches may not hold write or host effects, `agent:delegate`, or memory grants other than `memory:read`. A branch
  asking for one is refused before any branch starts. Speculation is for work that is safe to throw away.
- `verify` should re-check that the branch's answer still holds (inputs, policy, the state it assumed). A thrown error,
  a timeout (`verifyTimeoutMs`, default 5,000, at most 30,000) or any value other than `true` counts as a rejection.
- `assumptions` is JSON describing what the branch depends on. Its SHA-256 digest is passed to `verify` and reported
  in `result.branches`, along with each branch's run id, status and whether it was verified.
- `result.status` is `'none'` when no branch was verified.

## Good to know

- Child runs live in the runtime's process. For children that survive restarts, use workflows; see
  [Workflow composition](workflow-composition.md).
- Cancellation stops new work but cannot undo an external write. A child with an uncertain write makes the parent's
  outcome `outcome_unknown`; see [Outcomes](../concepts/outcomes.md).

## Related

- [Agents](../concepts/agent.md)
- [Permissions](../concepts/permissions.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
- [Workflow composition](workflow-composition.md)
- [Testing](testing.md)
