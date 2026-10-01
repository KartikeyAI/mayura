---
title: "Observability"
description: "Watch agent runs through their metadata events, keep run summaries, and export logs, traces and metrics to OpenTelemetry."
---

Every agent run emits a sequence of small metadata events: a step started, a model call completed, a tool finished
with this status, the run ended having spent this much. Mayura gives you three levels of tooling on top of them:

- `handle.observe()` on any run: the raw event stream, for your own logging.
- `mayura/observability`: an observer that follows runs and keeps size-limited summaries (status, counters, cost, gaps),
  with an optional sink to forward events.
- `mayura/exporter-otlp`: exporters that send logs, traces and metrics to an OpenTelemetry collector over OTLP/HTTP
  JSON, plus trace projections for agent runs and durable workflow runs.

Events never contain prompts, messages, tool inputs, tool outputs or error text, so they are safe to ship to a
logging backend.

**Mayura sends no telemetry by default.** Installing or importing any Mayura entry point opens no network connection
and reads no credentials from the environment, and nothing reports usage back to Mayura. Data leaves your process only
through an exporter or sink you construct with an explicit endpoint. Mayura's test suite checks this: it imports the
local packages with network access denied and fails on any attempt.

## Watch a run

```ts
import { createRuntime } from 'mayura';
import { createObserver } from 'mayura/observability';

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses'] },
  limits: { maxCostMicros: 50_000 },
});
const observer = createObserver();

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
await handle.result();
await observation.done(); // resolves when run.completed arrives

const run = observer.inspect(handle.id);
console.log(run?.status, run?.coverage, run?.counters.toolCompleted, run?.cost?.spentMicros);
await observer.close();
```

Observing never changes the run. Disconnecting, a timeout or `observer.close()` stops the subscription only; to stop
the run, call `handle.cancel()`.

To read the raw stream yourself, iterate the handle:

```ts
for await (const event of handle.observe()) {
  console.log(event.sequence, event.type, event.metadata);
}
```

The iterator ends after `run.completed`. Pass `{ after: sequence }` to resume after an event you already have, and a
`signal` to stop early. Over HTTP, `run.events()` from `mayura/client` streams the same events (see
[Server and client](server-and-client.md)).

## Run events

Each event is `{ runId, sequence, timestamp, type, metadata }`. Sequences start at 1 and increase by one.

| Type | Metadata |
| --- | --- |
| `run.started` | `profile`; optional `rootId`, `parentId`, `agentId` |
| `step.started`, `step.completed` | `step`; on completion `result`: `tool_calls`, `final` or `stopped` |
| `model.started`, `model.completed` | `step`, `modelCall`, and the model's `modelId` when it is a stable id; on completion `response` (`final` or `tool_calls`), the call's `costMicros` and, when the provider reports them, its `inputTokens` and `outputTokens`. Guardrail model calls carry `purpose: 'guardrail'`, the check identity and the `decision` instead. |
| `tool.started`, `tool.completed` | `callId`, `toolId`; on completion `status`, and when known `execution` (`not_started`, `succeeded`, `failed`, `unknown`) and `disclosure` (`released`, `withheld`) |
| `hook.started`, `hook.completed` | `hookId`, `hookVersion`, `stage`, `invocationId`, `step`, `attempt`; on completion `status` |
| `delegate.started`, `delegate.completed` | `childRunId`; `childAgentId` at start, `status` at completion |
| `output.delta`, `output.withheld` | `step`, `modelCall`; a delta also has `index` and the streamed `text` |
| `run.completed` | `status`, `spentMicros`, `reservedMicros`, `calls` |
| `events.gap` | `from`, `to`: events that were no longer available |

A run keeps its latest 256 events in memory (the `limits.maxEventRetention` runtime limit). A reader that starts late
or falls behind gets one `events.gap` event instead of the events it missed. `output.delta` is the only event with
content: the streamed text of an output field (see [Streaming](streaming.md)). The observer drops that text and keeps
only its length.

## The observer

`createObserver(options)` returns an observer with three methods:

- `observe(handle, { after?, signal?, durationMs? })` starts following one run and returns
  `{ runId, done(), disconnect() }`. `done()` resolves with the reason it stopped: `terminal`, `source_ended`,
  `disconnected`, `timeout`, `source_failed`, `invalid_event` or `observer_closed`.
- `inspect()` returns every run it knows plus observer-wide metrics; `inspect(runId)` returns one run.
- `close()` stops all subscriptions and returns a final snapshot.

A run's summary (`ObservedRun`) holds its `status`, the last `cursor`, `coverage` (`complete` only when every event
from start to finish was seen), counters (events, model and tool calls, duplicates, missing events, tool calls with
an unknown outcome), the reported `cost`, recorded `gaps`, and the most `recent` events. Counts that exceed
`Number.MAX_SAFE_INTEGER` become decimal strings.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxRuns` | 128 | Runs the observer tracks over its lifetime (at most 1,024). A new run beyond it is refused. |
| `maxRecentEventsPerRun` | 64 | Recent events kept per run; older ones are counted and dropped. |
| `maxObservationMs` | 60,000 | The longest one subscription may last. Raise it for runs that take longer. |
| `sink` | none | A function that receives batches of events to forward. |
| `maxSinkQueue` | 256 | Events waiting for the sink; more are dropped and counted. |
| `sinkBatchSize` | 16 | Events per sink call. |
| `sinkTimeoutMs` | 5,000 | A sink call that takes longer disables the sink for good. |

Every event is checked against a strict allow-list of types and metadata fields before the observer keeps or forwards
it. An event that fails the check stops that subscription and is counted as rejected, never stored.

## Sinks

A sink is `(events, { signal }) => void | Promise<void>`. The observer calls it with one batch at a time, never
retries, and never lets a sink failure affect a run. A thrown error drops the batch and counts it
(`sinkFailures`, `sinkDropped`); a call that exceeds `sinkTimeoutMs` disables the sink. Check `inspect().metrics` and
`inspect().sink` to see what was delivered and dropped.

A sink is not an audit log: queued events are discarded on `close()`, and delivery is best effort.

## Export to OpenTelemetry

`mayura/exporter-otlp` sends OTLP/HTTP JSON to a collector. Each exporter needs an explicit endpoint for its signal
and a service name. It reads no environment variables and sends nothing until you call its `sink`.

```ts
import { createObserver } from 'mayura/observability';
import { createOtlpHttpJsonLogExporter } from 'mayura/exporter-otlp';

const logs = createOtlpHttpJsonLogExporter({
  endpoint: 'https://collector.example.com/v1/logs',
  serviceName: 'orders-agent',
  headers: { Authorization: `Bearer ${process.env.OTLP_TOKEN}` },
  timeoutMs: 4_000,
});
const observer = createObserver({ sink: logs.sink });
```

Each event becomes one log record: the body is the event type, the attributes are `mayura.run.id`,
`mayura.event.sequence` and the metadata fields prefixed with `mayura.`, and failed runs and tools log at `ERROR`.
Keep the exporter's `timeoutMs` below the observer's `sinkTimeoutMs` (both default to 5 seconds), so a slow collector
drops one batch instead of disabling the sink.

| Exporter option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | required | Full signal URL ending in `/v1/logs`, `/v1/traces` or `/v1/metrics`. Must be HTTPS. |
| `serviceName`, `serviceVersion` | required, none | Resource attributes `service.name` and `service.version`. |
| `headers` | none | Sent with every request, for example an authorization header. Never shown by `inspect()`. |
| `allowInsecureLoopback` | `false` | Allow `http://127.0.0.1` or `http://[::1]` for a local collector. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Records per request. |
| `maxRequestBytes`, `maxResponseBytes` | 1 MiB, 64 KiB | Size bounds. |
| `fetch` | global `fetch` | Your own transport, for example to add a proxy. |
| `resourceAttributes` | none | Traces and metrics: more resource attributes, such as a provider's project name. |
| `spanAttributes` | none | Traces: a function adding a provider's own attributes to each span, such as the span kind it reads. |

Attributes from `resourceAttributes` and `spanAttributes` follow the catalog's rules: at most 16, lowercase dotted
keys outside the catalog, `mayura.*` and `service.*`, and values that are stable identifiers or non-negative integers,
so they cannot carry free text. A `spanAttributes` result outside these rules refuses the batch, like an invalid span.

Each exporter sends one request at a time (a second concurrent call is refused), follows no redirects and never
retries. `inspect()` reports attempted, accepted and dropped records, partial rejections, failures and timeouts.
`close()` aborts the request in flight.

### Traces for agent runs

`agentRunTraceSpans(events, { parent? })` turns one run's events into spans: `agent:<agent id>` for the run, one
`model.call` per model call and one `tool:<tool id>` per tool call, with status and budget attributes. Span ids are
derived from the run, so projecting the same events twice gives identical spans.

```ts
import { agentRunTraceSpans, createOtlpHttpJsonTraceExporter } from 'mayura/exporter-otlp';

const traces = createOtlpHttpJsonTraceExporter({ endpoint: 'https://collector.example.com/v1/traces', serviceName: 'orders-agent' });
const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await traces.sink(spans, { signal: AbortSignal.timeout(10_000) });
```

The projection pairs start and completion events, so raise `maxRecentEventsPerRun` for runs with many calls; a call
whose start was evicted gets no span. Span attributes come from a fixed catalog of ids, statuses and integers.

Spans also carry OpenTelemetry's GenAI attributes, so tools that understand them (Langfuse, Datadog, Arize, Honeycomb
and others) show runs as AI traces:

| Span | Attributes |
| --- | --- |
| `agent:<id>` | `gen_ai.operation.name: invoke_agent`, `gen_ai.agent.id`, `gen_ai.agent.name` |
| `model.call` | `gen_ai.operation.name: chat`; for a registry id such as `openai/gpt-5`, `gen_ai.provider.name` (`openai`, `aws.bedrock`, `azure.ai.openai`, `gcp.gemini` and other well-known names) and `gen_ai.request.model`; `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` when the provider reports them; `mayura.model.id` and the call's `mayura.cost.micros` |
| `tool:<id>` | `gen_ai.operation.name: execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type: function` |

OpenTelemetry's GenAI conventions are still in development; Mayura keeps its own span names and `mayura.*` attributes
alongside them.

### Metrics

`createOtlpHttpJsonMetricExporter` sends points you build from a fixed set of metric names: `mayura.runs`,
`mayura.events`, `mayura.model.calls`, `mayura.tool.calls`, `mayura.cost.micros` and `mayura.export.dropped`. Mayura
does not aggregate them for you; compute values from observer snapshots or your own counters.

```ts
import { createOtlpHttpJsonMetricExporter } from 'mayura/exporter-otlp';

const metrics = createOtlpHttpJsonMetricExporter({ endpoint: 'https://collector.example.com/v1/metrics', serviceName: 'orders-agent' });
const now = String(BigInt(Date.now()) * 1_000_000n);
await metrics.sink([
  { name: 'mayura.runs', kind: 'sum', value: completedRuns, monotonic: true, startTimeUnixNano: processStartNanos, timeUnixNano: now, status: 'succeeded' },
], { signal: AbortSignal.timeout(10_000) });
```

### Observability providers

These packages preset an OTLP exporter for one provider: its endpoint, its authentication and anything it needs to
show Mayura's spans as AI traces. Each returns the exporter, so `sink`, `inspect()` and `close()` work as above.

| Package | Provider | Signals |
| --- | --- | --- |
| `@mayurajs/observability-langfuse` | [Langfuse](https://langfuse.com) Cloud (EU, US, JP, HIPAA) or self-hosted: `langfuseTraceExporter({ publicKey, secretKey, region })` | traces |
| `@mayurajs/observability-datadog` | [Datadog](https://www.datadoghq.com) APM or LLM Observability, on any Datadog site: `datadogTraceExporter({ apiKey, site, llmObservability })` | traces |

### Through your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK, send Mayura's spans and metrics through it instead of a second
exporter: they then share your resource, sampler, processors and exporters, and hang under your request spans.
`mayura/exporter-otlp/opentelemetry` needs `@opentelemetry/api` 1.9.1 or a later 1.x, which your SDK already installs.

```ts
import { metrics, trace } from '@opentelemetry/api';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { createOpenTelemetryRunMetrics, createOpenTelemetryTraceBridge } from 'mayura/exporter-otlp/opentelemetry';
import { createObserver } from 'mayura/observability';

const traces = createOpenTelemetryTraceBridge({ tracer: trace.getTracer('orders-agent') });
const runMetrics = createOpenTelemetryRunMetrics({ meter: metrics.getMeter('orders-agent') });
const observer = createObserver({ sink: runMetrics.sink });

// After a run settles:
await traces.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

`createOpenTelemetryTraceBridge({ tracer, context?, maxRememberedSpans?, maxBatchSize? })` takes the same spans as the
OTLP trace exporter, so `sink` also works as the `sink` of `createWorkflowTraceExport`. Your SDK assigns trace and
span ids. A span's parent is linked when it is in the same batch or was exported through the bridge earlier (the last
4,096 span ids are remembered); otherwise the span starts in `context()`, by default the active context. Model call
spans are `CLIENT` spans, the rest `INTERNAL`. A batch with any span outside the attribute catalog is refused whole.

`createOpenTelemetryRunMetrics({ meter, maxRuns? })` is an observer sink that records:

| Metric | Kind | Attributes |
| --- | --- | --- |
| `gen_ai.client.operation.duration` | histogram, seconds | `gen_ai.operation.name: chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `mayura.model.id` |
| `gen_ai.client.token.usage` | histogram, tokens | the same, and `gen_ai.token.type` (`input` or `output`) |
| `mayura.cost.micros` | counter | the same as the duration |
| `mayura.tool.calls` | counter | `gen_ai.tool.name`, `mayura.tool.status` |
| `mayura.runs` | counter | `mayura.run.status`, `gen_ai.agent.id` |

A model call is recorded when it completes; one whose start the observer never delivered is skipped, and so is a
failed call, which has no completion event. Token usage is recorded only when the provider reports it.

## Trace durable workflow runs

For [durable workflows](durable-workflows.md), `createWorkflowTraceExport` in `mayura/workflows` exports each settled
run as one trace: a `workflow:<definition id>` root span and one span per step, built from the run's stored event log.
It keeps a small outbox in your store, so a worker restart exports runs later rather than losing them, and ids are
deterministic, so an export repeated after a crash sends identical spans.

```ts
import { createOtlpHttpJsonTraceExporter } from 'mayura/exporter-otlp';
import { createWorkflowTraceExport, createWorkflowWorker, lifecycleFleetTarget } from 'mayura/workflows';

const exporter = createOtlpHttpJsonTraceExporter({ endpoint: 'https://collector.example.com/v1/traces', serviceName: 'orders' });
const traces = createWorkflowTraceExport({
  source: host.runtime,          // the workflow runtime: inspect(id) and events(id, after)
  store,
  scope,
  exportId: 'primary-collector', // separates independent exports of the same runs
  definitions,                   // every definition version whose runs may be exported
  sink: exporter.sink,           // give this export its own exporter instance
});

const worker = createWorkflowWorker({ units: [host, traces.unit({ targets: [lifecycleFleetTarget(host.runtime)] })], leadership });

// Where you submit runs, track them so fast runs are not missed between discovery passes:
await traces.track(run.id);
```

The unit flushes every second by default. `traces.flush()` and `traces.exportRun(runId)` do the same on demand. To
nest an agent's spans under the step that ran it, pass `{ parent: workflowStepTraceContext(context) }` to
`agentRunTraceSpans` inside the step's tool, where `context` is the tool's execution context. The research-team
starter wires both up in `src/telemetry.ts`.

## Good to know

- Observers and exporters are metadata only by design. For audit records you must keep, write them to your own
  storage.
- The observer follows agent runs in the current process. It does not discover runs or follow child runs; observe
  each handle you care about.
- `run.cost` comes from the `run.completed` event. It reflects spending known at that moment.
- Exporters do not propagate trace context into your HTTP calls, and do not sample. Run an OpenTelemetry Collector if
  you need batching, retries or fan-out.

## Related

- [Streaming](streaming.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
- [Durable workflows](durable-workflows.md)
- [Operator console](operator-console.md)
- [Deployment](deployment.md)
