// Live check of @mayurajs/observability-sentry: one agent run's spans accepted by Sentry's OTLP endpoint. Run after
// pnpm build:  node --env-file=.env.live scripts/live/observability-sentry.mjs  (needs SENTRY_DSN)
import { exportCheck, report } from './trace-checks.mjs';
const { sentryTraceExporter } = await import(new URL('../../extensions/observability-sentry/dist/index.js', import.meta.url).href);

const dsn = process.env.SENTRY_DSN;
if (!dsn) { console.log('SENTRY_DSN is not set; nothing run.'); process.exit(2); }
const results = [];
await exportCheck(results, 'Sentry accepts an agent run\'s spans', fetch => sentryTraceExporter({ dsn, serviceName: 'mayura-live-check', fetch }));
report(results);
