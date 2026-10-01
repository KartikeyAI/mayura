# @mayurajs/observability-sentry

[Sentry](https://sentry.io) for Mayura's traces (`mayura/exporter-otlp`), through Sentry's OTLP endpoint.

```bash
npm install mayura @mayurajs/observability-sentry
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { sentryTraceExporter } from '@mayurajs/observability-sentry';

const sentry = sentryTraceExporter({ dsn, serviceName: 'support-agent' });
await sentry.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- `dsn` is the project's DSN, from its Client Keys settings. The endpoint comes from it, so any Sentry region and
  self-hosted Sentry work; only its public key is sent. A legacy DSN's secret key is never sent.
- Agent, model and tool spans carry Sentry's span ops (`gen_ai.invoke_agent`, `gen_ai.chat`, `gen_ai.execute_tool`)
  beside their GenAI attributes. `sentryAttributes` is exported to reuse the mapping.
- Spans are metadata only, so traces carry no prompts or outputs.
- Sentry's OTLP ingestion is in beta at Sentry, and takes traces and logs, not metrics.
- The `sink` also works as the `sink` of `createWorkflowTraceExport`, for durable workflow runs.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
