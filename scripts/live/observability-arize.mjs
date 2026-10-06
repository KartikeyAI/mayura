// Live check of @mayurajs/observability-arize: one agent run's spans accepted by Arize AX (JSON, with OpenInference
// attributes) and by Phoenix (protobuf). Run after pnpm build:
//   node --env-file=.env.live scripts/live/observability-arize.mjs
// Arize AX needs ARIZE_SPACE_ID and ARIZE_API_KEY (ARIZE_REGION, default us); Phoenix needs PHOENIX_COLLECTOR_ENDPOINT
// (and PHOENIX_API_KEY for Phoenix Cloud). Each runs when its variables are set.
import { exportCheck, report } from './trace-checks.mjs';
const { arizeTraceExporter, phoenixTraceExporter } = await import(new URL('../../extensions/observability-arize/dist/index.js', import.meta.url).href);

const { ARIZE_SPACE_ID: spaceId, ARIZE_API_KEY: apiKey, ARIZE_REGION: region = 'us', PHOENIX_COLLECTOR_ENDPOINT: baseUrl, PHOENIX_API_KEY: phoenixKey } = process.env;
if (!(spaceId && apiKey) && !baseUrl) { console.log('ARIZE_SPACE_ID and ARIZE_API_KEY, or PHOENIX_COLLECTOR_ENDPOINT, are not set; nothing run.'); process.exit(2); }
const results = [];
if (spaceId && apiKey) await exportCheck(results, `Arize AX (${region}) accepts an agent run's spans`, fetch => arizeTraceExporter({ spaceId, apiKey, projectName: 'mayura-live-check', region, serviceName: 'mayura-live-check', fetch }));
if (baseUrl) await exportCheck(results, 'Phoenix accepts an agent run\'s spans', fetch => phoenixTraceExporter({ baseUrl: baseUrl.replace(/\/$/u, ''), ...(phoenixKey ? { apiKey: phoenixKey } : {}), projectName: 'mayura-live-check', serviceName: 'mayura-live-check', fetch }));
report(results);
