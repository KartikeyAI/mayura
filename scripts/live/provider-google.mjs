// Live check of @mayurajs/provider-google against the Gemini API: a structured answer and a tool call, priced from
// the package's catalog. Run after pnpm build:
//   node --env-file=.env.live scripts/live/provider-google.mjs  (needs GEMINI_API_KEY; GEMINI_MODEL, default gemini-3.5-flash)
import { modelChecks, report } from './model-checks.mjs';
const { google } = await import(new URL('../../extensions/provider-google/dist/index.js', import.meta.url).href);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.log('GEMINI_API_KEY is not set; nothing run.'); process.exit(2); }
report(await modelChecks({ provider: google({ apiKey }), modelId: `google/${process.env.GEMINI_MODEL || 'gemini-3.5-flash'}` }));
