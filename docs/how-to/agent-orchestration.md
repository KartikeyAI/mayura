# Run a required child agent

Mayura's experimental in-process runtime supports required children through direct spawning or agents exposed as tools. Both paths share ancestor permissions, accounting, deadlines and cancellation. This is not durable orchestration.

## Run the credential-free example

From an installed development checkout:

```sh
pnpm build
node examples/agent-orchestration.mjs
```

The [complete example](../../examples/agent-orchestration.mjs) imports only `@mayura/sdk` and `@mayura/testing`. Its Standard Schema validators transform text into a length and transform the child's answer into an object. No model account, paid call, database, Docker service or additional validator dependency is needed.

Expected output:

```json
{"result":{"length":6},"runs":2,"budget":{"spentMicros":0,"reservedMicros":0,"calls":4}}
```

Four attempts are counted: two parent model calls, one child model call and one zero-cost composition-tool call. The example completes with one execution slot because a composition wrapper waiting for its child does not occupy that slot. Scripted models are consumable deterministic test fixtures, not language models or evidence of reasoning quality; create fresh fixtures for another run.

## Expose an agent as a tool

Given your existing `child` definition:

```ts
const childTool = agentAsTool(child, {
  id: "text.length",
  description: "Count text characters in a required child run.",
  permissions: { allow: ["model:scripted"] },
  limits: { maxCostMicros: 0 },
});
```

Register `childTool` in the parent's tools. The runtime needs `agent:delegate`, `tool:text.length` and the parent's model grant. The child's explicit grants are intersected with its parent's; registering the child never adds authority. The wrapper returns the child's admitted output, not a handle or transcript. Its schema remains fixed, including transformed output types. For a real provider, also supply the portable `inputJsonSchema` required by that adapter.

## Spawn from trusted application code

Use the exact live handle from the same runtime, and submit children before the parent closes admission:

```ts
const parentRun = runtime.submit(parent, { input: parentInput });
const childRun = runtime.spawn(parentRun, child, {
  input: childInput,
  permissions: { allow: ["model:scripted"] },
});
const result = await childRun.result();
const inspection = runtime.inspect(parentRun);
```

All accepted children are required: parent success waits for them. Calling `spawn` and waiting inside an ordinary model or tool callback is unsupported because that callback owns an execution slot; use `agentAsTool` for model-driven nested work. Standalone `invokeTool` cannot execute a composed agent without its private runtime gateway.

## Interpret limits and outcomes

- Child cost limits are ceilings over shared funds, not additional credit or prepaid allocations. Ancestor totals include descendants; do not add parent and child totals together.
- Explicit child limit widening is rejected. Operation concurrency, depth, descendant counts and model/tool attempts remain bounded across the relevant ancestors.
- Cancellation stops new dispatch but cannot kill arbitrary trusted JavaScript or undo an external write. Unknown charges remain reserved.
- `outcome_unknown` requires reconciliation. Successful writes remain recorded even if their output is blocked. Inspect bounded lineage and execution evidence before deciding whether to retry.
- Late completion can update inspection and known accounting without changing an already-returned result or releasing late output.
- Inspection is process-local metadata, not a durable audit log; prompts, transcripts and provider continuation are not included.

See the [orchestration contract](../specs/agent-orchestration.md) for supported boundaries. Real providers require explicit credentials, supported schemas and configured costs; the zero-cost fixture configuration is not a paid-model recipe.
