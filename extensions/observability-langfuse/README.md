# @mayurajs/observability-langfuse

[Langfuse](https://langfuse.com) for Mayura's traces (`mayura/exporter-otlp`), through Langfuse's OpenTelemetry endpoint.

```bash
npm install mayura @mayurajs/observability-langfuse
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { langfuseTraceExporter } from '@mayurajs/observability-langfuse';

const langfuse = langfuseTraceExporter({ publicKey, secretKey, region: 'eu', serviceName: 'support-agent' });
await langfuse.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- Regions `eu` (the default), `us`, `jp` and `hipaa`, or `baseUrl` for a self-hosted Langfuse (v3.22.0 or later).
- Langfuse reads the OpenTelemetry GenAI attributes on Mayura's spans: runs show as agent traces with their model and
  tool calls, models and token usage. Spans are metadata only, so traces carry no prompts or outputs.
- The `sink` also works as the `sink` of `createWorkflowTraceExport`, for durable workflow runs.
- Keys are passed in; nothing is read from the environment. Every other option is the OTLP trace exporter's.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
