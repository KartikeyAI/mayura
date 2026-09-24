# `@mayura/exporter-otlp`

Experimental, optional OTLP/HTTP JSON log export for admitted `@mayura/observability` metadata events.

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

Requests and responses are bounded, delivery is single-flight, response bodies are never exposed, and partial OTLP rejection is counted separately. Observer `sinkDelivered` means the callback settled successfully; use `exporter.inspect()` for remote accepted/dropped record counts. This adapter exports logs only. It is not durable audit, a trace/metric exporter, delivery-once storage, or a substitute for a local OpenTelemetry Collector.
