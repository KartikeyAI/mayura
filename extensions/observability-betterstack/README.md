# @mayurajs/observability-betterstack

[Better Stack](https://betterstack.com) for Mayura's traces (`mayura/exporter-otlp`), through a source's OpenTelemetry
endpoint.

```bash
npm install mayura @mayurajs/observability-betterstack
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { betterStackTraceExporter } from '@mayurajs/observability-betterstack';

const betterStack = betterStackTraceExporter({ sourceToken, ingestingHost: 's1234.eu-nbg-2.betterstackdata.com', serviceName: 'support-agent' });
await betterStack.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- Create an OpenTelemetry source in Better Stack; `sourceToken` and `ingestingHost` come from its settings.
- Spans carry their GenAI and Mayura attributes (model, provider, token counts, cost, statuses) to query and chart.
  They are metadata only, so traces carry no prompts or outputs.
- The `sink` also works as the `sink` of `createWorkflowTraceExport`, for durable workflow runs.
- The token is passed in; nothing is read from the environment. Every other option is the OTLP trace exporter's.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
