---
title: "Arize AX and Phoenix tracing"
description: "Send agent runs to Arize AX or Phoenix with OpenInference attributes using @mayurajs/observability-arize: setup, regions, limits and errors."
package: "@mayurajs/observability-arize"
vendor: "Arize"
logo: "arize"
website: "https://arize.com"
area: "observability"
---

[Arize](https://arize.com) makes two AI observability products: Arize AX, its cloud platform, and
[Phoenix](https://phoenix.arize.com), which is open source and runs self-hosted or as Phoenix Cloud. Both read
OpenInference attributes on OpenTelemetry spans. `@mayurajs/observability-arize` presets Mayura's OTLP trace exporters
([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for each:

- `arizeTraceExporter` sends OTLP/HTTP JSON to Arize AX.
- `phoenixTraceExporter` sends OTLP/HTTP protobuf to Phoenix, which takes only protobuf. Mayura encodes it itself; no
  protobuf library is needed.

Both add OpenInference attributes beside the OpenTelemetry GenAI ones. The package talks to Arize with `fetch`: no
Arize or Phoenix SDK, no dependencies besides `mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-arize
```

## Credentials

- **Arize AX** needs a space id and an API key. Find the space id and create an API key in [Arize AX](https://app.arize.com)
  under the space's **Settings**. Suggested variables: `ARIZE_SPACE_ID` and `ARIZE_API_KEY`.
- **Phoenix** needs its address and, when authentication is on (always on Phoenix Cloud), an API key. For Phoenix
  Cloud, the address is your space's URL, `https://app.phoenix.arize.com/s/<space>`, and you create a key in
  [Phoenix](https://app.phoenix.arize.com) under **Settings**, **API Keys**. Suggested variables:
  `PHOENIX_COLLECTOR_ENDPOINT` and `PHOENIX_API_KEY`.

The package reads nothing from the environment: pass every value in yourself.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { arizeTraceExporter } from '@mayurajs/observability-arize';

const arize = arizeTraceExporter({
  spaceId: process.env.ARIZE_SPACE_ID ?? '',
  apiKey: process.env.ARIZE_API_KEY ?? '',
  projectName: 'support-agent',
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
if (spans.length > 0) await arize.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(arize.inspect().metrics.recordsAccepted);
```

For Phoenix, build the exporter with `phoenixTraceExporter` and use its `sink` the same way:

```ts
import { phoenixTraceExporter } from '@mayurajs/observability-arize';

// Phoenix Cloud; or a self-hosted Phoenix, such as http://127.0.0.1:6006 with allowInsecureLoopback: true.
const phoenix = phoenixTraceExporter({
  baseUrl: process.env.PHOENIX_COLLECTOR_ENDPOINT ?? '',
  apiKey: process.env.PHOENIX_API_KEY,
  projectName: 'support-agent',
  serviceName: 'support-agent',
});
```

The exporters are not tools, so a run needs no permission string for them: they run in your code after the run
settles.

For [durable workflows](../guides/durable-workflows.md), give a second exporter's `sink` to
`createWorkflowTraceExport`; each export needs its own instance, because an exporter sends one request at a time:

```ts
import { createWorkflowTraceExport } from 'mayura/workflows';
import { arizeTraceExporter } from '@mayurajs/observability-arize';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'arize',
  definitions,
  sink: arizeTraceExporter({ spaceId, apiKey, projectName: 'orders', serviceName: 'orders' }).sink,
});
```

Workflow and step spans have no GenAI operation, so they show as `CHAIN` spans. See
[Trace durable workflow runs](../guides/observability.md#trace-durable-workflow-runs) for the worker unit and nesting
an agent's spans under the step that ran it.

## Options

`arizeTraceExporter`:

| Option | Default | Meaning |
| --- | --- | --- |
| `spaceId` | required | The space's id, from its settings. |
| `apiKey` | required | An Arize API key. Copied once; never shown by `inspect()` or in errors. |
| `projectName` | required | The project the traces belong to: a stable identifier such as `support-agent` (no spaces). |
| `region` | `us` | Arize AX's region: `us`, `eu` or `ca`. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry); up to 15, since the project name takes one of the 16. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body (at most 16 MiB). |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

`phoenixTraceExporter`:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | required | Phoenix's address: `https://app.phoenix.arize.com/s/<space>` for Phoenix Cloud, or a self-hosted Phoenix such as `https://phoenix.example.com`. |
| `apiKey` | none | A Phoenix API key, needed when authentication is on. Copied once; never shown by `inspect()` or in errors. |
| `projectName` | required | The project the traces belong to: a stable identifier such as `support-agent`. |
| `allowInsecureLoopback` | `false` | Allow `http://127.0.0.1` or `http://[::1]` as `baseUrl`, for a local Phoenix. |
| `serviceName`, `serviceVersion`, `resourceAttributes`, `timeoutMs`, `maxBatchSize`, `maxRequestBytes`, `maxResponseBytes`, `fetch` | as above | The same as for Arize AX. `maxRequestBytes` bounds the protobuf body. |

Both exporters set `spanAttributes` themselves, so you cannot pass your own.

## Endpoints and authentication

Arize AX:

| `region` | Endpoint |
| --- | --- |
| `us` | `https://otlp.arize.com/v1/traces` |
| `eu` | `https://otlp.eu-west-1a.arize.com/v1/traces` |
| `ca` | `https://otlp.ca-central-1a.arize.com/v1/traces` |

Every request carries the `space_id` and `api_key` headers, and the resource carries `openinference.project.name`.

Phoenix: the exporter appends `/v1/traces` to `baseUrl`. The URL must be HTTPS (or loopback HTTP with
`allowInsecureLoopback`) and carry no credentials, query or fragment. Requests are `application/x-protobuf`, carry
`Authorization: Bearer <apiKey>` when you give a key, and the resource carries `openinference.project.name`.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs), including the OpenTelemetry GenAI attributes and
the call's `mayura.cost.micros`. Both exporters add OpenInference attributes derived from them:

| Span | `openinference.span.kind` | Also |
| --- | --- | --- |
| `agent:<agent id>` | `AGENT` | `agent.name` |
| `model.call` | `LLM` | `llm.model_name`, `llm.provider`, and when the provider reports tokens `llm.token_count.prompt`, `llm.token_count.completion` and `llm.token_count.total` |
| `tool:<tool id>` | `TOOL` | `tool.name` |
| Workflow and other spans | `CHAIN` | |

`llm.provider` uses OpenInference's names where they differ from OpenTelemetry's: `aws.bedrock` becomes `aws`,
`azure.ai.openai` becomes `azure`, `gcp.gemini` and `gcp.vertex_ai` become `google`, `mistral_ai` becomes `mistralai`
and `x_ai` becomes `xai`. `openInferenceAttributes(span)` is exported, so you can pass it as `spanAttributes` to an
OTLP exporter for another OpenInference backend.

No prompt, message, tool input, tool output or error text is sent: the catalog has no field that could carry them.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- Each exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- They never retry and follow no redirects. A failed batch is dropped and counted.
- Phoenix answers an accepted export with an empty protobuf body; a partial-success reply in protobuf is read like the
  JSON one.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and keys are never shown.
- `close()` aborts the request in flight and refuses later calls.

## With your OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK, you can send Mayura's spans through it with
[`createOpenTelemetryTraceBridge`](../guides/observability.md#through-your-opentelemetry-sdk) instead. The bridge
passes only the catalog's attributes, so spans sent that way carry the GenAI attributes but no OpenInference ones.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your keys or Arize's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you build an exporter: a missing space id or API key, a malformed key, a project name that is not a stable identifier, an unknown region, or a Phoenix `baseUrl` that is missing, plain HTTP, or has credentials, a query or a fragment. Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | Arize or Phoenix did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | The service answered anything but HTTP 200 (for example 401 for a wrong key, or Phoenix's 415 for a content type it does not take and 503 when its queue is full), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests check the OpenInference mapping for agent, model, tool and workflow spans, including provider names and
  token totals.
- They run `arizeTraceExporter` against a fake `fetch` that checks each region's endpoint, the `space_id` and
  `api_key` headers, the project resource attribute and each span's kind; and `phoenixTraceExporter` against one that
  checks the Phoenix Cloud and local URLs, the protobuf body and content type, and the bearer key only when given.
- They also check refused credentials, project names, regions and URLs, and rejected requests, and that no error or
  `inspect()` result contains a key.
- `scripts/live/observability-arize.mjs` sends one agent run's spans to Arize AX and to Phoenix: both accepted them on
  October 6, 2026.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [Langfuse tracing](observability-langfuse.md) and [LangSmith tracing](observability-langsmith.md): other AI tracing
  backends.
- [Durable workflows](../guides/durable-workflows.md): runs whose traces `createWorkflowTraceExport` sends.
