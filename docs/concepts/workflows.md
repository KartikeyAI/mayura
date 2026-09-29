---
title: "Workflows"
description: "What a Mayura workflow is, when to use one instead of a single agent run, and which workflow entry point to start with."
---

A workflow is a fixed graph of steps that you declare as data: run this tool, then these three in parallel, wait for a
person, wait until Tuesday, then finish. Each step is a [tool](tools.md), so every step has typed input and output,
declared effects and its own permission. The graph, not a model, decides what runs next.

An agent run is the opposite: the model decides which tools to call, in what order, and when it is done. Use a workflow
when you already know the steps and want them to run the same way every time, with an audit trail. Use an agent when
the path depends on judgement. The two combine well: a workflow step can run an agent, and an agent can call a workflow
as a tool.

| You need | Use |
|---|---|
| A model to plan, call tools and answer | A single [agent run](agent.md) |
| The same steps every time, in a fixed order | An in-process workflow |
| Steps that survive restarts, wait hours for a person or a date, and never repeat a payment | A durable workflow |
| Undo earlier steps when a later one fails | A saga |
| Repeat a durable workflow until a condition holds | A loop |

## A workflow at a glance

```ts
import { defineTool, z } from 'mayura';
import { defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';

const invoice = z.object({ invoiceId: z.string(), amountCents: z.number().int() });

const check = defineTool({
  id: 'invoices.check', version: '1', description: 'Check an invoice against policy.',
  input: invoice, output: z.object({ ok: z.boolean() }), effects: 'none', capabilities: [],
  execute: request => ({ ok: request.amountCents < 100_000 }),
});
const pay = defineTool({
  id: 'invoices.pay', version: '1', description: 'Pay an invoice.',
  input: invoice, output: z.object({ paymentId: z.string() }), effects: 'write', capabilities: ['payments:send'],
  execute: async request => ({ paymentId: `pay_${request.invoiceId}` }),
});

export const payInvoice = defineWorkflowLifecycle({
  id: 'invoices.pay-flow',
  version: '1',
  input: invoice,
  output: z.object({ paymentId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'check', tool: check, input: { kind: 'input', path: [] } },
    // Stops until a person approves this exact payment.
    { kind: 'tool', id: 'pay', tool: pay, input: { kind: 'input', path: [] }, dependsOn: ['check'], approval: true },
  ],
  result: { kind: 'step', stepId: 'pay', path: [] },
});
```

The pieces:

- **Nodes** are the steps. A `tool` node runs a tool, a `join` node collects the outputs of its dependencies into an
  array, and durable workflows add `human` nodes (wait for a typed answer from a person), `timer` nodes (wait until
  an absolute time) and `signal` nodes (wait for an event from another system). A tool node can run an agent through
  `agentStep`.
- **Bindings** say where a step's input comes from: `{ kind: 'input', path }` reads the workflow input,
  `{ kind: 'step', stepId, path }` reads an earlier step's output, and `{ kind: 'literal', value }` is a fixed JSON
  value. A path is a list of property names; `[]` means the whole value.
- **`dependsOn`** orders the steps. A step that reads another step's output must depend on it. Steps whose dependencies
  are done run together.
- **`result`** is a binding that picks the workflow's output, checked against the `output` schema.

The graph is fixed when you define it: at most 128 nodes, no cycles, and no code runs between steps. Logic lives in the
tools. For work whose width depends on data, a durable workflow can declare up to a fixed number of parallel slots
(`fanOut`) and skip steps with a condition (`when`). See [Durable workflows](../guides/durable-workflows.md).

## In-process or durable

Mayura runs workflows in two ways.

**In-process (ephemeral).** `mayura/workflows/ephemeral` turns a workflow into an agent, or into a tool another agent
can call, and runs it inside an ordinary [runtime](runtime.md) with that runtime's permissions, limits and budget.
Nothing is stored. If the process stops, the run is gone. There are no approvals or waits. Use it to package a fixed
sequence of tool calls as one reusable unit. See [Workflow composition](../guides/workflow-composition.md).

**Durable.** A durable workflow records every step in [storage](../guides/storage.md) (SQLite or PostgreSQL) before
and after it runs. A run can wait for days for an approval, a person or a date without holding any memory or process.
When a process restarts, another worker picks the run up where it stopped. A step that was running when the process
died is never run again automatically: its outcome is marked unknown, and a person decides what happened. This is what
makes durable workflows safe for payments, emails and other effects that must not happen twice.

## Workflow entry points

| Entry point | What it gives you |
|---|---|
| `mayura/workflows/lifecycle` | **Start here.** Durable workflows with tool steps, approvals, human requests, timers, optional steps and parallel slots, plus the worker host that advances them. |
| `mayura/workflows` | Shared pieces for running workflows in production: workers and leadership, the fleet hold, the operator API for the HTTP server, version inventory and migrations, trace export. It also re-exports the lifecycle API, and contains `defineWorkflow` and two earlier durable runtimes for plain tool graphs. |
| `mayura/workflows/ephemeral` | `workflowAsAgent` and `workflowAsTool`: run a `defineWorkflow` graph in-process. |
| `mayura/workflows/sagas` | Sequences of durable workflows that compensate (undo) earlier steps in reverse order when a later one fails. |
| `mayura/workflows/loops` | Repeat one durable workflow, up to a fixed number of times, until a condition in its output is false. |
| `mayura/workflows/composites` | The worker host and index that advance sagas and loops after a restart. |
| `mayura/workflows/graphs` | Durable graphs that wait for other, already submitted runs to finish before continuing. |
| `mayura/workflows/children` | Durable workflow trees: a root workflow that starts required child workflows, one level deep. |
| `mayura/workflows/agents` | `agentAsDurableWorkflow`: wrap an agent as a one-step durable workflow for the earlier `defineWorkflow` runtimes. |

The related `mayura/workstream/*` entry points are standalone durable building blocks that work next to workflows:
[webhook triggers](../guides/webhooks.md), typed [human requests](../guides/approvals-and-human-input.md) outside a
workflow, durable timers and completion waits.

**Which one to start with.** For anything that must survive a restart, use `mayura/workflows/lifecycle`. It is what
every `mayura init` starter uses, and sagas and loops are built from lifecycle workflows. Reach for graphs or children
only when you need a run to wait on other runs or own child runs. Use `mayura/workflows/ephemeral` when you only want
to compose tools in-process.

## Definition versions

Every durable run is pinned to the exact definition it started with: its `id`, its `version` and a digest of its
steps. Mayura never continues a run under a different definition. When you change a workflow, give it a new
`version`, keep the old version registered with your workers until its runs finish, and optionally move in-flight runs
to the new version with a reviewed migration. See [Operating workflows](../guides/workflow-operations.md).

## Good to know

- Steps are tools. To run a model inside a step, wrap an agent in a tool; see
  [Durable workflows](../guides/durable-workflows.md).
- There are no automatic retries. A failed step fails the run; a step with an unknown outcome makes the run end
  `outcome_unknown` and waits for a person.
- A durable run has one cost budget, in micros, shared by all its steps. See [Costs and budgets](costs-and-budgets.md).
- Durable runtimes grant permissions with the same explicit strings as agents: `tool:<id>`, each capability the tool
  declares, and `effect:<kind>` for tools with effects. See [Permissions](permissions.md).

## Related

- [Durable workflows](../guides/durable-workflows.md)
- [Workflow composition](../guides/workflow-composition.md)
- [Approvals and human input](../guides/approvals-and-human-input.md)
- [Sagas and loops](../guides/sagas-and-loops.md)
- [Operating workflows](../guides/workflow-operations.md)
