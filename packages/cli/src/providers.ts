// Model provider settings the starters read, so `mayura init` can ask for them once and write the project's `.env`.
// The key is written only to that file (owner-only, ignored by git) and is never printed, returned or put in a plan.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type StarterProvider = 'openai' | 'anthropic' | 'compatible';
export type ProviderAuth = 'bearer' | 'api-key';
export interface ProviderOption {
  readonly id: string; readonly label: string; readonly hint: string;
  /** What MAYURA_MODEL_PROVIDER becomes; undefined for offline. */
  readonly provider?: StarterProvider; readonly keyVariable?: string; readonly defaultModel?: string;
  /** OpenAI-compatible presets: a fixed endpoint, or `azure` / `other` to ask for it. */
  readonly endpoint?: string; readonly ask?: 'azure' | 'other'; readonly auth?: ProviderAuth;
}

const compatible = (id: string, label: string, endpoint: string): ProviderOption =>
  ({ id, label, hint: 'OpenAI-compatible', provider: 'compatible', keyVariable: 'MAYURA_MODEL_API_KEY', endpoint, auth: 'bearer' });
/**
 * Offline, the two native adapters, then OpenAI-compatible endpoints as documented in docs/guides/model-providers.md.
 * Mayura has not qualified the compatible ones against live accounts; `pnpm providers:live-check` does that.
 */
export const PROVIDERS: readonly ProviderOption[] = Object.freeze([
  { id: 'offline', label: 'Offline', hint: 'rule-based stand-in models, no key, no network: good for a first look' },
  { id: 'openai', label: 'OpenAI', hint: 'needs an API key', provider: 'openai', keyVariable: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', hint: 'needs an API key', provider: 'anthropic', keyVariable: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5' },
  compatible('groq', 'Groq', 'https://api.groq.com/openai/v1/chat/completions'),
  compatible('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
  compatible('mistral', 'Mistral', 'https://api.mistral.ai/v1/chat/completions'),
  compatible('deepseek', 'DeepSeek', 'https://api.deepseek.com/chat/completions'),
  compatible('xai', 'xAI', 'https://api.x.ai/v1/chat/completions'),
  compatible('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1/chat/completions'),
  compatible('together', 'Together', 'https://api.together.xyz/v1/chat/completions'),
  compatible('fireworks', 'Fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions'),
  { id: 'azure', label: 'Azure OpenAI', hint: 'your resource and deployment', provider: 'compatible', keyVariable: 'MAYURA_MODEL_API_KEY', ask: 'azure', auth: 'api-key' },
  { id: 'other', label: 'Another OpenAI-compatible provider', hint: 'any HTTPS /chat/completions endpoint', provider: 'compatible', keyVariable: 'MAYURA_MODEL_API_KEY', ask: 'other', auth: 'bearer' },
]);

export interface ProviderChoice {
  readonly provider: StarterProvider; readonly apiKey: string; readonly model: string;
  /** For `compatible`: the endpoint, a short id naming its adapter, and how it takes the key. */
  readonly compatible?: { readonly id: string; readonly endpoint: string; readonly auth: ProviderAuth };
  /** Micro-dollars per million tokens. */
  readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number;
  /** The most one model call, and one agent run, may cost, in micro-dollars. */
  readonly maxCallCostMicros: number; readonly maxRunCostMicros: number;
}

export const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
export const providerIdPattern = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** Dollars as typed ("3", "0.25") to micro-dollars; undefined when it is not a plain positive amount. */
export function dollarsToMicros(value: string | undefined): number | undefined {
  const text = (value ?? '').trim().replace(/^\$/u, '');
  if (!/^\d{1,9}(?:\.\d{1,6})?$/u.test(text)) return undefined;
  const micros = Math.round(Number(text) * 1_000_000); return micros > 0 ? micros : undefined;
}
export const validKey = (value: string | undefined): boolean => typeof value === 'string' && /^[\x21-\x7e]{8,4096}$/u.test(value);

/**
 * The same rule as the compatible adapter: an HTTPS URL ending in `/chat/completions`, not a loopback address, with no
 * credentials or fragment and at most an `api-version` query. Returns a reason when it is not.
 */
export function endpointProblem(value: string | undefined): string | undefined {
  let url: URL; try { url = new URL((value ?? '').trim()); } catch { return 'Enter the full https:// URL.'; }
  const query = [...url.searchParams.keys()];
  if (url.protocol !== 'https:') return 'The endpoint must use https://.';
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'For a local server, use openAICompatibleChat without remote in your own code.';
  if (url.username || url.password || url.hash) return 'Leave credentials and #fragments out of the URL; the key goes in the next question.';
  if (!url.pathname.endsWith('/chat/completions')) return 'The endpoint must end in /chat/completions.';
  if (query.length > 1 || query.some(key => key !== 'api-version') || (query.length === 1 && !/^[0-9A-Za-z.-]{1,32}$/u.test(url.searchParams.get('api-version')!))) {
    return 'Only an api-version query is allowed.';
  }
  return undefined;
}
/** The Azure OpenAI chat-completions URL for a resource, deployment and API version. */
export function azureEndpoint(resource: string, deployment: string, apiVersion: string): string {
  return `https://${resource}.openai.azure.com/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

/** The `.env` text for a starter. Only this module handles the key, and only to write it here. */
export function providerEnvironment(choice: ProviderChoice): string {
  const keyVariable = choice.provider === 'openai' ? 'OPENAI_API_KEY' : choice.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MAYURA_MODEL_API_KEY';
  return [
    '# Written by mayura init for local development. It holds your API key: keep it private and never commit it',
    '# (.gitignore excludes it). Production reads these settings from its own environment instead.',
    `MAYURA_MODEL_PROVIDER=${choice.provider}`,
    ...(choice.compatible ? [`MAYURA_MODEL_PROVIDER_ID=${choice.compatible.id}`, `MAYURA_MODEL_ENDPOINT=${choice.compatible.endpoint}`,
      `MAYURA_MODEL_AUTH=${choice.compatible.auth}`] : []),
    `${keyVariable}=${choice.apiKey}`,
    `MAYURA_MODEL=${choice.model}`,
    `MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS=${choice.inputMicrosPerMillionTokens}`,
    `MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS=${choice.outputMicrosPerMillionTokens}`,
    `MAYURA_MODEL_MAX_CALL_COST_MICROS=${choice.maxCallCostMicros}`,
    `MAYURA_MAX_RUN_COST_MICROS=${choice.maxRunCostMicros}`,
    '',
  ].join('\n');
}

/** Write `.env` once. An existing file is left untouched, since it may hold settings the person wants to keep. */
export async function writeProviderEnvironment(directory: string, choice: ProviderChoice): Promise<'written' | 'exists'> {
  try { await writeFile(join(directory, '.env'), providerEnvironment(choice), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return 'written'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'; throw error; }
}
