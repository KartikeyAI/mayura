import { validatedEnvironment } from '@mayura/helpers';
import { z } from 'zod';

// Every setting comes from the environment and is validated once at startup. Nothing is discovered implicitly:
// no config files, no default credentials, and no provider or collector is contacted unless the environment says so.

/** Research slots in the workflow: the planner may use 2 to this many sub-questions. Changing it changes the definition. */
export const MAX_RESEARCHERS = 4;
/** Agent steps in one research run, each admitted against the run budget at its ceiling: plan, the slots, write. */
export const AGENT_STEPS_PER_RUN = MAX_RESEARCHERS + 2;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 hex digest.');
/** A comma-separated list, so a token can be rotated by listing the old and new digests together. */
const digests = z.string().max(4_096).transform(value => value.split(',').map(entry => entry.trim()).filter(Boolean)).pipe(z.array(sha256).max(16));
const micros = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const schema = z.object({
  environment: z.enum(['development', 'production']).default('development'),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u).default('research'),
  databaseUrl: z.string().regex(/^postgres(ql)?:\/\//u, 'DATABASE_URL must be a postgres:// URL.').optional(),
  sqlitePath: z.string().min(1).max(1_024).default('.data/research-team.sqlite'),
  artifactsDirectory: z.string().min(1).max(1_024).default('.data/artifacts'),
  port: z.coerce.number().int().min(0).max(65_535).default(8080),
  bind: z.string().min(1).max(64).default('0.0.0.0'),
  publicOrigin: z.url({ protocol: /^https$/u }).optional(),
  allowedOrigins: z.string().max(4_096).default('').transform(value => value.split(',').map(entry => entry.trim()).filter(Boolean)),
  operatorTokens: digests.default([]),
  deskTokens: digests.default([]),
  modelProvider: z.enum(['offline', 'openai', 'anthropic', 'compatible']).default('offline'),
  openaiApiKey: z.string().min(1).optional(),
  anthropicApiKey: z.string().min(1).optional(),
  // An OpenAI-compatible provider (Groq, Mistral, Azure OpenAI, Gemini, ...): its HTTPS chat-completions endpoint, a short
  // id that names its adapter (`openai-compatible.<id>`), how it takes the key, and the key.
  compatibleEndpoint: z.string().url().max(2_048).optional(),
  compatibleId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, 'Use a short lower-case id such as groq.').optional(),
  compatibleAuth: z.enum(['bearer', 'api-key']).default('bearer'),
  compatibleApiKey: z.string().min(1).optional(),
  modelName: z.string().min(1).max(128).optional(),
  inputMicrosPerMillionTokens: micros.optional(),
  outputMicrosPerMillionTokens: micros.optional(),
  maxCallCostMicros: micros.default(0),
  maxRunCostMicros: micros.default(0),
  researchBudgetMicros: micros.optional(),
  otlpEndpoint: z.url().max(2_048).optional(),
  otlpHeaders: z.string().max(8_192).optional(),
  serviceName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).default('research-team'),
});

export type ModelSettings =
  | { readonly provider: 'offline' }
  | { readonly provider: 'openai' | 'anthropic'; readonly apiKey: string; readonly name: string; readonly maxCallCostMicros: number;
    readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number } }
  | { readonly provider: 'compatible'; readonly apiKey: string; readonly name: string; readonly maxCallCostMicros: number;
    readonly endpoint: string; readonly providerId: string; readonly auth: 'bearer' | 'api-key';
    readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number } };

/** Where metadata-only traces go. Absent means telemetry is off and nothing is collected. */
export interface TelemetrySettings {
  readonly tracesEndpoint: string;
  readonly serviceName: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Plain HTTP is accepted only for a literal loopback collector (127.0.0.1 or [::1]). */
  readonly allowInsecureLoopback: boolean;
}

export interface Config {
  readonly environment: 'development' | 'production';
  /** Every research run, desk run and operator command lives in this one scope. */
  readonly scope: { readonly principalId: string; readonly projectId: string };
  readonly storage: { readonly kind: 'sqlite'; readonly filename: string } | { readonly kind: 'postgres'; readonly connectionString: string };
  /** Local directory for report artifacts. One node only: see README "Know the limits". */
  readonly artifactsDirectory: string;
  readonly server: { readonly port: number; readonly bind: string; readonly publicOrigin?: string; readonly allowedOrigins: readonly string[] };
  readonly operatorTokens: readonly string[];
  readonly deskTokens: readonly string[];
  readonly model: ModelSettings;
  readonly budget: {
    /** The most any one agent run may spend: each research step, and each desk request. */
    readonly stepMicros: number;
    /** The one shared budget of a whole research run, across the planner, every researcher and the writer. */
    readonly runMicros: number;
  };
  readonly telemetry?: TelemetrySettings;
}

export async function loadConfig(source: Readonly<Record<string, string | undefined>> = process.env): Promise<Config> {
  const value = await validatedEnvironment({
    source,
    schema,
    fields: {
      environment: 'MAYURA_ENV', projectId: 'MAYURA_PROJECT', databaseUrl: 'DATABASE_URL', sqlitePath: 'MAYURA_SQLITE_PATH',
      artifactsDirectory: 'RESEARCH_ARTIFACTS_DIR', port: 'PORT', bind: 'MAYURA_BIND', publicOrigin: 'MAYURA_PUBLIC_ORIGIN',
      allowedOrigins: 'MAYURA_ALLOWED_ORIGINS', operatorTokens: 'MAYURA_OPERATOR_TOKEN_SHA256', deskTokens: 'MAYURA_DESK_TOKEN_SHA256',
      modelProvider: 'MAYURA_MODEL_PROVIDER', openaiApiKey: 'OPENAI_API_KEY', anthropicApiKey: 'ANTHROPIC_API_KEY',
      compatibleEndpoint: 'MAYURA_MODEL_ENDPOINT', compatibleId: 'MAYURA_MODEL_PROVIDER_ID', compatibleAuth: 'MAYURA_MODEL_AUTH', compatibleApiKey: 'MAYURA_MODEL_API_KEY', modelName: 'MAYURA_MODEL',
      inputMicrosPerMillionTokens: 'MAYURA_MODEL_INPUT_MICROS_PER_MILLION_TOKENS', outputMicrosPerMillionTokens: 'MAYURA_MODEL_OUTPUT_MICROS_PER_MILLION_TOKENS',
      maxCallCostMicros: 'MAYURA_MODEL_MAX_CALL_COST_MICROS', maxRunCostMicros: 'MAYURA_MAX_RUN_COST_MICROS', researchBudgetMicros: 'RESEARCH_BUDGET_MICROS',
      otlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT', otlpHeaders: 'OTEL_EXPORTER_OTLP_HEADERS', serviceName: 'OTEL_SERVICE_NAME',
    },
  });
  if (value.environment === 'production') {
    if (!value.publicOrigin) throw new Error('MAYURA_PUBLIC_ORIGIN (https://...) is required in production.');
    if (value.operatorTokens.length === 0) throw new Error('MAYURA_OPERATOR_TOKEN_SHA256 is required in production; run `npm run token`.');
  }
  // By default a research run may spend what its agent steps may spend together, so a run is never stopped by the
  // budget unless you set a smaller one. A smaller budget stops runs at the first step it cannot admit.
  const runMicros = value.researchBudgetMicros ?? AGENT_STEPS_PER_RUN * value.maxRunCostMicros;
  if (!Number.isSafeInteger(runMicros)) throw new Error('RESEARCH_BUDGET_MICROS is too large.');
  if (runMicros < value.maxRunCostMicros) throw new Error('RESEARCH_BUDGET_MICROS must admit at least the planning step (MAYURA_MAX_RUN_COST_MICROS).');
  const telemetry = telemetrySettings(value);
  return {
    environment: value.environment,
    scope: { principalId: 'research-service', projectId: value.projectId },
    storage: value.databaseUrl ? { kind: 'postgres', connectionString: value.databaseUrl } : { kind: 'sqlite', filename: value.sqlitePath },
    artifactsDirectory: value.artifactsDirectory,
    server: { port: value.port, bind: value.bind, allowedOrigins: value.allowedOrigins, ...(value.publicOrigin ? { publicOrigin: value.publicOrigin.replace(/\/$/u, '') } : {}) },
    operatorTokens: value.operatorTokens,
    deskTokens: value.deskTokens,
    model: modelSettings(value),
    budget: { stepMicros: value.maxRunCostMicros, runMicros },
    ...(telemetry ? { telemetry } : {}),
  };
}

function modelSettings(value: z.infer<typeof schema>): ModelSettings {
  if (value.modelProvider === 'offline') return { provider: 'offline' };
  const apiKey = value.modelProvider === 'openai' ? value.openaiApiKey : value.modelProvider === 'anthropic' ? value.anthropicApiKey : value.compatibleApiKey;
  const keyName = value.modelProvider === 'openai' ? 'OPENAI_API_KEY' : value.modelProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'MAYURA_MODEL_API_KEY';
  if (value.modelProvider === 'compatible' && (!value.compatibleEndpoint || !value.compatibleId)) {
    throw new Error('MAYURA_MODEL_PROVIDER=compatible requires MAYURA_MODEL_ENDPOINT (the https://.../chat/completions URL) and MAYURA_MODEL_PROVIDER_ID (such as groq).');
  }
  if (!apiKey || !value.modelName || value.inputMicrosPerMillionTokens === undefined || value.outputMicrosPerMillionTokens === undefined || value.maxCallCostMicros === 0) {
    throw new Error(`MAYURA_MODEL_PROVIDER=${value.modelProvider} requires ${keyName}, MAYURA_MODEL, both MAYURA_MODEL_*_MICROS_PER_MILLION_TOKENS prices and MAYURA_MODEL_MAX_CALL_COST_MICROS.`);
  }
  if (value.maxRunCostMicros < value.maxCallCostMicros) throw new Error('MAYURA_MAX_RUN_COST_MICROS must cover at least one model call.');
  const pricing = { inputMicrosPerMillionTokens: value.inputMicrosPerMillionTokens, outputMicrosPerMillionTokens: value.outputMicrosPerMillionTokens };
  if (value.modelProvider === 'compatible') return { provider: 'compatible', apiKey, name: value.modelName, maxCallCostMicros: value.maxCallCostMicros,
    endpoint: value.compatibleEndpoint!, providerId: value.compatibleId!, auth: value.compatibleAuth, pricing };
  return { provider: value.modelProvider, apiKey, name: value.modelName, maxCallCostMicros: value.maxCallCostMicros, pricing };
}

/**
 * OTEL_EXPORTER_OTLP_ENDPOINT is the collector's base URL, as in the OpenTelemetry SDKs; traces go to `<base>/v1/traces`.
 * OTEL_EXPORTER_OTLP_HEADERS uses the standard `name=value,name2=value2` form (values URL-encoded). Header values are
 * secrets: they are never logged or echoed in errors.
 */
function telemetrySettings(value: z.infer<typeof schema>): TelemetrySettings | undefined {
  if (!value.otlpEndpoint) {
    if (value.otlpHeaders) throw new Error('OTEL_EXPORTER_OTLP_HEADERS is set but OTEL_EXPORTER_OTLP_ENDPOINT is not.');
    return undefined;
  }
  const url = new URL(value.otlpEndpoint);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be https://, or http:// to a literal loopback address (127.0.0.1 or [::1]).');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must not carry credentials, a query or a fragment; use OTEL_EXPORTER_OTLP_HEADERS.');
  const headers: Record<string, string> = {};
  for (const entry of (value.otlpHeaders ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    const name = separator > 0 ? entry.slice(0, separator).trim() : '';
    let decoded: string;
    try { decoded = decodeURIComponent(entry.slice(separator + 1).trim()); } catch { decoded = ''; }
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(name) || !decoded || /[\r\n\0]/u.test(decoded) || Object.keys(headers).length >= 16) {
      throw new Error('OTEL_EXPORTER_OTLP_HEADERS must be up to 16 `name=value` pairs separated by commas.');
    }
    headers[name] = decoded;
  }
  return { tracesEndpoint: `${url.href.replace(/\/+$/u, '')}/v1/traces`, serviceName: value.serviceName, headers, allowInsecureLoopback: url.protocol === 'http:' };
}
