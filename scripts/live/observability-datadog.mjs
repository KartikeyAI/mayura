// Live check of @mayurajs/observability-datadog: one agent run's spans accepted by Datadog's OTLP intake, as APM traces
// and in LLM Observability. Run after pnpm build:
//   node --env-file=.env.live scripts/live/observability-datadog.mjs
// Needs DD_API_KEY; DD_SITE (datadoghq.com by default) and DD_LLMOBS_ML_APP (mayura-live-check by default).
import { exportCheck, report } from './trace-checks.mjs';
const { datadogTraceExporter } = await import(new URL('../../extensions/observability-datadog/dist/index.js', import.meta.url).href);

const { DD_API_KEY: apiKey, DD_SITE: site = 'datadoghq.com', DD_LLMOBS_ML_APP: mlApp = 'mayura-live-check' } = process.env;
if (!apiKey) { console.log('DD_API_KEY is not set; nothing run.'); process.exit(2); }
const results = [];
await exportCheck(results, `Datadog (${site}) APM accepts an agent run's spans`, fetch => datadogTraceExporter({ apiKey, site, serviceName: 'mayura-live-check', fetch }));
await exportCheck(results, `Datadog (${site}) LLM Observability accepts an agent run's spans`, fetch => datadogTraceExporter({ apiKey, site, serviceName: 'mayura-live-check', llmObservability: { mlApp }, fetch }));
report(results);
