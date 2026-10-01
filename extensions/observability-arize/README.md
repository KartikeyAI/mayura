# @mayurajs/observability-arize

[Arize AX](https://arize.com) and [Phoenix](https://phoenix.arize.com) for Mayura's traces (`mayura/exporter-otlp`), with
OpenInference attributes beside the OpenTelemetry GenAI ones.

```bash
npm install mayura @mayurajs/observability-arize
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { arizeTraceExporter } from '@mayurajs/observability-arize';

const arize = arizeTraceExporter({ spaceId, apiKey, projectName: 'support-agent', region: 'us', serviceName: 'support-agent' });
await arize.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- Regions `us` (the default), `eu` and `ca`. `projectName` is a stable identifier, such as `support-agent`.
- Each span carries `openinference.span.kind` (`AGENT` for runs, `LLM` for model calls, `TOOL` for tool calls,
  `CHAIN` otherwise), the model and provider, token counts, and tool and agent names, so runs show as agent traces.
  `openInferenceAttributes` is exported for other OpenInference backends' OTLP exporters (`spanAttributes`).
- Spans are metadata only, so traces carry no prompts or outputs.

## Phoenix

```ts
import { phoenixTraceExporter } from '@mayurajs/observability-arize';

// A Phoenix Cloud space; or a self-hosted Phoenix, such as http://127.0.0.1:6006 with allowInsecureLoopback: true.
const phoenix = phoenixTraceExporter({ baseUrl: 'https://app.phoenix.arize.com/s/acme', apiKey, projectName: 'support-agent', serviceName: 'support-agent' });
```

- Phoenix takes only OTLP's protobuf encoding, so this exporter sends protobuf, with the same OpenInference attributes.
- `apiKey` is needed when Phoenix's authentication is on (always on Phoenix Cloud).
- The `sink` also works as the `sink` of `createWorkflowTraceExport`, for durable workflow runs.
- Credentials are passed in; nothing is read from the environment. Every other option is the OTLP trace exporter's.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
