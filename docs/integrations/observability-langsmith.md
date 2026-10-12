---
title: "LangSmith tracing"
description: "Send agent runs to LangSmith as chains with LLM and tool runs using @mayurajs/observability-langsmith: setup, regions, limits and errors."
package: "@mayurajs/observability-langsmith"
vendor: "LangSmith"
logo: "langsmith"
website: "https://smith.langchain.com"
area: "observability"
---

[LangSmith](https://smith.langchain.com) is LangChain's platform for tracing, evaluating and monitoring LLM
applications, as a cloud service or self-hosted. `@mayurajs/observability-langsmith` presets Mayura's OTLP trace
exporter ([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for LangSmith's OpenTelemetry
endpoint, and adds LangSmith's run types to each span. It sends OTLP/HTTP JSON with `fetch`: no LangSmith SDK, no
dependencies besides `mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-langsmith
```

## Credentials

LangSmith authenticates with an API key. Create one in [LangSmith](https://smith.langchain.com) under **Settings**,
**API Keys**. The package reads nothing from the environment: pass the key in yourself, for example from
`LANGSMITH_API_KEY`, and the project name from `LANGSMITH_PROJECT` if you use one.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { langSmithTraceExporter } from '@mayurajs/observability-langsmith';

const langsmith = langSmithTraceExporter({
  apiKey: process.env.LANGSMITH_API_KEY ?? '',
  project: 'support-agent',
  region: 'us',
  serviceName: 'support-agent',
});
// Keep enough events per run to pair every call's start and completion.
const observer = createObserver({ maxRecentEventsPerRun: 256 });

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
await handle.result();
await observation.done();

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await langsmith.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(langsmith.inspect().metrics.recordsAccepted);
```

The exporter is not a tool, so a run needs no permission string for it: it runs in your code after the run settles.

For [durable workflows](../guides/durable-workflows.md), give a second exporter's `sink` to
`createWorkflowTraceExport`; each export needs its own instance, because an exporter sends one request at a time:

```ts
import { createWorkflowTraceExport } from 'mayura/workflows';
import { langSmithTraceExporter } from '@mayurajs/observability-langsmith';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'langsmith',
  definitions,
  sink: langSmithTraceExporter({ apiKey, project: 'orders', serviceName: 'orders' }).sink,
});
```

Workflow and step spans have no GenAI operation, so they show as `chain` runs. See
[Trace durable workflow runs](../guides/observability.md#trace-durable-workflow-runs) for the worker unit and nesting
an agent's spans under the step that ran it.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | A LangSmith API key. Copied once; never shown by `inspect()` or in errors. |
| `project` | LangSmith's default project | The project the traces go to: at most 128 printable characters, no leading or trailing spaces. |
| `region` | `us` | LangSmith's region: `us`, `eu`, `apac` or `aws-us`. Leave it out when you give `baseUrl`. |
| `baseUrl` | none | A self-hosted LangSmith's API URL, such as `https://langsmith.example.com`. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry). |
| `allowInsecureLoopback` | `false` | Allow `http://127.0.0.1` or `http://[::1]` as `baseUrl`, for a local LangSmith. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body (at most 16 MiB). |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

The package sets `spanAttributes` itself, so you cannot pass your own.

## Endpoint and authentication

| `region` | Endpoint |
| --- | --- |
| `us` | `https://api.smith.langchain.com/otel/v1/traces` |
| `eu` | `https://eu.api.smith.langchain.com/otel/v1/traces` |
| `apac` | `https://apac.api.smith.langchain.com/otel/v1/traces` |
| `aws-us` | `https://aws.api.smith.langchain.com/otel/v1/traces` |

With `baseUrl`, the exporter appends `/api/v1/otel/v1/traces` to your URL. The URL must be HTTPS (or loopback HTTP
with `allowInsecureLoopback`) and carry no credentials, query or fragment.

Every request carries the key as `x-api-key`, and `Langsmith-Project: <project>` when you give a project.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs), including the OpenTelemetry GenAI attributes
(operation, provider, model, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` when the provider reports
them, agent and tool names) and the call's `mayura.cost.micros`. The package adds two attributes LangSmith reads:

| Span | `langsmith.span.kind` | Also |
| --- | --- | --- |
| `model.call` | `llm` | `gen_ai.system`: the provider, such as `openai` or `aws.bedrock` |
| `tool:<tool id>` | `tool` | |
| `agent:<agent id>` and any other span | `chain` | |

So a run shows as a chain with its LLM and tool runs, models and token usage. `langSmithAttributes(span)` is exported
if you need the same mapping elsewhere. No prompt, message, tool input, tool output or error text is sent: the catalog
has no field that could carry them.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- The exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- It never retries and follows no redirects. A failed batch is dropped and counted.
- LangSmith answers a successful export with HTTP 200 and a `{}` body labelled `text/plain`. The exporter takes that
  exact answer as success; any other non-JSON reply is a failure.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and the key are never shown.
- `close()` aborts the request in flight and refuses later calls.

## With your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK, you can send Mayura's spans through it with
[`createOpenTelemetryTraceBridge`](../guides/observability.md#through-your-opentelemetry-sdk) instead. The bridge
passes only the catalog's attributes, so spans sent that way do not carry `langsmith.span.kind` or `gen_ai.system`.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your key or LangSmith's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you call `langSmithTraceExporter()`: a missing or malformed key (16 to 256 letters, digits, `_` or `-`), an unsafe project name, an unknown region, both `region` and `baseUrl`, or a `baseUrl` with credentials, a query or a fragment. Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | LangSmith did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | LangSmith answered anything but HTTP 200 (for example 403 for a wrong key), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests run the exporter against a fake `fetch` that checks the endpoint for each region and a self-hosted URL,
  the `x-api-key` and `Langsmith-Project` headers (and that the project header is absent by default), and the
  `langsmith.span.kind` of each span.
- They also check refused keys, project names, regions and URLs, and a rejected request, and that no error or
  `inspect()` result contains the key.
- `scripts/live/observability-langsmith.mjs` sends one agent run's spans to LangSmith: LangSmith accepted them on
  October 6, 2026. The first run found that LangSmith answers success as `{}` labelled `text/plain`; the OTLP exporter
  was fixed to accept that answer before the run passed.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [Langfuse tracing](observability-langfuse.md) and [Arize AX and Phoenix tracing](observability-arize.md): other AI
  tracing backends.
- [Durable workflows](../guides/durable-workflows.md): runs whose traces `createWorkflowTraceExport` sends.
