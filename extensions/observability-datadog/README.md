# @mayurajs/observability-datadog

[Datadog](https://www.datadoghq.com) APM or LLM Observability for Mayura's traces (`mayura/exporter-otlp`), through
Datadog's OTLP intake. No Datadog Agent is needed.

```bash
npm install mayura @mayurajs/observability-datadog
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { datadogTraceExporter } from '@mayurajs/observability-datadog';

const datadog = datadogTraceExporter({ apiKey, site: 'datadoghq.eu', llmObservability: { mlApp: 'support-bot' }, serviceName: 'support-agent' });
await datadog.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- `site` is your Datadog site, `datadoghq.com` (US1) by default.
- Without `llmObservability`, runs go to APM as traces with their model and tool calls. With it, Datadog reads the
  GenAI attributes on Mayura's spans and shows agent, LLM and tool spans with models and token usage; `mlApp` names
  the application (the service name by default). LLM Observability keeps only spans with GenAI attributes, so
  workflow spans stay in APM. It is not available on `ddog-gov.com`.
- Spans are metadata only, so traces carry no prompts or outputs.
- Traces only: Datadog's OTLP metric intake takes delta sums, and Mayura's metric exporter sends cumulative ones.
- The key is passed in; nothing is read from the environment. Every other option is the OTLP trace exporter's.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
