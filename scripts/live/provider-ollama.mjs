// Live check of @mayurajs/provider-ollama against a local Ollama or Ollama's cloud: a structured answer and a tool call.
// Ollama has no catalog, so the model is priced at zero. Run after pnpm build:
//   node --env-file=.env.live scripts/live/provider-ollama.mjs
// OLLAMA_BASE_URL is the host (http://127.0.0.1:11434 by default; https://ollama.com with OLLAMA_API_KEY for cloud
// models); OLLAMA_MODEL is the model, gpt-oss:20b by default, already pulled for a local host.
import { modelChecks, report } from './model-checks.mjs';
const { ollama } = await import(new URL('../../extensions/provider-ollama/dist/index.js', import.meta.url).href);

const host = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const apiKey = process.env.OLLAMA_API_KEY || undefined;
const model = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
try { await fetch(new URL('/api/version', host), { signal: AbortSignal.timeout(5_000) }); }
catch { console.log(`Ollama is not reachable at ${new URL(host).origin}; nothing run.`); process.exit(2); }
console.log(`  host ${new URL(host).origin}, model ${model}`);
report(await modelChecks({
  provider: ollama({ host, apiKey }), modelId: `ollama/${model}`,
  prices: { [`ollama/${model}`]: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } },
}));
