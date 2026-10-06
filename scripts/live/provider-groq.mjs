// Live check of @mayurajs/provider-groq against Groq: a structured answer and a tool call, priced from the package's
// catalog. Run after pnpm build:
//   node --env-file=.env.live scripts/live/provider-groq.mjs  (needs GROQ_API_KEY; GROQ_MODEL, default openai/gpt-oss-120b)
import { modelChecks, report } from './model-checks.mjs';
const { groq } = await import(new URL('../../extensions/provider-groq/dist/index.js', import.meta.url).href);

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) { console.log('GROQ_API_KEY is not set; nothing run.'); process.exit(2); }
report(await modelChecks({ provider: groq({ apiKey }), modelId: `groq/${process.env.GROQ_MODEL || 'openai/gpt-oss-120b'}` }));
