# @mayurajs/observability-langsmith

[LangSmith](https://smith.langchain.com) for Mayura's traces (`mayura/exporter-otlp`), through LangSmith's
OpenTelemetry endpoint.

```bash
npm install mayura @mayurajs/observability-langsmith
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { langSmithTraceExporter } from '@mayurajs/observability-langsmith';

const langsmith = langSmithTraceExporter({ apiKey, project: 'support-agent', region: 'us', serviceName: 'support-agent' });
await langsmith.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- Regions `us` (the default), `eu`, `apac` and `aws-us`, or `baseUrl` for a self-hosted LangSmith's API URL.
- `project` names the project the traces go to; LangSmith's default project when left out.
- Each span carries its LangSmith run type (`langsmith.span.kind`: `llm` for model calls, `tool` for tool calls,
  `chain` for runs) and the provider as `gen_ai.system`, beside its GenAI attributes, so runs show as chains with their
  LLM and tool runs, models and token usage. `langSmithAttributes` is exported to reuse the mapping.
- Spans are metadata only, so traces carry no prompts or outputs.
- The `sink` also works as the `sink` of `createWorkflowTraceExport`, for durable workflow runs.
- The key is passed in; nothing is read from the environment. Every other option is the OTLP trace exporter's.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
