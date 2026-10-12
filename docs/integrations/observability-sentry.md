---
title: "Sentry tracing"
description: "Send agent runs to Sentry's AI Agents view over its OTLP endpoint with @mayurajs/observability-sentry: DSN setup, span ops, limits and errors."
package: "@mayurajs/observability-sentry"
vendor: "Sentry"
logo: "sentry"
website: "https://sentry.io"
area: "observability"
---

[Sentry](https://sentry.io) is an error-tracking and performance-monitoring service, in the cloud or self-hosted.
`@mayurajs/observability-sentry` presets Mayura's OTLP trace exporter
([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for Sentry's OTLP endpoint, derived from
your project's DSN, and adds Sentry's `gen_ai.*` span ops so agent runs show in Sentry's AI Agents view. Sentry's OTLP
ingestion is in beta at Sentry, and takes traces and logs, not metrics. The package sends OTLP/HTTP JSON with `fetch`:
no Sentry SDK, no dependencies besides `mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-sentry
```

## Credentials

The exporter needs the project's DSN, `https://<public key>@o<org>.ingest.<region>.sentry.io/<project>`. Copy it from
[Sentry](https://sentry.io) under the project's **Settings**, **Client Keys (DSN)**. Only the DSN's public key is sent;
a legacy DSN's secret key is never sent. The package reads nothing from the environment: pass the DSN in yourself, for
example from `SENTRY_DSN`.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { sentryTraceExporter } from '@mayurajs/observability-sentry';

const sentry = sentryTraceExporter({ dsn: process.env.SENTRY_DSN ?? '', serviceName: 'support-agent' });
// Keep enough events per run to pair every call's start and completion.
const observer = createObserver({ maxRecentEventsPerRun: 256 });

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
await handle.result();
await observation.done();

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await sentry.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(sentry.inspect().metrics.recordsAccepted);
```

The exporter is not a tool, so a run needs no permission string for it: it runs in your code after the run settles.

For [durable workflows](../guides/durable-workflows.md), give a second exporter's `sink` to
`createWorkflowTraceExport`; each export needs its own instance, because an exporter sends one request at a time:

```ts
import { createWorkflowTraceExport } from 'mayura/workflows';
import { sentryTraceExporter } from '@mayurajs/observability-sentry';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'sentry',
  definitions,
  sink: sentryTraceExporter({ dsn, serviceName: 'orders' }).sink,
});
```

See [Trace durable workflow runs](../guides/observability.md#trace-durable-workflow-runs) for the worker unit and nesting
an agent's spans under the step that ran it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dsn` | required | The project's DSN. The endpoint and the public key come from it. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry). |
| `allowInsecureLoopback` | `false` | Allow an `http://127.0.0.1` or `http://[::1]` DSN, for a local Sentry. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body (at most 16 MiB). |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

The package sets `spanAttributes` itself, so you cannot pass your own.

## Endpoint and authentication

The endpoint is built from the DSN: its scheme and host, any path before the project id (for a self-hosted Sentry
under a path), then `/api/<project id>/integration/otlp/v1/traces`. For example, a DSN for `o12345.ingest.us.sentry.io`
and project `678` sends to `https://o12345.ingest.us.sentry.io/api/678/integration/otlp/v1/traces`. So any Sentry
region and a self-hosted Sentry work without more configuration.

Every request carries `x-sentry-auth: sentry sentry_key=<public key>`.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs), including the OpenTelemetry GenAI attributes
(operation, provider, model, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` when the provider reports
them, agent and tool names) and the call's `mayura.cost.micros`. The package adds the span op Sentry's AI Agents view
reads:

| Span | `sentry.op` |
| --- | --- |
| `agent:<agent id>` | `gen_ai.invoke_agent` |
| `model.call` | `gen_ai.chat` |
| `tool:<tool id>` | `gen_ai.execute_tool` |
| Workflow and other spans | none |

`sentryAttributes(span)` is exported if you need the same mapping elsewhere. No prompt, message, tool input, tool output
or error text is sent: the catalog has no field that could carry them.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- The exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- It never retries and follows no redirects. A failed batch is dropped and counted.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and the key are never shown.
- `close()` aborts the request in flight and refuses later calls.

## With your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK, you can send Mayura's spans through it with
[`createOpenTelemetryTraceBridge`](../guides/observability.md#through-your-opentelemetry-sdk) instead. The bridge
passes only the catalog's attributes, so spans sent that way carry no `sentry.op`.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your DSN or Sentry's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you call `sentryTraceExporter()`: a missing DSN, a DSN without a public key (16 to 64 letters and digits) or a numeric project id, with a query or fragment, or over plain HTTP to anything but loopback. Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | Sentry did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | Sentry answered anything but HTTP 200 (for example 429 when rate limited), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests run the exporter against a fake `fetch` that checks the endpoint built from a cloud DSN, a self-hosted
  DSN under a path and a loopback DSN, the `x-sentry-auth` header, and each span's `sentry.op`.
- They also check that a legacy DSN's secret key is never sent, refused DSNs, and a rejected request, and that no error
  contains the DSN.
- `scripts/live/observability-sentry.mjs` sends one agent run's spans to Sentry: Sentry accepted them on October 6,
  2026.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [Datadog APM and LLM Observability](observability-datadog.md) and [Better Stack tracing](observability-betterstack.md):
  other monitoring backends.
- [Durable workflows](../guides/durable-workflows.md): runs whose traces `createWorkflowTraceExport` sends.
