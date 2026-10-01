import { MayuraError } from 'mayura';
import { createOtlpHttpJsonTraceExporter, type OtlpExtraAttributes, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions, type OtlpTraceSpan } from 'mayura/exporter-otlp';

/** LangSmith's cloud regions. */
export type LangSmithRegion = 'us' | 'eu' | 'apac' | 'aws-us';

export interface LangSmithTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'spanAttributes' | 'standardPath'> {
  /** A LangSmith API key. Copied once; never shown by `inspect()` or in errors. */
  readonly apiKey: string;
  /** The project the traces go to; LangSmith's default project when left out. */
  readonly project?: string;
  /** LangSmith's region, `us` by default. Leave it out with `baseUrl`. */
  readonly region?: LangSmithRegion;
  /** A self-hosted LangSmith's API URL, such as `https://langsmith.example.com`. HTTPS, or loopback HTTP with `allowInsecureLoopback`. */
  readonly baseUrl?: string;
}

const regions: Readonly<Record<LangSmithRegion, string>> = {
  us: 'https://api.smith.langchain.com/otel/v1/traces', eu: 'https://eu.api.smith.langchain.com/otel/v1/traces',
  apac: 'https://apac.api.smith.langchain.com/otel/v1/traces', 'aws-us': 'https://aws.api.smith.langchain.com/otel/v1/traces',
};
const kinds: Readonly<Record<string, string>> = { chat: 'llm', execute_tool: 'tool' };

/**
 * LangSmith's attributes for a span: its run type (`langsmith.span.kind`: `llm` for model calls, `tool` for tool
 * calls, `chain` for runs and other spans), and `gen_ai.system`, which LangSmith reads the provider from.
 */
export function langSmithAttributes(span: OtlpTraceSpan): OtlpExtraAttributes {
  const operation = span.attributes?.['gen_ai.operation.name']; const provider = span.attributes?.['gen_ai.provider.name'];
  return { 'langsmith.span.kind': (typeof operation === 'string' ? kinds[operation] : undefined) ?? 'chain', ...(typeof provider === 'string' ? { 'gen_ai.system': provider } : {}) };
}

function endpoint(options: LangSmithTraceExporterOptions): string {
  if (options.baseUrl === undefined) {
    const region = options.region ?? 'us';
    if (typeof region !== 'string' || !Object.hasOwn(regions, region)) throw new MayuraError('INVALID_CONFIG', 'The LangSmith region must be us, eu, apac or aws-us.');
    return regions[region];
  }
  if (options.region !== undefined) throw new MayuraError('INVALID_CONFIG', 'Give LangSmith a region or a baseUrl, not both.');
  try {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.length > 2_000) throw new Error();
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    // The exporter decides whether the scheme and host are allowed; this only places LangSmith's path.
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}/api/v1/otel/v1/traces`;
  } catch { throw new MayuraError('INVALID_CONFIG', 'The LangSmith baseUrl must be an explicit URL without credentials, query or fragment.'); }
}

/**
 * An OTLP trace exporter for LangSmith's OpenTelemetry endpoint: give its `sink` the spans of `agentRunTraceSpans` or
 * of `createWorkflowTraceExport`. Runs show as chains with their LLM and tool runs, models and token usage. Spans are
 * metadata only; no prompt or output is sent.
 */
export function langSmithTraceExporter(options: LangSmithTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'LangSmith needs its options.');
  if (typeof options.apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'LangSmith needs an API key.');
  if (options.project !== undefined && (typeof options.project !== 'string' || !/^[\x20-\x7e]{1,128}$/u.test(options.project) || options.project.trim() !== options.project)) {
    throw new MayuraError('INVALID_CONFIG', 'The LangSmith project must be a project name of at most 128 printable characters.');
  }
  const url = endpoint(options);
  const { apiKey, project, region: _region, baseUrl: _baseUrl, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({
    ...exporter, endpoint: url, headers: { 'x-api-key': apiKey, ...(project === undefined ? {} : { 'Langsmith-Project': project }) }, spanAttributes: langSmithAttributes,
  });
}
