import { MayuraError } from 'mayura';
import { createOtlpHttpJsonTraceExporter, type OtlpExtraAttributes, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions, type OtlpTraceSpan } from 'mayura/exporter-otlp';

/** Arize AX's data regions. */
export type ArizeRegion = 'us' | 'eu' | 'ca';

export interface ArizeTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'allowInsecureLoopback' | 'spanAttributes'> {
  /** The space's id, from its settings. */
  readonly spaceId: string;
  /** An Arize API key. Copied once; never shown by `inspect()` or in errors. */
  readonly apiKey: string;
  /** The project the traces belong to: a stable identifier such as `support-agent`. */
  readonly projectName: string;
  /** Arize AX's region, `us` by default. */
  readonly region?: ArizeRegion;
}

const regions: Readonly<Record<ArizeRegion, string>> = {
  us: 'https://otlp.arize.com/v1/traces', eu: 'https://otlp.eu-west-1a.arize.com/v1/traces', ca: 'https://otlp.ca-central-1a.arize.com/v1/traces',
};
const stable = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const kinds: Readonly<Record<string, string>> = { chat: 'LLM', invoke_agent: 'AGENT', execute_tool: 'TOOL' };
/** OpenTelemetry's well-known GenAI provider names as OpenInference's `llm.provider` values, where they differ. */
const providers: Readonly<Record<string, string>> = { 'aws.bedrock': 'aws', 'azure.ai.openai': 'azure', 'gcp.gemini': 'google', 'gcp.vertex_ai': 'google', mistral_ai: 'mistralai', x_ai: 'xai' };

/**
 * OpenInference attributes for a span, from its GenAI attributes: the span kind (`LLM`, `AGENT`, `TOOL`, or `CHAIN`
 * for runs' other spans and workflow spans), the model and provider, token counts, and tool and agent names. Arize AX
 * and Phoenix read these; give it as `spanAttributes` to another OpenInference backend's OTLP exporter.
 */
export function openInferenceAttributes(span: OtlpTraceSpan): OtlpExtraAttributes {
  const attributes = span.attributes ?? {};
  const operation = attributes['gen_ai.operation.name']; const model = attributes['gen_ai.request.model']; const provider = attributes['gen_ai.provider.name'];
  const input = attributes['gen_ai.usage.input_tokens']; const output = attributes['gen_ai.usage.output_tokens'];
  const tool = attributes['gen_ai.tool.name']; const agent = attributes['gen_ai.agent.name'];
  return {
    'openinference.span.kind': (typeof operation === 'string' ? kinds[operation] : undefined) ?? 'CHAIN',
    ...(typeof model === 'string' ? { 'llm.model_name': model } : {}),
    ...(typeof provider === 'string' ? { 'llm.provider': providers[provider] ?? provider } : {}),
    ...(typeof input === 'number' ? { 'llm.token_count.prompt': input } : {}), ...(typeof output === 'number' ? { 'llm.token_count.completion': output } : {}),
    ...(typeof input === 'number' && typeof output === 'number' && Number.isSafeInteger(input + output) ? { 'llm.token_count.total': input + output } : {}),
    ...(typeof tool === 'string' ? { 'tool.name': tool } : {}), ...(typeof agent === 'string' ? { 'agent.name': agent } : {}),
  };
}

/**
 * An OTLP trace exporter for Arize AX: give its `sink` the spans of `agentRunTraceSpans` or of
 * `createWorkflowTraceExport`. Spans carry OpenInference attributes beside their GenAI ones, so runs show as agent
 * traces with their LLM and tool spans, models and token counts. Spans are metadata only; no prompt or output is sent.
 */
export function arizeTraceExporter(options: ArizeTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'Arize needs its options.');
  if (typeof options.spaceId !== 'string' || !/^[A-Za-z0-9+/=_-]{1,256}$/u.test(options.spaceId)) throw new MayuraError('INVALID_CONFIG', 'Arize needs its space id.');
  if (typeof options.apiKey !== 'string' || !/^[A-Za-z0-9+/=._-]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'Arize needs an API key.');
  if (typeof options.projectName !== 'string' || !stable.test(options.projectName)) throw new MayuraError('INVALID_CONFIG', 'The Arize project name must be a stable identifier, such as support-agent.');
  const region = options.region ?? 'us';
  if (typeof region !== 'string' || !Object.hasOwn(regions, region)) throw new MayuraError('INVALID_CONFIG', 'The Arize region must be us, eu or ca.');
  const { spaceId, apiKey, projectName, region: _region, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({
    ...exporter, endpoint: regions[region], headers: { space_id: spaceId, api_key: apiKey },
    resourceAttributes: { ...options.resourceAttributes, 'openinference.project.name': projectName }, spanAttributes: openInferenceAttributes,
  });
}
