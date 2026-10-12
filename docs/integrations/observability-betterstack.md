---
title: "Better Stack tracing"
description: "Send agent runs to a Better Stack OpenTelemetry source with @mayurajs/observability-betterstack: setup, options, limits and errors."
package: "@mayurajs/observability-betterstack"
vendor: "Better Stack"
logo: "betterstack"
website: "https://betterstack.com"
area: "observability"
---

[Better Stack](https://betterstack.com) collects logs, metrics and traces into sources you query and chart.
`@mayurajs/observability-betterstack` presets Mayura's OTLP trace exporter
([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for a Better Stack OpenTelemetry source:
its ingesting host and its token. It sends OTLP/HTTP JSON with `fetch`: no Better Stack SDK, no dependencies besides
`mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-betterstack
```

## Credentials

Create an **OpenTelemetry** source in [Better Stack](https://betterstack.com) (Telemetry, **Sources**, **Connect
source**). Its settings show the two values the exporter needs: the source token and the ingesting host, such as
`s1234.eu-nbg-2.betterstackdata.com`. The package reads nothing from the environment: pass them in yourself, for
example from `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST`.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { betterStackTraceExporter } from '@mayurajs/observability-betterstack';

const betterStack = betterStackTraceExporter({
  sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN ?? '',
  ingestingHost: process.env.BETTERSTACK_INGESTING_HOST ?? '',
  serviceName: 'support-agent',
});
// Keep enough events per run to pair every call's start and completion.
const observer = createObserver({ maxRecentEventsPerRun: 256 });

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
await handle.result();
await observation.done();

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await betterStack.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(betterStack.inspect().metrics.recordsAccepted);
```

The exporter is not a tool, so a run needs no permission string for it: it runs in your code after the run settles.

For [durable workflows](../guides/durable-workflows.md), give a second exporter's `sink` to
`createWorkflowTraceExport`; each export needs its own instance, because an exporter sends one request at a time:

```ts
import { createWorkflowTraceExport } from 'mayura/workflows';
import { betterStackTraceExporter } from '@mayurajs/observability-betterstack';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'betterstack',
  definitions,
  sink: betterStackTraceExporter({ sourceToken, ingestingHost, serviceName: 'orders' }).sink,
});
```

See [Trace durable workflow runs](../guides/observability.md#trace-durable-workflow-runs) for the worker unit and nesting
an agent's spans under the step that ran it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `sourceToken` | required | The source's token: 8 to 256 letters, digits, `_` or `-`. Copied once; never shown by `inspect()` or in errors. |
| `ingestingHost` | required | The source's ingesting host: a host name only, without a scheme, path or port. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry). |
| `spanAttributes` | none | A function adding your own attributes to each span, under the same rules. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body (at most 16 MiB). |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

## Endpoint and authentication

The endpoint is `https://<ingestingHost>/v1/traces`, always HTTPS. Every request carries
`Authorization: Bearer <sourceToken>`.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs):

- `agent:<agent id>` for the run, with `gen_ai.operation.name: invoke_agent`, `gen_ai.agent.id`, `gen_ai.agent.name`
  and the run's status and budget attributes.
- `model.call` for each model call, with `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`
  and `gen_ai.usage.output_tokens` (when the provider reports them), and the call's `mayura.cost.micros`.
- `tool:<tool id>` for each tool call, with `gen_ai.tool.name`, `gen_ai.tool.call.id` and `mayura.tool.status`.

In Better Stack you query and chart spans by these attributes: model, provider, token counts, cost and statuses. No
prompt, message, tool input, tool output or error text is sent: the catalog has no field that could carry them.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- The exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- It never retries and follows no redirects. A failed batch is dropped and counted.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and the token are never shown.
- `close()` aborts the request in flight and refuses later calls.

## With your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK that exports to Better Stack, you can send Mayura's spans through
it with [`createOpenTelemetryTraceBridge`](../guides/observability.md#through-your-opentelemetry-sdk) instead of this
package. The spans carry the same attributes either way.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your token or Better Stack's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you call `betterStackTraceExporter()`: a missing or malformed token, or an ingesting host that is not a bare host name (a scheme, a path, user info or an IP address). Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | Better Stack did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | Better Stack answered anything but HTTP 200 (for example 401 for a wrong token), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests run the exporter against a fake `fetch` that checks the endpoint on the ingesting host, the bearer token
  and that the body carries the GenAI attributes.
- They also check refused tokens and hosts, and a rejected request counted as dropped, and that no error or `inspect()`
  result contains the token.
- `scripts/live/observability-betterstack.mjs` sends one agent run's spans to a Better Stack source: Better Stack
  accepted them on October 6, 2026.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [Datadog APM and LLM Observability](observability-datadog.md) and [Sentry tracing](observability-sentry.md): other
  monitoring backends.
- [Durable workflows](../guides/durable-workflows.md): runs whose traces `createWorkflowTraceExport` sends.
