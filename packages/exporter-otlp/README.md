# `mayura/exporter-otlp`

Experimental, optional OTLP/HTTP JSON export for admitted logs plus explicit metadata-only traces and low-cardinality metrics.

The package requires an explicit endpoint and service identity. Import and construction perform no network activity. HTTPS is mandatory except for an explicitly enabled literal-loopback development endpoint. It reads no environment variables, discovers no credentials, follows no redirects, sends no cookies, retries no request, and exposes no configured header through inspection or public errors.

```ts
import { createObserver } from 'mayura/observability';
import { createOtlpHttpJsonLogExporter } from 'mayura/exporter-otlp';

const exporter = createOtlpHttpJsonLogExporter({
  endpoint: 'https://collector.example/v1/logs',
  serviceName: 'orders-agent',
  headers: { Authorization: 'Bearer configured-by-the-application' },
});
const observer = createObserver({ sink: exporter.sink });
```

`createOtlpHttpJsonTraceExporter` accepts strict completed span metadata with attributes from a closed catalog of identifiers and integers; `createOtlpHttpJsonMetricExporter` accepts a fixed Mayura metric catalog. Each uses its own `/v1/traces` or `/v1/metrics` endpoint and the same explicit transport controls. Free-form attributes, text values and user-defined metric labels are deliberately excluded.

`agentRunTraceSpans(events, { parent })` projects one agent run's admitted events into deterministic run, `model.call` and `tool:<id>` spans, optionally nested under a parent such as a workflow step (`workflowStepTraceContext` in `mayura/workflows`, whose `createWorkflowTraceExport` exports durable workflow runs through this exporter). See the workspace guide *Trace durable workflow runs*.

Requests and responses are bounded, delivery is single-flight, response bodies are never exposed, and signal-specific partial OTLP rejection is counted separately. Observer `sinkDelivered` means the callback settled successfully; use each exporter’s `inspect()` for remote accepted/dropped counts. These adapters are not durable audit, delivery-once storage, automatic tracing/aggregation, or a substitute for a local OpenTelemetry Collector.

`createOpenTelemetryAuthorization` from `mayura/exporter-otlp/opentelemetry` accepts your existing tracer and/or meter
and exposes an authorization audit sink. Decision spans omit identifiers by default; metrics use only closed effect,
reason and resource-kind labels. Attach it through `audit: { sink: telemetry.sink }` with explicit `authz:audit` grants.
It installs no exporter or sampler, opens no network connection and leaves SDK lifecycle to the application.
