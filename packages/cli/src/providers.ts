// Model provider settings the starters read, so `mayura init` can ask for them once and write the project's `.env`.
// The key is written only to that file (owner-only, ignored by git) and is never printed, returned or put in a plan.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type StarterProvider = 'openai' | 'anthropic';
export const PROVIDERS: readonly Readonly<{ id: 'offline' | StarterProvider; label: string; hint: string; keyVariable?: string; defaultModel?: string }>[] = Object.freeze([
  { id: 'offline', label: 'Offline', hint: 'rule-based stand-in models, no key, no network: good for a first look' },
  { id: 'openai', label: 'OpenAI', hint: 'needs an API key', keyVariable: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', hint: 'needs an API key', keyVariable: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5' },
]);

export interface ProviderChoice {
  readonly provider: StarterProvider; readonly apiKey: string; readonly model: string;
  /** Micro-dollars per million tokens. */
  readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number;
  /** The most one model call, and one agent run, may cost, in micro-dollars. */
  readonly maxCallCostMicros: number; readonly maxRunCostMicros: number;
}

export const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
/** Dollars as typed ("3", "0.25") to micro-dollars; undefined when it is not a plain positive amount. */
export function dollarsToMicros(value: string | undefined): number | undefined {
  const text = (value ?? '').trim().replace(/^\$/u, '');
  if (!/^\d{1,9}(?:\.\d{1,6})?$/u.test(text)) return undefined;
  const micros = Math.round(Number(text) * 1_000_000); return micros > 0 ? micros : undefined;
}
export const validKey = (value: string | undefined): boolean => typeof value === 'string' && /^[\x21-\x7e]{8,4096}$/u.test(value);

/** The `.env` text for a starter. Only this module handles the key, and only to write it here. */
export function providerEnvironment(choice: ProviderChoice): string {
  const keyVariable = PROVIDERS.find(item => item.id === choice.provider)!.keyVariable!;
  return [
    '# Written by mayura init for local development. It holds your API key: keep it private and never commit it',
    '# (.gitignore excludes it). Production reads these settings from its own environment instead.',
    `MAYURA_MODEL_PROVIDER=${choice.provider}`,
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
