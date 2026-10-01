import { MayuraError } from 'mayura';
import { createOtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions } from 'mayura/exporter-otlp';

/** Datadog sites with OTLP intake. LLM Observability is not available on `ddog-gov.com`. */
export type DatadogSite = 'datadoghq.com' | 'us3.datadoghq.com' | 'us5.datadoghq.com' | 'datadoghq.eu' | 'ap1.datadoghq.com' | 'ap2.datadoghq.com' | 'ddog-gov.com';

export interface DatadogTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'allowInsecureLoopback'> {
  /** A Datadog API key. Copied once; never shown by `inspect()` or in errors. */
  readonly apiKey: string;
  /** Your Datadog site, `datadoghq.com` (US1) by default. */
  readonly site?: DatadogSite;
  /**
   * Send to LLM Observability instead of APM. `mlApp` names the application there; by default Datadog uses the
   * service name. LLM Observability keeps only spans with GenAI attributes: agent runs, model calls and tool calls.
   */
  readonly llmObservability?: boolean | { readonly mlApp?: string };
}

const sites: ReadonlySet<string> = new Set<DatadogSite>(['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ap2.datadoghq.com', 'ddog-gov.com']);
const stable = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

/**
 * An OTLP trace exporter for Datadog's OTLP intake: give its `sink` the spans of `agentRunTraceSpans` or of
 * `createWorkflowTraceExport`. In APM, runs are traces with their model and tool calls; in LLM Observability, Datadog
 * reads the GenAI attributes on Mayura's spans, so they show as agent, LLM and tool spans with models and token usage.
 * Spans are metadata only; no prompt or output is sent.
 */
export function datadogTraceExporter(options: DatadogTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'Datadog needs its options.');
  if (typeof options.apiKey !== 'string' || !/^[A-Za-z0-9]{16,128}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'Datadog needs an API key.');
  const site = options.site ?? 'datadoghq.com';
  if (typeof site !== 'string' || !sites.has(site)) throw new MayuraError('INVALID_CONFIG', 'The Datadog site must be one of Datadog\'s sites, such as datadoghq.com or datadoghq.eu.');
  const llm = options.llmObservability ?? false;
  if (typeof llm !== 'boolean' && (!llm || typeof llm !== 'object')) throw new MayuraError('INVALID_CONFIG', 'llmObservability must be true, false or { mlApp }.');
  const mlApp = typeof llm === 'object' ? llm.mlApp : undefined;
  if (mlApp !== undefined && (typeof mlApp !== 'string' || !stable.test(mlApp))) throw new MayuraError('INVALID_CONFIG', 'The Datadog mlApp must be a stable identifier.');
  if (llm !== false && site === 'ddog-gov.com') throw new MayuraError('INVALID_CONFIG', 'Datadog LLM Observability is not available on ddog-gov.com.');
  const { apiKey, site: _site, llmObservability: _llm, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({
    ...exporter, endpoint: `https://otlp.${site}/v1/traces`,
    headers: { 'dd-api-key': apiKey, ...(llm === false ? {} : { 'dd-otlp-source': 'llmobs', ...(mlApp === undefined ? {} : { 'dd-ml-app': mlApp }) }) },
  });
}
