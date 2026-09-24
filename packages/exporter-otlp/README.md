# `@mayura/exporter-otlp`

Experimental, optional OTLP/HTTP JSON export for admitted logs plus explicit metadata-only traces and low-cardinality metrics.

The package requires an explicit endpoint and service identity. Import and construction perform no network activity. HTTPS is mandatory except for an explicitly enabled literal-loopback development endpoint. It reads no environment variables, discovers no credentials, follows no redirects, sends no cookies, retries no request, and exposes no configured header through inspection or public errors.

```ts
import { createObserver } from '@mayura/observability';
import { createOtlpHttpJsonLogExporter } from '@mayura/exporter-otlp';

const exporter = createOtlpHttpJsonLogExporter({
  endpoint: 'https://collector.example/v1/logs',
  serviceName: 'orders-agent',
  headers: { Authorization: 'Bearer configured-by-the-application' },
});
const observer = createObserver({ sink: exporter.sink });
```

`createOtlpHttpJsonTraceExporter` accepts strict completed span metadata; `createOtlpHttpJsonMetricExporter` accepts a fixed Mayura metric catalog. Each uses its own `/v1/traces` or `/v1/metrics` endpoint and the same explicit transport controls. Arbitrary attributes and user-defined metric labels are deliberately excluded.

Requests and responses are bounded, delivery is single-flight, response bodies are never exposed, and signal-specific partial OTLP rejection is counted separately. Observer `sinkDelivered` means the callback settled successfully; use each exporter’s `inspect()` for remote accepted/dropped counts. These adapters are not durable audit, delivery-once storage, automatic tracing/aggregation, or a substitute for a local OpenTelemetry Collector.
