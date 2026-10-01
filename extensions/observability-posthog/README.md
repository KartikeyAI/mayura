# @mayurajs/observability-posthog

[PostHog](https://posthog.com) LLM analytics for Mayura's traces (`mayura/exporter-otlp`), through PostHog's
OpenTelemetry endpoint for AI events.

```bash
npm install mayura @mayurajs/observability-posthog
```

```ts
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { posthogTraceExporter } from '@mayurajs/observability-posthog';

const posthog = posthogTraceExporter({ projectToken, region: 'eu', serviceName: 'support-agent' });
await posthog.sink(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? []), { signal: AbortSignal.timeout(10_000) });
```

- Regions `us` (the default) and `eu`. `projectToken` is the project's API token (`phc_…`).
- PostHog turns model calls into `$ai_generation` events with their model, provider and token counts, runs and tool
  calls into `$ai_span` events, and each trace into an `$ai_trace`. Spans are metadata only, so events carry no
  prompts or outputs.
- `distinctId` sets `posthog.distinct_id`, the person the events belong to. It applies to everything the exporter
  sends: use one exporter per person, or leave it out for anonymous events.
- Traces only; PostHog's AI endpoint takes up to 4 MB per request.

See the [observability guide](https://mayurajs.com/docs/guides/observability/). Apache-2.0.
