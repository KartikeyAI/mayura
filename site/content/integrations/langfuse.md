---
title: "Trace Mayura agents in Langfuse"
description: "Send agent runs and durable workflow runs to Langfuse as traces: models, tokens, cost and tool calls, with no prompt or output ever leaving your process."
date: 2026-10-12
tags: Langfuse, observability, OpenTelemetry, tracing
---

*Langfuse details checked against Langfuse's documentation and `@langfuse/otel` 5.13.1 on October 12, 2026. Mayura's
makers wrote this guide.*

[Langfuse](https://langfuse.com) is an open-source platform for tracing and evaluating LLM applications, available as
Langfuse Cloud or self-hosted. It accepts traces over OpenTelemetry, and Mayura already describes every agent run in
OpenTelemetry's GenAI vocabulary. `@mayurajs/observability-langfuse` connects the two: it is Mayura's OTLP trace
exporter, set up with Langfuse's endpoint, authentication and ingestion version.

The result is a trace per run in Langfuse, with the agent, each model call with its model and token counts, and each
tool call with its status. What the trace does not hold matters as much: no prompt, message, tool input, tool output
or error text is ever sent.

## What you'll build

- An agent run traced in Langfuse, from a runtime in your own code.
- Durable workflow runs exported as traces, with each step's agent nested under it.
- The same spans sent through your own OpenTelemetry SDK instead, if you already run one.

## 1. Install and get keys

```bash
npm install mayura @mayurajs/observability-langfuse
```

The package sends OTLP/HTTP JSON with `fetch`. It has no Langfuse SDK and no dependency besides `mayura`, so it runs on
Node, Bun, Deno, Cloudflare Workers and Vercel Edge.

Langfuse authenticates with a project's key pair: a public key (`pk-lf-…`) and a secret key (`sk-lf-…`), created under
the project's **Settings**, **API Keys**. The keys belong to one project, and traces land in that project. The package
reads nothing from the environment; pass the keys in yourself.

## 2. Trace an agent run

Tracing a run takes three pieces: an observer that follows the run's events, `agentRunTraceSpans` to turn those
events into spans, and the Langfuse exporter to send them.

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { createObserver } from 'mayura/observability';
import { openai } from '@mayurajs/provider-openai';
import { langfuseTraceExporter } from '@mayurajs/observability-langfuse';

const models = createModels({
  providers: [openai({ apiKey: process.env['OPENAI_API_KEY']! })],
  prices: { 'openai/gpt-5.1': { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 } },
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'support.assistant', version: '1', instructions: 'Answer the customer in two sentences.',
  model: models.model('openai/gpt-5.1'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const langfuse = langfuseTraceExporter({
  publicKey: process.env['LANGFUSE_PUBLIC_KEY'] ?? '',
  secretKey: process.env['LANGFUSE_SECRET_KEY'] ?? '',
  region: 'eu',
  serviceName: 'support-agent',
});
// Keep enough events per run to pair every call's start with its completion.
const observer = createObserver({ maxRecentEventsPerRun: 256 });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai/gpt-5.1'] }, limits: { maxCostMicros: 200_000 } });

const handle = runtime.submit(agent, { input: { question: 'Where is order 42?' } });
const observation = observer.observe(handle);
const outcome = await handle.result();
await observation.done();

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []);
if (spans.length > 0) await langfuse.sink(spans, { signal: AbortSignal.timeout(10_000) });
console.log(outcome.status, langfuse.inspect().metrics.recordsAccepted);
await runtime.close();
```

Some details:

- **Observing never changes the run.** The observer reads the run's event stream. If it falls behind or stops, the run
  carries on; only `handle.cancel()` stops a run.
- **Export after the run settles.** The projection pairs each call's start event with its completion, so it runs on
  the finished event list. A call whose start event was evicted from the observer's buffer gets no span, which is why
  `maxRecentEventsPerRun` is raised from its default of 64.
- **No permission is needed for the exporter.** It is not a tool the agent calls: it runs in your code, after the run.
- **Name models through the registry.** `gen_ai.request.model` and `gen_ai.provider.name` are derived from model ids
  of the form `<provider>/<model>`, such as `openai/gpt-5.1` from [the model registry](../../../docs/guides/model-registry.md).
  An adapter used directly, such as `openAIResponses`, has the id `openai.responses`, so its spans carry only
  `mayura.model.id` and Langfuse has no model name to show.

## 3. What Langfuse shows

Every run becomes one trace. Mayura names its spans and also sets the OpenTelemetry GenAI attributes that Langfuse
reads:

| Span | GenAI attributes | Mayura attributes |
| --- | --- | --- |
| `agent:<agent id>`, the run | `gen_ai.operation.name: invoke_agent`, `gen_ai.agent.id`, `gen_ai.agent.name` | `mayura.run.status`, `mayura.budget.spent_micros`, `mayura.budget.reserved_micros` |
| `model.call`, each model call | `gen_ai.operation.name: chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | `mayura.model.id`, `mayura.cost.micros` |
| `tool:<tool id>`, each tool call | `gen_ai.operation.name: execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type: function` | `mayura.tool.id`, `mayura.tool.status` |

Token counts appear when the provider reports them. Model and tool spans hang under the run's span, with their own
start and end times, so the trace shows the order of the calls, how long each took and which tool calls failed. A
model call that failed has no completion event and so gets no span; the run's span still shows how the run ended.

**Cost** needs a word of care, because there are two figures. Mayura charges every model call against the run's
budget, from the prices you configured, and sends that as `mayura.cost.micros` on the span: millionths of a dollar,
the same number the run's budget used. Langfuse keeps its own cost fields. It fills them from a cost attribute when
one is sent, which Mayura does not do, or otherwise infers them for generations from the model name and token usage
when the model matches one of its model definitions. Which figure you see in Langfuse's cost views therefore depends
on Langfuse recognizing the model; the one Mayura enforced is always on the span.

## 4. What is never sent

Spans are built from a fixed catalog of attributes: names, ids, timings, statuses and integers. The catalog has no
field that could carry text, so no prompt, message, tool input, tool output or error message can reach Langfuse,
whatever the agent does. Even attributes you add with `resourceAttributes` or `spanAttributes` must be stable
identifiers or non-negative integers, and a batch with anything else is refused before it is sent.

That is a deliberate trade, and it has costs on Langfuse's side. The input and output panes of a Mayura trace are
empty, and features that work on the content of a call, such as evaluating answers in Langfuse or replaying a prompt,
have nothing to work on. In return, you can send traces from production without a review of what personal data they
might contain. If you need content for evaluation, record it in your own storage, under your own retention rules.

## 5. Regions and self-hosting

`region` picks the Langfuse Cloud region your data lives in:

| `region` | Endpoint host |
| --- | --- |
| `eu` (the default) | `cloud.langfuse.com` |
| `us` | `us.cloud.langfuse.com` |
| `jp` | `jp.cloud.langfuse.com` |
| `hipaa` | `hipaa.cloud.langfuse.com` |

For a self-hosted Langfuse, pass `baseUrl` instead of `region`, such as `https://langfuse.example.com`. Langfuse
accepts OpenTelemetry traces from version 3.22.0. The URL must be HTTPS; for a Langfuse running on your own machine,
`allowInsecureLoopback: true` allows `http://127.0.0.1` and `http://[::1]`.

Every request carries `Authorization: Basic` with the key pair and `x-langfuse-ingestion-version: 4`. Langfuse's
documentation says that header makes spans visible at once; without it, they can take up to 10 minutes to appear.

## 6. Trace durable workflows

A [durable workflow](../../../docs/guides/durable-workflows.md) can run for days and survive restarts, so its trace is
built differently: `createWorkflowTraceExport` reads a settled run's stored event log and exports it as one trace, with
a `workflow:<definition id>` root span and one span per step. It keeps a small outbox in your store, so a worker that
restarts exports runs later instead of losing them, and span ids are derived from the run, so an export repeated after
a crash sends identical spans.

```ts
import { createWorkflowTraceExport, createWorkflowWorker, lifecycleFleetTarget } from 'mayura/workflows';
import { langfuseTraceExporter } from '@mayurajs/observability-langfuse';

const workflowTraces = createWorkflowTraceExport({
  source: host.runtime,
  store,
  scope,
  exportId: 'langfuse',
  definitions,
  // Its own exporter: an exporter sends one request at a time.
  sink: langfuseTraceExporter({ publicKey, secretKey, region: 'eu', serviceName: 'orders' }).sink,
});

const worker = createWorkflowWorker({
  units: [host, workflowTraces.unit({ targets: [lifecycleFleetTarget(host.runtime)] })],
  leadership,
});

// Where you submit runs: track them, so fast runs are not missed between discovery passes.
await workflowTraces.track(run.id);
```

`host`, `store`, `scope`, `definitions` and `leadership` are your worker's, as in
[Durable workflows](../../../docs/guides/durable-workflows.md). The unit flushes every second by default, and
`workflowTraces.flush()` does the same on demand.

To see what an agent did inside a step, project its run with the step as parent. In the step's tool, where `context`
is the tool's execution context:

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { workflowStepTraceContext } from 'mayura/workflows';

const spans = agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? [], { parent: workflowStepTraceContext(context) });
```

Langfuse then shows the workflow, its steps, and under a step the agent with its model and tool calls, as one tree. The
research-team starter (see [mayura init](../../../docs/cli/init.md)) wires this up in `src/telemetry.ts`, including a
bounded queue so telemetry never blocks or fails a step.

## 7. Delivery, limits and failures

The exporter is deliberately plain, so you know exactly what it does:

- **One `sink` call is one HTTP request** of at most 256 spans (`maxBatchSize`). Split larger lists across calls.
- **One request at a time.** A second call while one is in flight is refused with `CONFLICT`. Give each producer, such
  as the agent path and the workflow export, its own exporter.
- **No retries, no redirects.** A failed batch is dropped and counted. If you need retries, batching or fan-out to
  several backends, run an OpenTelemetry Collector and point Mayura at it instead.
- **Bounded.** 5 seconds per request (`timeoutMs`), 1 MiB per request body, 64 KiB per reply read.

Failures are `MayuraError`s with a code, and none repeats your keys or Langfuse's reply text. `INVALID_CONFIG` comes
when you call `langfuseTraceExporter()` with a malformed key, an unknown region or a bad URL, before anything is sent.
`TOOL_FAILED` means Langfuse answered with something other than HTTP 200, for example 401 for wrong keys. `TIMEOUT`
and `CANCELLED` mean what they say. `inspect()` returns counts of attempted, accepted and dropped spans, partial
rejections, failures and timeouts; it never shows headers or keys.

Telemetry should never fail the work it describes. Catch errors from `sink`, watch `inspect().metrics` instead, and
treat traces as best effort. For records you must keep, write to your own storage.

## 8. With your own OpenTelemetry SDK

If your application already runs an OpenTelemetry SDK, you can send Mayura's spans through it instead of a second
exporter, so they share your resource, sampler and processors and hang under your request spans.
`createOpenTelemetryTraceBridge` takes the same spans and needs `@opentelemetry/api` 1.9.1 or a later 1.x. Langfuse's
own `LangfuseSpanProcessor` then sends them on:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';
import { LangfuseSpanProcessor, isDefaultExportSpan } from '@langfuse/otel';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { createOpenTelemetryTraceBridge } from 'mayura/exporter-otlp/opentelemetry';

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor({
    // Langfuse's default filter keeps spans with gen_ai.* attributes; Mayura's workflow spans have none.
    shouldExportSpan: ({ otelSpan }) => isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name === 'orders-agent',
  })],
});
sdk.start();

const traces = createOpenTelemetryTraceBridge({ tracer: trace.getTracer('orders-agent') });
await traces.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

The filter matters. Langfuse's span processor exports, by default, only spans from its own SDK, spans with at least
one `gen_ai.*` attribute, and spans from known LLM libraries. Mayura's agent, model and tool spans carry GenAI
attributes and pass. Workflow and step spans do not, so without the extra condition they are dropped and the agent
spans lose their parents. Spans made through the bridge carry your tracer's name as their instrumentation scope, which
is what the condition matches.

Use the bridge when you want one telemetry pipeline. Use `@mayurajs/observability-langfuse` when you want nothing but
Mayura's traces in Langfuse, with no SDK to set up, or on a runtime where you do not run one.

## How it is tested

Unit tests run the exporter against a fake `fetch` that checks the endpoint for each region and a self-hosted URL, the
authorization and ingestion-version headers, and that the body carries the GenAI attributes; they also check refused
keys and URLs, rejected and cancelled requests, and that no error or `inspect()` result contains the secret key. A
live check sent one agent run's spans to Langfuse Cloud, and Langfuse accepted them on October 6, 2026. See
[Langfuse tracing](../../../docs/integrations/observability-langfuse.md#how-it-is-tested).

## Next steps

- [Langfuse tracing](../../../docs/integrations/observability-langfuse.md): every option and error.
- [Observability](../../../docs/guides/observability.md): observers, OTLP exporters, metrics and other providers.
- [Build a refund agent with human approval](../guides/refund-approval.md): a workflow worth tracing.

## Sources

- Langfuse, [OpenTelemetry integration](https://langfuse.com/integrations/native/opentelemetry): endpoint, regions,
  Basic authentication, `x-langfuse-ingestion-version`, attribute mapping, and self-hosting from v3.22.0.
- Langfuse, [Token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking): cost
  inferred from model definitions, for generation and embedding observations.
- Langfuse, [Advanced features](https://langfuse.com/docs/observability/sdk/advanced-features): the
  `LangfuseSpanProcessor` default filter, `shouldExportSpan` and `isDefaultExportSpan`.
