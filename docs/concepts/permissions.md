---
title: "Permissions"
description: "Explicit allow-lists decide which models, tools, effects and capabilities a run may use. Nothing is allowed by default."
---

Permissions decide what a run may do. They are an explicit allow-list of strings, such as `model:openai.responses`,
`tool:orders.lookup` and `effect:write`, that you give the runtime. Anything not on the list is denied, including the
model itself. Instructions, user input, tool results and the model's own requests can never add to the list, so a
prompt injection cannot give an agent new authority.

## A first allow-list

```ts
import { createRuntime } from 'mayura';

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: [
      'model:openai.responses', // call this model adapter
      'tool:orders.lookup',     // call this tool
      'tool:orders.refund',
      'effect:read',            // tools that read outside state
      'effect:write',           // tools that change outside state
      'payments:refund',        // a capability orders.refund declares
    ],
  },
  scope: { principalId: 'customer-42', projectId: 'shop' },
  limits: { maxCostMicros: 100_000 },
});
```

If a run needs something it was not given, it ends as `blocked` with `PERMISSION_DENIED`, before the model or tool is
called.

## What each grant means

| Grant | Allows | Example |
| --- | --- | --- |
| `model:<adapter id>` | Calling that model adapter. Checked before every model call. | `model:openai.responses`, `model:anthropic.messages`, `model:scripted` |
| `gateway:<id>:models` | Explicit bounded model discovery for a gateway provider. Does not grant inference or install prices. | `gateway:openrouter:models` |
| `tool:<tool id>` | Calling that tool. | `tool:orders.lookup` |
| `effect:read` | Calling tools with `effects: 'read'`. | |
| `effect:write` | Calling tools with `effects: 'write'`. | |
| `effect:host` | Calling tools with `effects: 'host'`. | |
| any capability name | Calling tools that declare that capability. | `payments:refund`, `email:send` |

A tool call needs all of these at once: `tool:<id>`, every name in the tool's `capabilities`, and `effect:<effects>`
unless its effects are `'none'`. So `effect:write` alone lets nothing run; it only matters together with a
`tool:` grant.

| Tool | Grants a run needs |
| --- | --- |
| `math.add`, `effects: 'none'`, no capabilities | `tool:math.add` |
| `orders.lookup`, `effects: 'read'` | `tool:orders.lookup`, `effect:read` |
| `orders.refund`, `effects: 'write'`, capabilities `['payments:refund']` | `tool:orders.refund`, `effect:write`, `payments:refund` |

Capability names are yours to invent. Parts of Mayura declare their own, for example `agent:delegate` for calling
child agents and `skills:read` for the skills tools.

For a model router, the grant is the router's own id, and it covers every route. A model-backed guard needs
`model:<id>` for the model it calls.

## Rules

- Grants are exact strings. There are no wildcards: `tool:*` or `tool:orders.*` match nothing.
- There is no deny list. Leave a grant out to deny it.
- Grants are case-sensitive. At most 4096 grants per list, each up to 256 characters. Duplicates are ignored.
- The list is fixed when you create the runtime. Create a runtime per request if permissions differ per user.

## Scope

`scope` says who a run acts for: `{ principalId, projectId }`. It is not a permission; it is identity. Mayura passes it
to every tool (`context.scope`), guard and hook, so your code can limit what it reads and writes to that user and
project:

```ts
import { defineTool, z } from 'mayura';

export const myOrder = defineTool({
  id: 'orders.mine',
  version: '1',
  description: 'Look up one of the signed-in customer\'s orders. Returns found=false otherwise.',
  input: z.object({ orderId: z.string() }),
  output: z.object({ found: z.boolean(), status: z.string().nullable() }),
  effects: 'read',
  capabilities: [],
  execute: async ({ orderId }, context) => {
    const order = await db.findOrder(orderId, { ownerId: context.scope.principalId });
    return order ? { found: true, status: order.status } : { found: false, status: null };
  },
});
```

Treat "not yours" and "does not exist" the same, so a tool never confirms that someone else's record exists. The
default scope is `{ principalId: 'local', projectId: 'default' }`. When a runtime serves many users, set the scope from
your authenticated user, never from the model or the request body.

## Child agents get less, never more

An agent can call another agent through `agentAsTool`. The child runs with the permissions you list for it,
**intersected** with the parent's: a grant the parent does not hold is dropped. The child's limits cannot exceed the
parent's, and its cost counts against the parent's budget.

```ts
import { agentAsTool } from 'mayura';

export const askResearcher = agentAsTool(researcher, {
  id: 'research.ask',
  description: 'Ask the research agent a question. Returns its findings.',
  permissions: { allow: ['model:openai.responses', 'tool:web.search', 'effect:read'] },
  limits: { maxSteps: 6, maxCostMicros: 50_000 },
});
```

For the parent agent to use `askResearcher`, its runtime must allow:

- `tool:research.ask` and `agent:delegate`, to call the child at all;
- `model:openai.responses`, `tool:web.search` and `effect:read`, because the child only keeps grants the parent has.

`runtime.spawn()` follows the same rules. Speculative branches (`runtime.speculate()`) are stricter still: they may
not hold `effect:write`, `effect:host`, `agent:delegate` or memory write grants. See
[Child agents](../guides/child-agents.md).

## Workflows

A workflow runtime takes its own `permissions` list, and each tool step is checked with the same rule as above. When
you run an agent as a step of a durable workflow with `agentAsDurableWorkflow`, there are two lists:

- the workflow's list must allow the step itself: `tool:<agent id>.agent`, `agent:durable`, `effect:host` and
  `model:<model id>`;
- the `permissions` option of `agentAsDurableWorkflow` is what the agent may do inside the step. It is not intersected
  with the workflow's list, so grant there only what that agent needs.

See [Workflows](./workflows.md) and [Durable workflows](../guides/durable-workflows.md).

## Other permission lists

Some parts of Mayura check separate lists with their own names. A memory store takes its own `permissions`, with names
such as `memory:read` and `memory:write` (see [Memory and context](../guides/memory-and-context.md)). The HTTP server
gives each access token capabilities such as `runs:submit` and `workflows:read` (see
[Server and client](../guides/server-and-client.md)). These do not mix with a runtime's grants.

## Good to know

- Permissions control what Mayura will call. They do not sandbox a tool's own code, which runs in your process.
- Instructions like "never refund more than $50" are advice to the model, not rules. Enforce such limits in the tool,
  in a guard, or with a separate capability.

## Related

- [Tools](./tools.md)
- [Runtime](./runtime.md)
- [Outcomes and errors](./outcomes.md)
- [Guardrails](../guides/guardrails.md)
- [Security](../project/security.md)


## Agent handoff authority

A declared [handoff](../guides/agent-handoffs.md) requires the source grant `agent:<target id>`. Its host-owned edge
contains the target's explicit permission list. Transfer replaces source authority with that list and keeps the same
scope, budget, counters and deadline. The model cannot supply grants. This differs from child delegation: a child
receives an intersection with its parent, while an authorized handoff enters a separate configured agent role.


## Resource authorization

[Fine-grained authorization](../guides/authorization.md) decides whether a verified principal may perform an action
on a particular scoped resource. The host calls `authorizer.require` before its operation. The separate
`authz:evaluate` grant admits bounded policy evaluation; policy action names do not mint execution grants. Built-in
RBAC lives at `mayura/authz`. An allow decision still requires the operation's ordinary run grants, server capability,
limits and approvals. No role membership is taken from model or request-body claims.

`authz:audit` separately permits explicitly configured authorization audit delivery. The sink receives validated
identity and resource identifiers, so configure a trusted destination. Missing this grant with `audit` configured
fails construction; it does not silently enable delivery. Sink failures do not grant or revoke access. See
[authorization audit events](../guides/authorization.md#authorization-audit-events).

`authz:http` permits explicitly configured external authorization requests through `@mayurajs/authz-http`. It permits
no protected operation itself, does not replace `authz:evaluate`, and does not admit audit delivery. Without it,
remote checks deny before I/O. See [HTTP authorization policies](../integrations/authz-http.md).

Runtime `authorization` and tool/batch invocation `authorization` accept a host-owned core authorizer. Scoped
`agent/execute`, `run/execute` and `tool/execute` decisions add gates; they do not mint `model:*`, `tool:*`, effect,
child or handoff grants. Approval does not override current execution policy. See
[agent runs and tool execution](../guides/authorization.md#agent-runs-and-tool-execution).


## Checkpointed frontend-result recovery

[AG-UI frontend tools](../guides/ag-ui.md#safe-native-owner-recovery) require `ag-ui:frontend-recover` in the host's
`nativeRecovery.permissions`, alongside a shared journal with `frontend-tools:store`. Browser recovery requests
require the separate `runs:resume` capability and core `run/resume_tool` policy. This does not grant human approval
or permit replaying browser writes. Trusted scanner recovery uses `conversations:recover` plus an explicit
`kind: 'frontend'` policy decision. Existing tool/effect/model grants, continuing budgets and output guards remain
in force. A consumed checkpoint is never recreated to repeat uncertain paid work.

## Retrieval capabilities

[RAG](../guides/rag.md) requires `rag:read` for retrieval, `rag:index` for ingestion/deletion, `rag:embed` for hosted
embeddings, `rag:reconcile` for verified claim recovery and `rag:admin` for explicit SQL schema setup. Native
transports require `rag:transport:<provider>`; expansion, reranking and contextualization require
`rag:transform:<id>`, `rag:rerank:<id>` and `rag:contextualize:<id>`. HTML/PDF parser dispatch requires
`rag:load:html` / `rag:load:pdf`. Capability grants do not replace per-document authorization or sensitivity limits.
