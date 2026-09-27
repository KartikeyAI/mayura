# Trace durable workflow runs

Export each settled workflow run as one OpenTelemetry trace: a root span for the run and a child span per step, built from the run's durable event log. Agents that run inside a step can nest their spans under that step. Everything exported is metadata: names, ids, times, statuses and budget integers. Inputs, outputs, prompts, tool arguments, human identities and error text never leave the process.

## Export settled runs from a worker

```ts
import { createOtlpHttpJsonTraceExporter } from 'mayura/exporter-otlp';
import { createWorkflowTraceExport, createWorkflowWorker, lifecycleFleetTarget } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';

const host = createWorkflowLifecycleHost({ store, scope, definitions, ...policy });
const exporter = createOtlpHttpJsonTraceExporter({ endpoint: 'https://collector.example/v1/traces', serviceName: 'orders' });

const traces = createWorkflowTraceExport({
  source: host.runtime,          // any runtime of the format: inspect(id) + events(id, after)
  store, scope,                  // holds the export's durable outbox and per-run markers
  exportId: 'primary-collector', // separates independent exports of the same runs
  definitions,                   // every version whose runs may be exported
  sink: exporter.sink,           // give the export its own exporter instance
});

const worker = createWorkflowWorker({
  units: [host, traces.unit({ targets: [lifecycleFleetTarget(host.runtime)] })],
  leadership,
});
```

Wherever you submit runs, record them so a run that settles within one discovery interval is not missed:

```ts
const run = await runtime.submit(definition, { input, idempotencyKey });
await traces.track(run.id); // durable and idempotent; call it again on a retried submission
```

The unit, every `intervalMs` (default 1 s) while it runs:

1. discovers active runs through `targets` and tracks them (a safety net for runs never passed to `track`);
2. flushes the outbox: each tracked run that has settled (`succeeded`, `failed`, `blocked`, `cancelled` or `outcome_unknown`) is projected, sent in batches of `maxBatchSize` spans (default 128, at most 256), marked with the log position it covers, and removed. Unsettled runs stay; runs the source no longer knows are dropped.

`flush()` and `exportRun(runId)` do the same on demand, for tests, shutdown or a script.

## What a trace contains

```
workflow:<definition id>          root: first to last event of the run
├─ tool:<node id>                 each step: its first to its last settling event
├─ human:<node id>, timer:<node id>, wait:<node id>, join:<node id>, child:<node id>
│  └─ agent:<agent id>            optional: an agent the step ran (see below)
│     ├─ model.call
│     └─ tool:<tool id>
```

| Span | Attributes |
| --- | --- |
| Root | `mayura.run.id`, `mayura.workflow.definition.id`, `.definition.version`, `.definition.digest`, `mayura.workflow.status`, `mayura.workflow.events`, `mayura.budget.spent_micros`, `.reserved_micros`, `.max_micros` |
| Step | `mayura.workflow.node.id`, `.node.kind`, `.step.status`, `.step.code` (a fixed code such as `BUDGET_EXCEEDED`), `.receipt.execution`, `.child.run.id`, `mayura.tool.id`, `mayura.tool.version`, `mayura.budget.step_cost_micros` (the reservation the step was admitted with) |
| Agent | `mayura.run.id` (the agent run), `mayura.agent.id`, `mayura.run.status`, `mayura.budget.spent_micros`, `.reserved_micros` |
| Model and tool calls | `mayura.model.call`; `mayura.tool.id`, `mayura.tool.status`, `mayura.workflow.receipt.execution` |

Span status: `ok` for succeeded; `error` for failed, blocked, unknown, timed out or `outcome_unknown`; `unset` for cancelled, skipped or never-settled steps. Times are the store's event timestamps. A step that never settled on its own (skipped by a cancellation, for example) ends at the run's end.

## Nest an agent under its step

A step's tool receives `context.callId = "<runId>/step:<nodeId>"` in every format, so the step's span can be computed inside the tool:

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { createObserver } from 'mayura/observability';
import { workflowStepTraceContext } from 'mayura/workflows';

execute: async (input, context) => {
  const observer = createObserver({ maxRuns: 1 });
  const handle = agents.submit(researcher, { input });
  const observation = observer.observe(handle);
  const outcome = await handle.result(); await observation.done();
  const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? [], { parent: workflowStepTraceContext(context) });
  queueForExport(spans); // a separate exporter instance or queue: an exporter sends one request at a time
  await observer.close();
  return outcome.status === 'succeeded' ? outcome.output : null;
}
```

`agentRunTraceSpans` re-admits every event through the observability allowlist and pairs model and tool calls; an unpaired start (evicted, or the run was cut off) yields no span. Its ids derive from the agent run id, so re-projecting the same events yields the same spans. The research-team starter (`src/telemetry.ts`) is a complete example.

## Restarts and duplicates

- Ids are deterministic: the trace id derives from the run id, each step's span id from the run id and node id (`workflowTraceContext(runId, nodeId?)`). Exporting a run twice sends identical spans: a backend that keys spans by trace and span id keeps one copy, and any other shows two copies of the same span, never a second trace.
- The outbox and markers are durable records in `store`. A worker that crashes after the collector accepted a run but before marking it re-sends the run once after restart; one that crashes earlier sends it for the first time after restart. Nothing is lost while the run stays in the outbox.
- A run whose log grows after its export (a late receipt, a reconciliation, a recovery) is exported again, with the same ids, when `exportRun` is called for it; the outbox no longer holds it, so call `track` again if you want the unit to pick it up.
- Delivery failures keep the run in the outbox for the next flush. Telemetry never changes, blocks or fails a workflow run.

## Bounds and limits

- `track` refuses with `LIMIT_EXCEEDED` once the outbox holds `maxPending` runs (default 4,096, at most 16,384). A run's log may hold at most `maxEvents` events (default 100,000) to be exported.
- The outbox is one record per `exportId`, rewritten on every change and appending one event to its own log each time, like the hook relay's cursor.
- Format coverage, each with a real-runtime test: lifecycle (format 5), format 2 (`createWorkflowRuntime`), graphs (format 3) and workflow-tree roots. The leased `createScheduledWorkflowRuntime` writes the same event vocabulary but has no dedicated test. A tree's child step is one span carrying the child run's id; the child run's own steps are not projected because the tree runtime's `events()` reads roots only, and `workflowStepTraceContext` inside a child's tool names a trace of the child run id, not the root's. Sagas and loops are not covered.
- A migrated run is projected against its current definition; events of nodes the migration removed are ignored.
- Only traces are produced. There is no W3C context propagation into steps, no sampling and no span events or links.
