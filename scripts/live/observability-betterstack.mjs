// Live check of @mayurajs/observability-betterstack: one agent run's spans accepted by a Better Stack source. Run after
// pnpm build:  node --env-file=.env.live scripts/live/observability-betterstack.mjs
// (needs BETTERSTACK_SOURCE_TOKEN and BETTERSTACK_INGESTING_HOST)
import { exportCheck, report } from './trace-checks.mjs';
const { betterStackTraceExporter } = await import(new URL('../../extensions/observability-betterstack/dist/index.js', import.meta.url).href);

const { BETTERSTACK_SOURCE_TOKEN: sourceToken, BETTERSTACK_INGESTING_HOST: host } = process.env;
if (!sourceToken || !host) { console.log('BETTERSTACK_SOURCE_TOKEN or BETTERSTACK_INGESTING_HOST is not set; nothing run.'); process.exit(2); }
const ingestingHost = host.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');
const results = [];
await exportCheck(results, 'Better Stack accepts an agent run\'s spans', fetch => betterStackTraceExporter({ sourceToken, ingestingHost, serviceName: 'mayura-live-check', fetch }));
report(results);
