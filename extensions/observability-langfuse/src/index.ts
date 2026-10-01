import { MayuraError } from 'mayura';
import { bytesToBase64 } from 'mayura/core/host';
import { createOtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions } from 'mayura/exporter-otlp';

/** Langfuse Cloud's data regions. */
export type LangfuseRegion = 'eu' | 'us' | 'jp' | 'hipaa';

export interface LangfuseTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'serviceName'> {
  /** The project's public key (`pk-lf-…`). */
  readonly publicKey: string;
  /** The project's secret key (`sk-lf-…`). Copied once; never shown by `inspect()` or in errors. */
  readonly secretKey: string;
  /** Langfuse Cloud's region, `eu` by default. Leave it out with `baseUrl`. */
  readonly region?: LangfuseRegion;
  /** A self-hosted Langfuse (v3.22.0 or later), such as `https://langfuse.example.com`. HTTPS, or loopback HTTP with `allowInsecureLoopback`. */
  readonly baseUrl?: string;
  /** The `service.name` resource attribute. */
  readonly serviceName: string;
}

const regions: Readonly<Record<LangfuseRegion, string>> = {
  eu: 'https://cloud.langfuse.com', us: 'https://us.cloud.langfuse.com', jp: 'https://jp.cloud.langfuse.com', hipaa: 'https://hipaa.cloud.langfuse.com',
};
const otelPath = '/api/public/otel/v1/traces';

function key(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || value.length < prefix.length + 1 || value.length > 256 || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new MayuraError('INVALID_CONFIG', `Langfuse needs its ${prefix === 'pk-lf-' ? 'public' : 'secret'} key (${prefix}…).`);
  }
  return value;
}
function endpoint(options: LangfuseTraceExporterOptions): string {
  if (options.baseUrl === undefined) {
    const region = options.region ?? 'eu';
    if (!Object.hasOwn(regions, region)) throw new MayuraError('INVALID_CONFIG', 'The Langfuse region must be eu, us, jp or hipaa.');
    return `${regions[region]}${otelPath}`;
  }
  if (options.region !== undefined) throw new MayuraError('INVALID_CONFIG', 'Give Langfuse a region or a baseUrl, not both.');
  try {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.length > 2_000) throw new Error();
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    // The exporter decides whether the scheme and host are allowed; this only places Langfuse's path.
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}${otelPath}`;
  } catch { throw new MayuraError('INVALID_CONFIG', 'The Langfuse baseUrl must be an explicit URL without credentials, query or fragment.'); }
}

/**
 * An OTLP trace exporter for Langfuse's OpenTelemetry endpoint: give its `sink` the spans of `agentRunTraceSpans` or
 * of `createWorkflowTraceExport`. Langfuse reads the GenAI attributes on Mayura's spans, so runs show as agent traces
 * with their model and tool calls, models and token usage. Spans are metadata only; no prompt or output is sent.
 */
export function langfuseTraceExporter(options: LangfuseTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'Langfuse needs its options.');
  const publicKey = key(options.publicKey, 'pk-lf-'); const secretKey = key(options.secretKey, 'sk-lf-');
  const { publicKey: _public, secretKey: _secret, region: _region, baseUrl: _base, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({
    ...exporter, endpoint: endpoint(options),
    // Ingestion version 4 makes the spans visible at once instead of after a delay.
    headers: { Authorization: `Basic ${bytesToBase64(new TextEncoder().encode(`${publicKey}:${secretKey}`))}`, 'x-langfuse-ingestion-version': '4' },
  });
}
