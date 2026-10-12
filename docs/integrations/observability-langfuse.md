---
title: "Langfuse tracing"
description: "Send agent runs, model calls and tool calls to Langfuse as traces with @mayurajs/observability-langfuse: setup, regions, limits and errors."
package: "@mayurajs/observability-langfuse"
vendor: "Langfuse"
logo: "langfuse"
website: "https://langfuse.com"
area: "observability"
---

[Langfuse](https://langfuse.com) is an open-source LLM engineering platform for traces, evaluations and prompt
management, offered as Langfuse Cloud or self-hosted. `@mayurajs/observability-langfuse` presets Mayura's OTLP trace
exporter ([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for Langfuse's OpenTelemetry
endpoint: its URL, its authentication and its ingestion version. It sends OTLP/HTTP JSON with `fetch`: no Langfuse SDK,
no dependencies besides `mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-langfuse
```

## Credentials

Langfuse authenticates with a project's key pair: a public key (`pk-lf-…`) and a secret key (`sk-lf-…`). Create them in
[Langfuse](https://cloud.langfuse.com) under the project's **Settings**, **API Keys**. The keys belong to one project,
so the traces land in that project. The package reads nothing from the environment: pass the keys in yourself, for
example from `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { langfuseTraceExporter } from '@mayurajs/observability-langfuse';

const langfuse = langfuseTraceExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
  region: 'eu',
  serviceName: 'support-agent',
});
// Keep enough events per run to pair every call's start and completion.
const observer = createObserver({ maxRecentEventsPerRun: 256 });

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
await handle.result();
await observation.done();

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await langfuse.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(langfuse.inspect().metrics.recordsAccepted);
```

The exporter is not a tool, so a run needs no permission string for it: it runs in your code after the run settles.

For [durable workflows](../guides/durable-workflows.md), give a second exporter's `sink` to
`createWorkflowTraceExport`; each export needs its own instance, because an exporter sends one request at a time:

```ts
import { createWorkflowTraceExport } from 'mayura/workflows';
import { langfuseTraceExporter } from '@mayurajs/observability-langfuse';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'langfuse',
  definitions,
  sink: langfuseTraceExporter({ publicKey, secretKey, region: 'eu', serviceName: 'orders' }).sink,
});
```

See [Trace durable workflow runs](../guides/observability.md#trace-durable-workflow-runs) for the worker unit, `track`
and nesting an agent's spans under the step that ran it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `publicKey` | required | The project's public key, `pk-lf-…`. |
| `secretKey` | required | The project's secret key, `sk-lf-…`. Copied once; never shown by `inspect()` or in errors. |
| `region` | `eu` | Langfuse Cloud's region: `eu`, `us`, `jp` or `hipaa`. Leave it out when you give `baseUrl`. |
| `baseUrl` | none | A self-hosted Langfuse (v3.22.0 or later), such as `https://langfuse.example.com`. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry). |
| `spanAttributes` | none | A function adding your own attributes to each span, under the same rules. |
| `allowInsecureLoopback` | `false` | Allow `http://127.0.0.1` or `http://[::1]` as `baseUrl`, for a local Langfuse. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body (at most 16 MiB). |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

## Endpoint and authentication

| `region` | Endpoint |
| --- | --- |
| `eu` | `https://cloud.langfuse.com/api/public/otel/v1/traces` |
| `us` | `https://us.cloud.langfuse.com/api/public/otel/v1/traces` |
| `jp` | `https://jp.cloud.langfuse.com/api/public/otel/v1/traces` |
| `hipaa` | `https://hipaa.cloud.langfuse.com/api/public/otel/v1/traces` |

With `baseUrl`, the exporter appends `/api/public/otel/v1/traces` to your URL. The URL must be HTTPS (or loopback HTTP
with `allowInsecureLoopback`) and carry no credentials, query or fragment.

Every request carries `Authorization: Basic <base64 of publicKey:secretKey>` and `x-langfuse-ingestion-version: 4`,
which makes spans visible in Langfuse at once instead of after a delay.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs). Langfuse reads the OpenTelemetry GenAI attributes
on them, so a run shows as an agent trace with its model and tool calls:

- `agent:<agent id>` for the run, with `gen_ai.operation.name: invoke_agent`, `gen_ai.agent.id` and `gen_ai.agent.name`.
- `model.call` for each model call, with `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`
  and `gen_ai.usage.output_tokens` (when the provider reports them), and the call's `mayura.cost.micros`.
- `tool:<tool id>` for each tool call, with `gen_ai.tool.name` and `gen_ai.tool.call.id`.

No prompt, message, tool input, tool output or error text is sent: the catalog has no field that could carry them.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- The exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- It never retries and follows no redirects. A failed batch is dropped and counted.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and keys are never shown.
- `close()` aborts the request in flight and refuses later calls.

## With your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK that exports to Langfuse, you can send Mayura's spans through it
with [`createOpenTelemetryTraceBridge`](../guides/observability.md#through-your-opentelemetry-sdk) instead of this
package. The spans carry the same GenAI attributes either way.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your keys or Langfuse's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you call `langfuseTraceExporter()`: a missing or malformed key, an unknown region, both `region` and `baseUrl`, or a `baseUrl` with credentials, a query, a fragment or plain HTTP. Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | Langfuse did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | Langfuse answered anything but HTTP 200 (for example 401 for wrong keys), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests run the exporter against a fake `fetch` that checks the endpoint for each region and a self-hosted URL,
  the Basic authorization and ingestion-version headers, and that the body carries the GenAI attributes.
- They also check refused keys, regions and URLs, a rejected request and a cancelled export, and that no error or
  `inspect()` result contains the secret key.
- `scripts/live/observability-langfuse.mjs` sends one agent run's spans to Langfuse Cloud: Langfuse accepted them on
  October 6, 2026.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [LangSmith tracing](observability-langsmith.md) and [Arize AX and Phoenix tracing](observability-arize.md): other AI
  tracing backends.
- [Durable workflows](../guides/durable-workflows.md): runs whose traces `createWorkflowTraceExport` sends.
