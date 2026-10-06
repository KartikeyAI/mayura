// Live check of @mayurajs/observability-posthog: one agent run's spans accepted by PostHog's AI events endpoint. Run
// after pnpm build:  node --env-file=.env.live scripts/live/observability-posthog.mjs
// (needs POSTHOG_PROJECT_TOKEN; POSTHOG_REGION, default us)
import { exportCheck, report } from './trace-checks.mjs';
const { posthogTraceExporter } = await import(new URL('../../extensions/observability-posthog/dist/index.js', import.meta.url).href);

const { POSTHOG_PROJECT_TOKEN: projectToken, POSTHOG_REGION: given = 'us' } = process.env;
// The dashboard calls them US Cloud and EU Cloud.
const region = /^eu/iu.test(given.trim()) ? 'eu' : /^us/iu.test(given.trim()) ? 'us' : given;
if (!projectToken) { console.log('POSTHOG_PROJECT_TOKEN is not set; nothing run.'); process.exit(2); }
const results = [];
await exportCheck(results, `PostHog (${region}) accepts an agent run's spans`, fetch => posthogTraceExporter({ projectToken, region, serviceName: 'mayura-live-check', fetch }));
report(results);
