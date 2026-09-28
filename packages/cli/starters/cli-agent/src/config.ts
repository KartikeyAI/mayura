import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatedEnvironment } from 'mayura/helpers';
import { z } from 'zod';

// Every setting comes from the environment and is validated once at startup. Nothing is discovered implicitly: no
// default credentials, and no provider is contacted unless MAYURA_MODEL_PROVIDER says so. `npm run chat` and
// `npm run ask` load the project's .env first (see src/cli.ts); real environment variables win.

const micros = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const schema = z.object({
  root: z.string().min(1).max(1_024).optional(),
  skills: z.string().min(1).max(1_024).optional(),
  modelProvider: z.enum(['offline', 'openai', 'anthropic', 'compatible']).default('offline'),
  openaiApiKey: z.string().min(1).optional(),
  anthropicApiKey: z.string().min(1).optional(),
  // An OpenAI-compatible provider (Groq, Mistral, Azure OpenAI, Gemini, ...): its HTTPS chat-completions endpoint, a short
  // id that names its adapter (`openai-compatible.<id>`), how it takes the key, and the key.
  compatibleEndpoint: z.string().url().max(2_048).optional(),
  compatibleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, 'Use a short lower-case id such as groq.').optional(),
  compatibleAuth: z.enum(['bearer', 'api-key']).default('bearer'),
  compatibleApiKey: z.string().min(1).optional(),
  // How the provider differs from OpenAI: JSON mode instead of JSON Schema output (DeepSeek), strict tool calls, and
  // a Cloudflare AI Gateway token (sent as cf-aig-authorization; with keys stored in the gateway, no API key is needed).
  compatibleOutput: z.enum(['json_schema', 'json_object']).default('json_schema'),
  compatibleStrictTools: z.enum(['true', 'false']).default('false'),
  gatewayToken: z.string().min(1).optional(),
  modelName: z.string().min(1).max(128).optional(),
  inputMicrosPerMillionTokens: micros.optional(),
  outputMicrosPerMillionTokens: micros.optional(),
  maxCallCostMicros: micros.default(0),
  maxRunCostMicros: micros.default(0),
});

export type ModelSettings =
  | { readonly provider: 'offline' }
  | { readonly provider: 'openai' | 'anthropic'; readonly apiKey: string; readonly name: string; readonly maxCallCostMicros: number;
    readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number } }
  | { readonly provider: 'compatible'; readonly apiKey: string | undefined; readonly name: string; readonly maxCallCostMicros: number;
    readonly endpoint: string; readonly providerId: string; readonly auth: 'bearer' | 'api-key';
    readonly output: 'json_schema' | 'json_object'; readonly strictTools: boolean; readonly gatewayToken: string | undefined;
    readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number } };

export interface Config {
  /** The folder the assistant may look at and write to: ASSISTANT_ROOT, or the folder you run it from. */
  readonly root: string;
  /** SKILL.md folders the agent can load: ASSISTANT_SKILLS, or this project's `skills/`. */
  readonly skillsDirectory: string;
  readonly model: ModelSettings;
  /** The most one turn (one agent run) may spend, in micros. 0 is fine offline; a paid model needs more. */
  readonly maxRunCostMicros: number;
}

/** This project's own `skills/` folder, wherever the command is run from. */
export const bundledSkills = fileURLToPath(new URL('../../skills', import.meta.url));

export async function loadConfig(source: Readonly<Record<string, string | undefined>> = process.env, cwd = process.cwd()): Promise<Config> {
  const value = await validatedEnvironment({
    source,
    schema,
    fields: {
      root: 'ASSISTANT_ROOT', skills: 'ASSISTANT_SKILLS',
      modelProvider: 'MAYURA_MODEL_PROVIDER', openaiApiKey: 'OPENAI_API_KEY', anthropicApiKey: 'ANTHROPIC_API_KEY',
      compatibleEndpoint: 'MAYURA_MODEL_ENDPOINT', compatibleId: 'MAYURA_MODEL_PROVIDER_ID', compatibleAuth: 'MAYURA_MODEL_AUTH', compatibleApiKey: 'MAYURA_MODEL_API_KEY',
      compatibleOutput: 'MAYURA_MODEL_OUTPUT', compatibleStrictTools: 'MAYURA_MODEL_STRICT_TOOLS', gatewayToken: 'MAYURA_MODEL_GATEWAY_TOKEN', modelName: 'MAYURA_MODEL',
      inputMicrosPerMillionTokens: 'MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS', outputMicrosPerMillionTokens: 'MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS',
      maxCallCostMicros: 'MAYURA_MODEL_MAX_CALL_COST_MICROS', maxRunCostMicros: 'MAYURA_MAX_RUN_COST_MICROS',
    },
  });
  const root = resolve(cwd, value.root ?? '.');
  if (!isDirectory(root)) throw new Error(`ASSISTANT_ROOT must be an existing folder; ${root} is not.`);
  return {
    root,
    skillsDirectory: value.skills ? resolve(cwd, value.skills) : bundledSkills,
    model: modelSettings(value),
    maxRunCostMicros: value.maxRunCostMicros,
  };
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function modelSettings(value: z.infer<typeof schema>): ModelSettings {
  if (value.modelProvider === 'offline') return { provider: 'offline' };
  const apiKey = value.modelProvider === 'openai' ? value.openaiApiKey : value.modelProvider === 'anthropic' ? value.anthropicApiKey : value.compatibleApiKey;
  const keyName = value.modelProvider === 'openai' ? 'OPENAI_API_KEY' : value.modelProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MAYURA_MODEL_API_KEY';
  if (value.modelProvider === 'compatible' && (!value.compatibleEndpoint || !value.compatibleId)) {
    throw new Error('MAYURA_MODEL_PROVIDER=compatible requires MAYURA_MODEL_ENDPOINT (the https://.../chat/completions URL) and MAYURA_MODEL_PROVIDER_ID (such as groq).');
  }
  const gatewayOnly = value.modelProvider === 'compatible' && value.gatewayToken !== undefined;
  if ((!apiKey && !gatewayOnly) || !value.modelName || value.inputMicrosPerMillionTokens === undefined || value.outputMicrosPerMillionTokens === undefined || value.maxCallCostMicros === 0) {
    throw new Error(`MAYURA_MODEL_PROVIDER=${value.modelProvider} requires ${keyName}, MAYURA_MODEL, both MAYURA_MODEL_*_MICROS_PER_MILLION_TOKENS prices and MAYURA_MODEL_MAX_CALL_COST_MICROS.`);
  }
  if (value.maxRunCostMicros < value.maxCallCostMicros) throw new Error('MAYURA_MAX_RUN_COST_MICROS must cover at least one model call.');
  const pricing = { inputMicrosPerMillionTokens: value.inputMicrosPerMillionTokens, outputMicrosPerMillionTokens: value.outputMicrosPerMillionTokens };
  if (value.modelProvider === 'compatible') return { provider: 'compatible', apiKey, name: value.modelName, maxCallCostMicros: value.maxCallCostMicros,
    endpoint: value.compatibleEndpoint!, providerId: value.compatibleId!, auth: value.compatibleAuth, pricing,
    output: value.compatibleOutput, strictTools: value.compatibleStrictTools === 'true', gatewayToken: value.gatewayToken };
  return { provider: value.modelProvider, apiKey: apiKey!, name: value.modelName, maxCallCostMicros: value.maxCallCostMicros, pricing };
}
