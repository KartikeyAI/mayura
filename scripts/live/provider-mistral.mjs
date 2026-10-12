// Live check of @mayurajs/provider-mistral against Mistral: a structured answer and a tool call, priced from the
// package's catalog. Run after pnpm build:
//   node --env-file=.env.live scripts/live/provider-mistral.mjs  (needs MISTRAL_API_KEY; MISTRAL_MODEL, default ministral-8b-2512, which free keys may call)
import { modelChecks, report } from './model-checks.mjs';
const { mistral } = await import(new URL('../../extensions/provider-mistral/dist/index.js', import.meta.url).href);

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) { console.log('MISTRAL_API_KEY is not set; nothing run.'); process.exit(2); }
report(await modelChecks({ provider: mistral({ apiKey }), modelId: `mistral/${process.env.MISTRAL_MODEL || 'ministral-8b-2512'}` }));
