---
title: "Datadog APM and LLM Observability"
description: "Send agent runs to Datadog APM or LLM Observability over Datadog's OTLP intake with @mayurajs/observability-datadog: sites, limits and errors."
package: "@mayurajs/observability-datadog"
vendor: "Datadog"
logo: "datadog"
website: "https://www.datadoghq.com"
area: "observability"
---

[Datadog](https://www.datadoghq.com) is a monitoring platform; its APM shows distributed traces and its LLM
Observability shows agent, LLM and tool spans with token usage. `@mayurajs/observability-datadog` presets Mayura's OTLP
trace exporter ([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for Datadog's OTLP intake
on your Datadog site, for APM or for LLM Observability. No Datadog Agent is needed. It sends OTLP/HTTP JSON with
`fetch`: no Datadog SDK, no dependencies besides `mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-datadog
```

## Credentials

The intake authenticates with a Datadog **API key** (not an application key). Create one in
[Datadog](https://app.datadoghq.com) under **Organization Settings**, **API Keys**, on the site your account lives on.
The package reads nothing from the environment: pass the key in yourself, for example from `DD_API_KEY`, with the site
from `DD_SITE` and the LLM Observability application name from `DD_LLMOBS_ML_APP`.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { datadogTraceExporter } from '@mayurajs/observability-datadog';

const datadog = datadogTraceExporter({
  apiKey: process.env.DD_API_KEY ?? '',
  site: 'datadoghq.eu',
  llmObservability: { mlApp: 'support-bot' },
  serviceName: 'support-agent',
});
// Keep enough events per run to pair every call's start and completion.
const observer = createObserver({ maxRecentEventsPerRun: 256 });

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
await handle.result();
await observation.done();

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await datadog.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(datadog.inspect().metrics.recordsAccepted);
```

Leave out `llmObservability` to send the same spans to APM instead. The exporter is not a tool, so a run needs no
permission string for it: it runs in your code after the run settles.

For [durable workflows](../guides/durable-workflows.md), give a second exporter's `sink` to
`createWorkflowTraceExport`; each export needs its own instance, because an exporter sends one request at a time. LLM
Observability keeps only spans with GenAI attributes, and workflow and step spans have none, so send workflow traces to
APM:

```ts
import { createWorkflowTraceExport } from 'mayura/workflows';
import { datadogTraceExporter } from '@mayurajs/observability-datadog';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'datadog-apm',
  definitions,
  sink: datadogTraceExporter({ apiKey, site: 'datadoghq.eu', serviceName: 'orders' }).sink,
});
```

See [Trace durable workflow runs](../guides/observability.md#trace-durable-workflow-runs) for the worker unit and nesting
an agent's spans under the step that ran it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | A Datadog API key: 16 to 128 letters and digits. Copied once; never shown by `inspect()` or in errors. |
| `site` | `datadoghq.com` | Your Datadog site (see below). |
| `llmObservability` | `false` | `true` or `{ mlApp }` sends to LLM Observability instead of APM. `mlApp` names the application there, a stable identifier; Datadog uses the service name when you leave it out. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry). |
| `spanAttributes` | none | A function adding your own attributes to each span, under the same rules. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body (at most 16 MiB). |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

## Sites and authentication

The endpoint is `https://otlp.<site>/v1/traces`, where `site` is one of:

| `site` | Datadog site |
| --- | --- |
| `datadoghq.com` | US1 |
| `us3.datadoghq.com` | US3 |
| `us5.datadoghq.com` | US5 |
| `datadoghq.eu` | EU1 |
| `ap1.datadoghq.com` | AP1 |
| `ap2.datadoghq.com` | AP2 |
| `ddog-gov.com` | US1-FED; APM only, since LLM Observability is not available there |

Every request carries the key as `dd-api-key`. With `llmObservability`, requests also carry `dd-otlp-source: llmobs`,
and `dd-ml-app: <mlApp>` when you give one.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs):

- `agent:<agent id>` for the run, with `gen_ai.operation.name: invoke_agent`, `gen_ai.agent.id` and `gen_ai.agent.name`.
- `model.call` for each model call, with `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`
  and `gen_ai.usage.output_tokens` (when the provider reports them), and the call's `mayura.cost.micros`.
- `tool:<tool id>` for each tool call, with `gen_ai.tool.name` and `gen_ai.tool.call.id`.

In APM, a run is a trace with its model and tool calls. In LLM Observability, Datadog reads the GenAI attributes and
shows agent, LLM and tool spans with models and token usage. No prompt, message, tool input, tool output or error text
is sent: the catalog has no field that could carry them.

The package sends traces only. Datadog's OTLP metric intake takes delta sums, and Mayura's metric exporter sends
cumulative ones.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- The exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- It never retries and follows no redirects. A failed batch is dropped and counted.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and the key are never shown.
- `close()` aborts the request in flight and refuses later calls.

## With your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK that exports to Datadog, you can send Mayura's spans through it
with [`createOpenTelemetryTraceBridge`](../guides/observability.md#through-your-opentelemetry-sdk) instead of
this package. The spans carry the same GenAI attributes either way.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your key or Datadog's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you call `datadogTraceExporter()`: a missing or malformed key, an unknown site, an `llmObservability` that is not `true`, `false` or `{ mlApp }`, an `mlApp` that is not a stable identifier, or LLM Observability on `ddog-gov.com`. Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | Datadog did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | Datadog answered anything but HTTP 200 (for example 403 for a wrong key or site), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests run the exporter against a fake `fetch` that checks the site's endpoint, the `dd-api-key` header, the
  LLM Observability headers with and without an ML app, and that the body carries the GenAI attributes.
- They also check refused keys, sites, ML app names and LLM Observability on `ddog-gov.com`, and a rejected request,
  and that no error or `inspect()` result contains the key.
- `scripts/live/observability-datadog.mjs` sends one agent run's spans to APM and to LLM Observability: Datadog
  accepted both on the `ap1.datadoghq.com` site on October 12, 2026.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [Sentry tracing](observability-sentry.md) and [Better Stack tracing](observability-betterstack.md): other monitoring
  backends.
- [Durable workflows](../guides/durable-workflows.md): runs whose traces `createWorkflowTraceExport` sends.
