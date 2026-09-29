import { randomBytes } from 'node:crypto';
import { validatedEnvironment } from 'mayura/helpers';
import { z } from 'mayura';

// Every setting comes from the environment and is validated once at startup. Nothing is discovered implicitly:
// no config files, no default credentials, and no provider is contacted unless MAYURA_MODEL_PROVIDER says so.

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 hex digest.');
/** A comma-separated list, so a token can be rotated by listing the old and new digests together. */
const digests = z.string().max(4_096).transform(value => value.split(',').map(entry => entry.trim()).filter(Boolean)).pipe(z.array(sha256).max(16));
const micros = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** 32 to 128 random bytes, hex encoded. `npm run token` prints one. */
const secret = z.string().regex(/^(?:[a-f0-9]{2}){32,128}$/u, 'MAYURA_SESSION_SECRET must be 64 to 256 lowercase hex characters (32+ random bytes).');

const schema = z.object({
  environment: z.enum(['development', 'production']).default('development'),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u).default('support'),
  databaseUrl: z.string().regex(/^postgres(ql)?:\/\//u, 'DATABASE_URL must be a postgres:// URL.').optional(),
  sqlitePath: z.string().min(1).max(1_024).default('.data/support.sqlite'),
  port: z.coerce.number().int().min(0).max(65_535).default(8080),
  bind: z.string().min(1).max(64).default('0.0.0.0'),
  publicOrigin: z.url({ protocol: /^https$/u }).optional(),
  allowedOrigins: z.string().max(4_096).default('').transform(value => value.split(',').map(entry => entry.trim()).filter(Boolean)),
  operatorTokens: digests.default([]),
  sessionSecret: secret.optional(),
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
  // The field for the output-token limit: OpenAI's newer models (also through a gateway) take only max_completion_tokens.
  compatibleTokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  gatewayToken: z.string().min(1).optional(),
  modelName: z.string().min(1).max(128).optional(),
  inputMicrosPerMillionTokens: micros.optional(),
  outputMicrosPerMillionTokens: micros.optional(),
  maxCallCostMicros: micros.default(0),
  maxRunCostMicros: micros.default(0),
  returnReminderHours: z.coerce.number().int().min(0).max(24 * 90).default(72),
});

export type ModelSettings =
  | { readonly provider: 'offline' }
  // OpenAI or Anthropic directly, or through a gateway: its endpoint (MAYURA_MODEL_ENDPOINT) and token.
  | { readonly provider: 'openai' | 'anthropic'; readonly apiKey: string | undefined; readonly name: string; readonly maxCallCostMicros: number;
    readonly endpoint: string | undefined; readonly gatewayToken: string | undefined;
    readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number } }
  | { readonly provider: 'compatible'; readonly apiKey: string | undefined; readonly name: string; readonly maxCallCostMicros: number;
    readonly endpoint: string; readonly providerId: string; readonly auth: 'bearer' | 'api-key';
    readonly output: 'json_schema' | 'json_object'; readonly strictTools: boolean; readonly gatewayToken: string | undefined;
    readonly tokenLimitField: 'max_tokens' | 'max_completion_tokens' | undefined;
    readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number } };

export interface Config {
  readonly environment: 'development' | 'production';
  readonly projectId: string;
  /**
   * The service's own scope: durable return follow-ups and operator commands live here. Customer chats never run in
   * it; each signed-in customer gets their own scope (see src/auth.ts).
   */
  readonly scope: { readonly principalId: string; readonly projectId: string };
  readonly storage: { readonly kind: 'sqlite'; readonly filename: string } | { readonly kind: 'postgres'; readonly connectionString: string };
  readonly server: { readonly port: number; readonly bind: string; readonly publicOrigin?: string; readonly allowedOrigins: readonly string[] };
  readonly operatorTokens: readonly string[];
  /** HMAC key for customer session tokens. Generated per process in development when not configured. */
  readonly sessionSecret: Buffer;
  readonly model: ModelSettings;
  readonly maxRunCostMicros: number;
  /** How long after a return is opened the customer is reminded to ship it, if it is still outstanding. */
  readonly returnReminderMs: number;
}

export async function loadConfig(source: Readonly<Record<string, string | undefined>> = process.env): Promise<Config> {
  const value = await validatedEnvironment({
    source,
    schema,
    fields: {
      environment: 'MAYURA_ENV', projectId: 'MAYURA_PROJECT', databaseUrl: 'DATABASE_URL', sqlitePath: 'MAYURA_SQLITE_PATH',
      port: 'PORT', bind: 'MAYURA_BIND', publicOrigin: 'MAYURA_PUBLIC_ORIGIN', allowedOrigins: 'MAYURA_ALLOWED_ORIGINS',
      operatorTokens: 'MAYURA_OPERATOR_TOKEN_SHA256', sessionSecret: 'MAYURA_SESSION_SECRET',
      modelProvider: 'MAYURA_MODEL_PROVIDER', openaiApiKey: 'OPENAI_API_KEY', anthropicApiKey: 'ANTHROPIC_API_KEY',
      compatibleEndpoint: 'MAYURA_MODEL_ENDPOINT', compatibleId: 'MAYURA_MODEL_PROVIDER_ID', compatibleAuth: 'MAYURA_MODEL_AUTH', compatibleApiKey: 'MAYURA_MODEL_API_KEY',
      compatibleOutput: 'MAYURA_MODEL_OUTPUT', compatibleStrictTools: 'MAYURA_MODEL_STRICT_TOOLS', compatibleTokenLimitField: 'MAYURA_MODEL_TOKEN_LIMIT_FIELD', gatewayToken: 'MAYURA_MODEL_GATEWAY_TOKEN', modelName: 'MAYURA_MODEL',
      inputMicrosPerMillionTokens: 'MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS', outputMicrosPerMillionTokens: 'MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS',
      maxCallCostMicros: 'MAYURA_MODEL_MAX_CALL_COST_MICROS', maxRunCostMicros: 'MAYURA_MAX_RUN_COST_MICROS', returnReminderHours: 'RETURN_REMINDER_HOURS',
    },
  });
  if (value.environment === 'production') {
    if (!value.publicOrigin) throw new Error('MAYURA_PUBLIC_ORIGIN (https://...) is required in production.');
    if (value.operatorTokens.length === 0) throw new Error('MAYURA_OPERATOR_TOKEN_SHA256 is required in production; run `npm run token`.');
    // Every server replica must verify the sessions your backend mints, so the key is configured, never generated.
    if (!value.sessionSecret) throw new Error('MAYURA_SESSION_SECRET is required in production; run `npm run token` and use its `sessionSecret`.');
  }
  return {
    environment: value.environment,
    projectId: value.projectId,
    scope: { principalId: 'support-service', projectId: value.projectId },
    storage: value.databaseUrl ? { kind: 'postgres', connectionString: value.databaseUrl } : { kind: 'sqlite', filename: value.sqlitePath },
    server: { port: value.port, bind: value.bind, allowedOrigins: value.allowedOrigins, ...(value.publicOrigin ? { publicOrigin: value.publicOrigin.replace(/\/$/u, '') } : {}) },
    operatorTokens: value.operatorTokens,
    // Development without a configured key: sessions minted by another process (or before a restart) stop verifying.
    sessionSecret: value.sessionSecret ? Buffer.from(value.sessionSecret, 'hex') : randomBytes(32),
    model: modelSettings(value),
    maxRunCostMicros: value.maxRunCostMicros,
    returnReminderMs: value.returnReminderHours * 3_600_000,
  };
}

function modelSettings(value: z.infer<typeof schema>): ModelSettings {
  if (value.modelProvider === 'offline') return { provider: 'offline' };
  const apiKey = value.modelProvider === 'openai' ? value.openaiApiKey : value.modelProvider === 'anthropic' ? value.anthropicApiKey : value.compatibleApiKey;
  const keyName = value.modelProvider === 'openai' ? 'OPENAI_API_KEY' : value.modelProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MAYURA_MODEL_API_KEY';
  if (value.modelProvider === 'compatible' && (!value.compatibleEndpoint || !value.compatibleId)) {
    throw new Error('MAYURA_MODEL_PROVIDER=compatible requires MAYURA_MODEL_ENDPOINT (the https://.../chat/completions URL) and MAYURA_MODEL_PROVIDER_ID (such as groq).');
  }
  // A gateway with a token may hold the provider key itself: the compatible endpoint, or OpenAI's or Anthropic's through
  // a gateway endpoint.
  const gatewayOnly = value.gatewayToken !== undefined && (value.modelProvider === 'compatible' || value.compatibleEndpoint !== undefined);
  if ((!apiKey && !gatewayOnly) || !value.modelName || value.inputMicrosPerMillionTokens === undefined || value.outputMicrosPerMillionTokens === undefined || value.maxCallCostMicros === 0) {
    throw new Error(`MAYURA_MODEL_PROVIDER=${value.modelProvider} requires ${keyName}, MAYURA_MODEL, both MAYURA_MODEL_*_MICROS_PER_MILLION_TOKENS prices and MAYURA_MODEL_MAX_CALL_COST_MICROS.`);
  }
  if (value.maxRunCostMicros < value.maxCallCostMicros) throw new Error('MAYURA_MAX_RUN_COST_MICROS must cover at least one model call.');
  const pricing = { inputMicrosPerMillionTokens: value.inputMicrosPerMillionTokens, outputMicrosPerMillionTokens: value.outputMicrosPerMillionTokens };
  if (value.modelProvider === 'compatible') return { provider: 'compatible', apiKey, name: value.modelName, maxCallCostMicros: value.maxCallCostMicros,
    endpoint: value.compatibleEndpoint!, providerId: value.compatibleId!, auth: value.compatibleAuth, pricing,
    output: value.compatibleOutput, strictTools: value.compatibleStrictTools === 'true', gatewayToken: value.gatewayToken,
    tokenLimitField: value.compatibleTokenLimitField };
  return { provider: value.modelProvider, apiKey, name: value.modelName, maxCallCostMicros: value.maxCallCostMicros, pricing,
    endpoint: value.compatibleEndpoint, gatewayToken: value.gatewayToken };
}
