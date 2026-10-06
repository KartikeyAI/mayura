// Live check of @mayurajs/observability-langfuse: one agent run's spans accepted by Langfuse. Run after pnpm build:
//   node --env-file=.env.live scripts/live/observability-langfuse.mjs  (needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY; LANGFUSE_REGION, default eu)
import { exportCheck, report } from './trace-checks.mjs';
const { langfuseTraceExporter } = await import(new URL('../../extensions/observability-langfuse/dist/index.js', import.meta.url).href);

const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_REGION: region = 'eu' } = process.env;
if (!publicKey || !secretKey) { console.log('LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is not set; nothing run.'); process.exit(2); }
const results = [];
await exportCheck(results, `Langfuse (${region}) accepts an agent run's spans`, fetch => langfuseTraceExporter({ publicKey, secretKey, region, serviceName: 'mayura-live-check', fetch }));
report(results);
