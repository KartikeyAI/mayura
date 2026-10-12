---
title: "PostHog LLM analytics"
description: "Send agent runs to PostHog LLM analytics as AI events with @mayurajs/observability-posthog: setup, regions, person ids, limits and errors."
package: "@mayurajs/observability-posthog"
vendor: "PostHog"
logo: "posthog"
website: "https://posthog.com"
area: "observability"
---

[PostHog](https://posthog.com) is a product analytics platform; its LLM analytics shows model calls, costs and traces
beside your product events. `@mayurajs/observability-posthog` presets Mayura's OTLP trace exporter
([`mayura/exporter-otlp`](../guides/observability.md#export-to-opentelemetry)) for PostHog's OpenTelemetry endpoint for
AI events, in the US or EU cloud. It sends OTLP/HTTP JSON with `fetch`: no PostHog SDK, no dependencies besides
`mayura`, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/observability-posthog
```

## Credentials

The exporter needs the project's API token (`phc_…`). Copy it from [PostHog](https://posthog.com) under the project's
**Settings**. Note which cloud the project is on (US Cloud or EU Cloud) and set `region` to match. The package reads
nothing from the environment: pass the token in yourself, for example from `POSTHOG_PROJECT_TOKEN`, and the region
from `POSTHOG_REGION`.

## Use it

Follow a run with an observer, then turn its events into spans with `agentRunTraceSpans` and give them to the
exporter's `sink`:

```ts
import { createObserver } from 'mayura/observability';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { posthogTraceExporter } from '@mayurajs/observability-posthog';

const posthog = posthogTraceExporter({
  projectToken: process.env.POSTHOG_PROJECT_TOKEN ?? '',
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
if (spans.length > 0) await posthog.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(posthog.inspect().metrics.recordsAccepted);
```

The exporter is not a tool, so a run needs no permission string for it: it runs in your code after the run settles.

### Events per person

`distinctId` sets the `posthog.distinct_id` resource attribute, the person the events belong to in PostHog. It applies
to everything one exporter sends, so build one exporter per person, or leave it out for anonymous events:

```ts
import { posthogTraceExporter } from '@mayurajs/observability-posthog';

const forUser = posthogTraceExporter({ projectToken, region: 'eu', distinctId: 'user-42', serviceName: 'support-agent' });
```

A distinct id must be a stable identifier, such as a user id: letters, digits and `.`, `_`, `:`, `/` or `-`, no
spaces.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `projectToken` | required | The project's API token: `phc_` followed by 8 to 128 letters and digits. |
| `region` | `us` | PostHog Cloud's region: `us` or `eu`. |
| `distinctId` | none | The person the events belong to (`posthog.distinct_id`). Without it, events are anonymous. |
| `serviceName` | required | The `service.name` resource attribute: a stable identifier. |
| `serviceVersion` | none | The `service.version` resource attribute. |
| `resourceAttributes` | none | More resource attributes, under the [catalog's rules](../guides/observability.md#export-to-opentelemetry); up to 15 with `distinctId`. |
| `spanAttributes` | none | A function adding your own attributes to each span, under the same rules. |
| `timeoutMs` | 5,000 | Per request. |
| `maxBatchSize` | 256 | Spans per `sink` call (at most 256). |
| `maxRequestBytes` | 1 MiB | The largest request body. PostHog's AI endpoint takes up to 4 MB per request. |
| `maxResponseBytes` | 64 KiB | The largest reply read (at most 1 MiB). |
| `fetch` | `globalThis.fetch` | Your own transport, for tests or a proxy. |

## Endpoint and authentication

| `region` | Endpoint |
| --- | --- |
| `us` | `https://us.i.posthog.com/i/v0/ai/otel` |
| `eu` | `https://eu.i.posthog.com/i/v0/ai/otel` |

PostHog's AI endpoint is not at OTLP's standard `/v1/traces` path; the package sets the exact URL. Every request
carries `Authorization: Bearer <projectToken>`.

## What is sent

Each span is metadata from the run's events: names, ids, timing, statuses and integers from a fixed
[attribute catalog](../guides/observability.md#traces-for-agent-runs), including the OpenTelemetry GenAI attributes
(operation, provider, model, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` when the provider reports
them, agent and tool names) and the call's `mayura.cost.micros`. PostHog turns them into its AI events:

- each model call becomes an `$ai_generation` event with its model, provider and token counts;
- the run and each tool call become `$ai_span` events;
- each trace becomes an `$ai_trace`.

No prompt, message, tool input, tool output or error text is sent: the catalog has no field that could carry them. The
package sends traces only.

## Delivery and limits

- One `sink` call is one HTTP request of at most `maxBatchSize` spans. Split a larger run into several calls.
- The exporter sends one request at a time; a second call while one is in flight is refused with `CONFLICT`.
- It never retries and follows no redirects. A failed batch is dropped and counted.
- `inspect()` returns `{ state, inFlight, metrics }`. The metrics count `batchesAttempted`, `recordsAttempted`,
  `recordsAccepted`, `recordsDropped`, `partialResponses`, `failedRequests`, `timedOutRequests`, `cancelledRequests`,
  `requestBytes` and `responseBytes`. Headers and the token are never shown.
- `close()` aborts the request in flight and refuses later calls.

## Errors

Failures reach you as a `MayuraError` with a `code`. None of them repeats your token or PostHog's reply text.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | When you call `posthogTraceExporter()`: a missing token or one that does not start with `phc_`, an unknown region, or a `distinctId` that is not a stable identifier. Nothing is sent. |
| `INVALID_INPUT` | An empty batch, more than `maxBatchSize` spans, a span outside the attribute catalog, or a request over `maxRequestBytes`. The batch is dropped before it is sent. |
| `CONFLICT` | The exporter is closed, or another `sink` call is in flight. |
| `TIMEOUT` | PostHog did not answer within `timeoutMs`. |
| `CANCELLED` | Your `signal` aborted, or `close()` was called. |
| `TOOL_FAILED` | PostHog answered anything but HTTP 200 (for example 401 for a wrong token or region), or a reply that is not valid OTLP. |

A reply that reports some spans rejected (OTLP partial success) resolves normally and counts them in `recordsDropped`
and `partialResponses`.

## How it is tested

- Unit tests run the exporter against a fake `fetch` that checks each region's endpoint, the bearer token, that events
  are anonymous by default (`service.name` is the only resource attribute), and that `distinctId` adds
  `posthog.distinct_id` beside your own resource attributes.
- They also check refused tokens, regions and distinct ids, and a rejected request, and that no error or `inspect()`
  result contains the token.
- `scripts/live/observability-posthog.mjs` sends one agent run's spans to PostHog: PostHog accepted them on October 6,
  2026.

## Related

- [Observability](../guides/observability.md): observers, the OTLP exporters and trace projections.
- [Langfuse tracing](observability-langfuse.md) and [LangSmith tracing](observability-langsmith.md): other AI tracing
  backends.
- [Costs and budgets](../concepts/costs-and-budgets.md): where the cost on each model call comes from.
