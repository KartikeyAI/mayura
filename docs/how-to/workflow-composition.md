# Compose an ephemeral workflow

Use `workflowAsAgent` for a finite deterministic graph, or `workflowAsTool` to run that graph as a required child of an existing agent. Both reuse the ordinary runtime's permissions, guards, budget, cancellation, and execution evidence. They do not create a second runtime or a new spending allowance.

This is an experimental, process-local profile. It does not provide persistence, approval waits, retries, leases, or recovery after process termination. Approval-required definitions are rejected: use the durable workflow driver for that separate execution profile.

## Run the credential-free example

From this source checkout, with dependencies installed:

```sh
pnpm build
node examples/workflow-composition.mjs
```

The [complete example](../../examples/workflow-composition.mjs) normalizes a string and counts its Unicode code points in a required child workflow. It needs no provider credentials, database, Docker, paid API, or external connection. Expected output:

```json
{"result":{"text":"Mayura framework","characters":16},"runs":2,"budget":{"spentMicros":0,"reservedMicros":0,"calls":8}}
```

Packages in this checkout remain private development artifacts; this guide does not imply a published or production-qualified release. The workflows package depends on core, tools, runtime, and the driver-free storage contracts package. This ephemeral path neither installs database drivers through those production dependencies nor opens a store. Applications using the separate durable API must supply a store implementation explicitly.

## Define and submit a graph

Import `defineWorkflow` from `@mayura/workflows`, and the explicit profile from `@mayura/workflows/ephemeral`:

```ts
import { defineWorkflow } from '@mayura/workflows';
import { workflowAsAgent } from '@mayura/workflows/ephemeral';

const graph = defineWorkflow({
  id: 'normalize-text',
  version: '1',
  input: textSchema,
  output: textSchema,
  nodes: [{
    kind: 'tool',
    id: 'normalize',
    tool: normalizeTool,
    input: { kind: 'input', path: [] },
  }],
  result: { kind: 'step', stepId: 'normalize', path: [] },
});

const agent = workflowAsAgent(graph, { profile: 'ephemeral' });
const run = runtime.submit(agent, { input: '  Mayura  ' });
const outcome = await run.result();
```

The schemas, registered tool, and runtime are application-supplied objects; see the complete example for their definitions. Standard Schema input/output inference and transformations remain intact. Schema validators must be pure because the broker also performs preflight validation. A compiled definition can be reused across concurrent runs; it captures no mutable per-run completion state.

Bindings can select the admitted workflow input (`kind: input`), a declared dependency's released result (`kind: step`), or a JSON literal (`kind: literal`). A path is an array of property names; use `[]` for the complete value. A step input must name that step in `dependsOn`. Join nodes produce arrays of dependency results in the declared dependency order. All graph nodes are required, even if the final result binding references only one node.

## Explicit authority and cost

The default deterministic planner requires `model:mayura.workflow`; a custom `plannerId` requires its exact `model:<id>` grant. This name is a protocol permission, not evidence of an LLM invocation. Planning performs no inference or network call and reports zero monetary usage, but each scheduling wave and finalization consumes a visible model-call/step allowance.

Ordinary nodes require `tool:<id>`, any declared effect grant, and every declared capability. The tool form additionally requires `tool:<wrapper-id>` and `agent:delegate`. Its configured child permissions are intersected with parent permissions: a child cannot regain authority absent from either side.

```ts
import { workflowAsTool } from '@mayura/workflows/ephemeral';

const childTool = workflowAsTool(graph, {
  profile: 'ephemeral',
  id: 'workflow.normalize',
  description: 'Run the normalization graph as a required child.',
  permissions: {
    allow: ['model:mayura.workflow', 'tool:text.normalize'],
  },
  limits: { maxCostMicros: 0 },
});
```

Register `childTool` in an ordinary parent agent, or use it as a tool node in another workflow. The owning runtime provides the private child-execution capability; standalone tool invocation cannot create a new root execution. Child costs and calls count against ancestor limits. Parent and child monetary snapshots must not be added together because the parent's ledger already includes descendants.

## Failure and execution evidence

Check `outcome.status` before reading output. Failed, blocked, cancelled, or uncertain required children prevent parent success. Earlier effects may still have happened: `runtime.inspect(run).evidence` retains run-qualified receipts, including successful execution whose output was withheld and execution that remains unknown. Cancelling cannot undo an effect or hard-kill trusted JavaScript. A late successful handler may update inspection evidence after a terminal cancellation outcome; do not automatically replay uncertain writes.

Workflow input/output guards use the ordinary agent boundaries. Tool guards apply at the ordinary broker boundaries. Later graph nodes consume only released tool results. A denied final output is never made available as a successful parent output.

## Capacity and limits

The graph is finite and capped at 128 nodes. A 128-tool chain can require 129 planner calls. Defaults are not silently raised to fit a graph: choose explicit step, model-call, tool-call, context, byte, duration, descendant, and cost limits for the application. Ready nodes are planned in definition order; the current runtime executes the tools in a wave sequentially. A wave is not a claim of parallel workflow execution.

For the complete contract and limitations, see [ephemeral workflow composition](../specs/ephemeral-workflow-composition.md).
