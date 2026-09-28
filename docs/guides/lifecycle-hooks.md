---
title: "Lifecycle hooks"
description: "Run your own checks and observers at fixed points of an agent run: before model and tool calls, before output release, and at the end."
---

Lifecycle hooks let your code take part in every run of an agent at fixed points: before the run starts, before each
model call, before each tool call, before a result is released, and when the run finishes. There are two kinds.
**Control hooks** can stop the run and can ask the runtime to call read-only tools first, for example a policy check.
**Observer hooks** watch without changing anything, for example to write an audit log or count outcomes. Use hooks for
cross-cutting policy and telemetry; use [guards](guardrails.md) to check or redact content itself.

```ts
import { defineAgent, defineHook } from 'mayura';
import { z } from 'zod';

const releasePolicy = defineHook({
  id: 'policy.release',
  version: '1',
  stage: 'beforeOutputRelease',
  tools: [],
  handler: event => ({ decision: event.candidate === null ? 'block' : 'continue' }),
});

const audit = defineHook({
  id: 'audit.tools',
  version: '1',
  stage: 'afterToolCall',
  mandatory: true,
  handler: async event => { await auditLog.append({ tool: event.toolId, status: event.status }); },
});

const agent = defineAgent({
  id: 'support.assistant', version: '1', instructions: 'Answer questions about orders.',
  model, tools: [], input: z.string(), output: z.string(),
  hooks: [releasePolicy, audit],
});
```

Hooks belong to the agent definition, so they run on every run of that agent. An agent accepts up to 16 hooks, with
unique ids. Hooks of the same stage run in the order you list them.

## Stages

Control stages are awaited before the step they protect. Each handler returns `{ decision: 'continue' }` or
`{ decision: 'block' }`.

| Stage | Runs | The event contains |
| --- | --- | --- |
| `beforeExecution` | After the input schema and input guards, before the first model call | `input`, and `media` (a summary of each image or PDF: type, size, name) when there is some |
| `beforeStep` | Before each reasoning step | `step` |
| `beforeModelCall` | Before each primary model call | `modelId`, `purpose`, and `request` with `messages`, `tools`, `maxOutputTokens`, and `media` (summaries by message index) when there is some; hooks never see media bytes |
| `beforeToolCall` | Before each tool call the model proposed | `proposal` with `callId`, `toolId`, `input` |
| `beforeDelegate` | Before a child agent starts (on the parent's hooks) | `childRunId`, `childAgentId`, `input` |
| `beforeOutputRelease` | After output guards, before a tool result enters the conversation or the final answer is released | `source` (`agent` or `tool`), `callId`, `toolId`, `candidate` |

Observer stages see metadata only, never content, and return nothing.

| Stage | Runs | The event contains |
| --- | --- | --- |
| `afterStep` | After each step | `step`, `result` (`tool_calls`, `final` or `stopped`) |
| `afterModelCall` | After each primary model call | `step`, `modelId`, `response`, `toolCalls` |
| `afterToolCall` | After each tool call | `callId`, `toolId`, `status`, `execution`, `disclosure` |
| `afterDelegate` | After a child agent finishes (on the parent's hooks) | `childRunId`, `childAgentId`, `status` |
| `onViolation` | When a guard, hook or permission check refuses something | `source`, `boundary`, `code` |
| `afterExecution`, `onError`, `onCancel`, `onBlocked` | Once at the end, depending on the outcome | `status`, `error.code` |
| `onFinally` | Once at the very end, always | `status`, `error.code` |

Every handler also receives a `context` with the run's `runId`, `rootId`, `parentId`, `agentId`, verified `scope`,
the hook's id and version, the current `step` (`null` before the first step) and an abort `signal`. The event and
context are frozen.

## Decisions

A control hook that returns `{ decision: 'block' }` ends the run with status `blocked` and code `GUARD_BLOCKED`. A
handler that throws, times out or returns anything else ends it `blocked` with `GUARD_UNAVAILABLE`. Hooks cannot
rewrite what they see: the model request, the tool proposal and the candidate output stay exactly as they are. To
change content, use a guard with a `rewrite` verdict.

The `beforeToolCall` event holds the model's raw proposal, before the tool's input schema transforms it.

## Actions: calling a tool from a hook

A control hook can ask the runtime to run tools before it continues. List the tools the hook may call in `tools`, and
return them as `actions`:

```ts
import { defineHook, defineTool } from 'mayura';
import { z } from 'zod';

const assertProjectReadable = defineTool({
  id: 'policy.assert-readable', version: '1', description: 'Fails unless the path is inside the project.',
  input: z.string(), output: z.literal(true), effects: 'none', capabilities: [],
  execute: path => {
    if (!path.startsWith('project/')) throw new Error('Outside the project.');
    return true as const;
  },
});

const proposalPolicy = defineHook({
  id: 'policy.proposal',
  version: '1',
  stage: 'beforeToolCall',
  tools: [assertProjectReadable],
  handler: event => ({
    decision: 'continue',
    actions: [{ toolId: assertProjectReadable.id, input: event.proposal.input }],
  }),
});
```

- Hook tools must have `effects: 'none'` or `'read'`. Agent wrappers and child workflows are not allowed.
- The tools are private to the hook. The model does not see them, and listing them grants nothing: the runtime still
  needs `tool:<id>`, the tool's capabilities and `effect:read` for a read tool.
- Actions run one after another through the normal tool path: same scope, budget, tool guards and the agent's output
  guards. If one fails, the run stops with that tool's outcome.
- The action's result is **not** passed back to the handler. Write the policy as an assertion: a tool that fails (or
  whose guard blocks) when the check fails. A tool that returns `false` successfully does not block anything.
- Actions are not a transaction. A later failure does not undo an earlier action.

## Observers and `mandatory`

An observer that throws or times out is recorded as a failed hook, and the run continues. Set `mandatory: true` when
the observation must happen, such as an audit log: if a mandatory observer fails, the run ends `blocked` with
`GUARD_UNAVAILABLE` and a successful answer is withheld. The end-of-run stages `onViolation`, `onError`, `onCancel`,
`onBlocked` and `onFinally` never change the outcome, even when mandatory. A mandatory `afterExecution` observer can
withhold a successful answer.

## Limits

| Option | Default | Maximum | Applies to |
| --- | --- | --- | --- |
| `timeoutMs` | 5,000 | 30,000 | Each hook call, including its actions |
| `maxActions` | 4 | 8 | Control hooks, per call |
| `maxResultBytes` | 65,536 | 1,048,576 | Control hooks: the decision and all action inputs |
| `tools` | none | 32 | Control hooks (required, `[]` if none) |

The runtime also counts every hook call against its `maxHookCalls` limit (default 128, maximum 4,096). Hook calls do
not use model steps or cost anything themselves; the tools they call are charged like any other tool call.

## Hooks outside agent runs

Some lifecycle points belong to other parts of Mayura and take plain callbacks rather than `defineHook`:

| Where | Option | Stages |
| --- | --- | --- |
| [Memory](memory-and-context.md) | `hooks` on `createNativeMemory`, `createMemoryStore` | `beforeMemoryWrite` (control), `afterMemoryWrite` (observer) |
| [Context assembly](memory-and-context.md) | `hooks` on `assembleContext` | `beforeContextBuild`, `afterContextBuild` (both control) |
| [Retries](helpers.md) | `onRetry` on `retry` | `onRetry` (control) |
| [Durable workflows](durable-workflows.md) | `createWorkflowHookRelay` from `mayura/workflows` | `onWait`, `onResume`, `onApprovalRequested`, `onApprovalResolved`, and the end stages |

```ts
import { createNativeMemory } from 'mayura/memory';

const memory = createNativeMemory({
  store, scope, permissions: { allow: ['memory:read', 'memory:write'] },
  hooks: {
    beforeMemoryWrite: event => ({ decision: event.candidate?.sensitivity === 'restricted' ? 'block' : 'continue' }),
    afterMemoryWrite: event => { console.log('memory', event.operation, event.id, event.version); },
  },
});
```

A blocked memory write stores nothing. If `afterMemoryWrite` fails, the call rejects with a message saying the write
did commit.

The workflow hook relay reads a run's stored event log and delivers callbacks from a durable cursor. Call
`relay.deliver(runId)` from a worker loop. Delivery is at least once, so deduplicate on `event.eventId`.

## Events

Runs with hooks emit `hook.started` and `hook.completed` events with the hook id, stage, step and completion status.
They never include content, action inputs or error messages. See [observability](observability.md).

## Good to know

- Handlers are your code in your process. They are trusted: hooks are not a sandbox.
- A timed-out handler cannot dispatch the actions it returns later, but its promise keeps running until it settles.
- `beforeModelCall` sees the messages and tools sent to the model, not the agent instructions or the provider's
  private continuation state.
- The final `beforeOutputRelease` runs before the run waits for required child agents; a child that fails later can
  still fail the parent.

## Related

- [Guardrails](guardrails.md)
- [Agents](../concepts/agent.md)
- [Permissions](../concepts/permissions.md)
- [Observability](observability.md)
- [Durable workflows](durable-workflows.md)
