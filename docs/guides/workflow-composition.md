---
title: "Workflow composition"
description: "Run a fixed graph of tool calls in-process as an agent, or hand it to another agent as a single tool."
---

Sometimes you know exactly which tools to call and in what order, and you want that sequence packaged as one unit:
something you can submit like an agent, or give to another agent as a single tool. `mayura/workflows/ephemeral` does
this. It turns a workflow graph into an ordinary agent that runs inside your existing [runtime](../concepts/runtime.md),
under that runtime's permissions, limits, guards and budget.

Nothing is stored. If the process stops, the run is gone, and there are no approvals, human requests or timers. When
the steps must survive a restart or wait for a person, use a [durable workflow](durable-workflows.md) instead.

## A complete example

This graph trims a piece of text and then counts its characters. It needs no model and no credentials.

```ts
import { createRuntime, defineTool } from 'mayura';
import { defineWorkflow } from 'mayura/workflows';
import { workflowAsAgent } from 'mayura/workflows/ephemeral';
import { z } from 'zod';

const text = z.string();
const summary = z.object({ text: z.string(), characters: z.number().int() });

const normalize = defineTool({
  id: 'text.normalize', version: '1', description: 'Trim and collapse whitespace.',
  input: text, output: text, effects: 'none', capabilities: [],
  execute: value => value.trim().replace(/\s+/gu, ' '),
});
const describe = defineTool({
  id: 'text.describe', version: '1', description: 'Count the characters of a text.',
  input: text, output: summary, effects: 'none', capabilities: [],
  execute: value => ({ text: value, characters: [...value].length }),
});

const textSummary = defineWorkflow({
  id: 'text-summary',
  version: '1',
  input: text,
  output: summary,
  nodes: [
    { kind: 'tool', id: 'normalize', tool: normalize, input: { kind: 'input', path: [] } },
    { kind: 'tool', id: 'describe', tool: describe, dependsOn: ['normalize'], input: { kind: 'step', stepId: 'normalize', path: [] } },
  ],
  result: { kind: 'step', stepId: 'describe', path: [] },
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:mayura.workflow', 'tool:text.normalize', 'tool:text.describe'] },
  limits: { maxCostMicros: 0 },
});

try {
  const run = runtime.submit(workflowAsAgent(textSummary, { profile: 'ephemeral' }), { input: '  Hello   Mayura  ' });
  const outcome = await run.result();
  if (outcome.status === 'succeeded') console.log(outcome.output); // { text: 'Hello Mayura', characters: 12 }
} finally {
  await runtime.close();
}
```

`defineWorkflow` (from `mayura/workflows`) declares the graph: tool and join nodes, bindings and a result, the same
building blocks described in [Workflows](../concepts/workflows.md). `workflowAsAgent` turns it into an agent whose
"model" is a small local planner that reads the graph and asks for the next ready tools. The planner is plain code: it
makes no network call and costs nothing.

## Permissions

The workflow agent needs the same explicit grants as any agent:

- `model:mayura.workflow` for the planner. If you set `plannerId`, grant `model:<plannerId>` instead.
- For each tool step: `tool:<id>`, each capability the tool declares, and `effect:<kind>` for a tool with effects.

A tool the runtime does not allow fails the run, exactly as it would for a model-driven agent. See
[Permissions](../concepts/permissions.md).

## Use a workflow as a tool

`workflowAsTool` wraps the graph as a tool, so an agent (or another workflow) can call it as one step. It runs as a
required child run of the caller, the same way [child agents](child-agents.md) do.

```ts
import { defineAgent } from 'mayura';
import { workflowAsTool } from 'mayura/workflows/ephemeral';

const summarizeText = workflowAsTool(textSummary, {
  profile: 'ephemeral',
  id: 'workflow.text-summary',
  description: 'Normalize a text and count its characters.',
  // What the child may do. It is intersected with the parent's grants: a child never gains authority.
  permissions: { allow: ['model:mayura.workflow', 'tool:text.normalize', 'tool:text.describe'] },
  limits: { maxCostMicros: 0 },
});

const editor = defineAgent({
  id: 'editor', version: '1', instructions: 'Tidy the text the user sends, then report its length.',
  input: text, output: summary, model, tools: [summarizeText],
});
```

The parent runtime must grant `tool:workflow.text-summary` and `agent:delegate`, plus everything in the child's list.
The child's cost and calls count against the parent's limits; the parent's budget already includes them, so do not add
the two together.

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `profile` | both | Must be `'ephemeral'`. It is required so the choice of an in-process run is explicit. |
| `plannerId` | both | Model id of the planner. Default `mayura.workflow`. |
| `guards` | both | Input and output guards for the workflow agent, as for any agent. |
| `id`, `description` | `workflowAsTool` | The tool's identity, shown to the calling model. |
| `permissions` | `workflowAsTool` | Grants for the child run. Required. |
| `limits` | `workflowAsTool` | Runtime limits for the child run. |

## How it runs

- Each wave of ready steps uses one model call and one step from the runtime's limits, and the final answer uses one
  more. The default `maxSteps` is 16, so a long chain needs a higher limit. Defaults are never raised for you.
- Steps that are ready together are requested together, but the runtime runs them one after another.
- Later steps only see results that passed the tools' output guards. A failed, blocked or cancelled tool ends the run.
- A compiled workflow holds no per-run state, so you can submit it many times at once.

Always check `outcome.status` before reading the output. A run that failed part-way may still have caused effects in
earlier steps; `runtime.inspect(run)` lists what executed. Cancelling does not undo an effect.

## Good to know

- A graph with an `approval: true` step is refused. Approvals need a durable workflow.
- The graph has at most 128 nodes and no cycles. For data-dependent branching, let an agent decide.
- The same `defineWorkflow` graph can also run durably through the earlier runtimes in `mayura/workflows`, but new
  durable work should use `defineWorkflowLifecycle`; see [Durable workflows](durable-workflows.md).

## Related

- [Workflows](../concepts/workflows.md)
- [Child agents](child-agents.md)
- [Durable workflows](durable-workflows.md)
- [Runtime](../concepts/runtime.md)
