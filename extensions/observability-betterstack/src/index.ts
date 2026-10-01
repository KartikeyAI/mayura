import { MayuraError } from 'mayura';
import { createOtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions } from 'mayura/exporter-otlp';

export interface BetterStackTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'allowInsecureLoopback'> {
  /** The source's token, from its settings. Copied once; never shown by `inspect()` or in errors. */
  readonly sourceToken: string;
  /** The source's ingesting host, such as `s1234.eu-nbg-2.betterstackdata.com`: a host name, without a scheme or path. */
  readonly ingestingHost: string;
}

const hostname = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/**
 * An OTLP trace exporter for a Better Stack source: give its `sink` the spans of `agentRunTraceSpans` or of
 * `createWorkflowTraceExport`, and query them in Better Stack by their GenAI and Mayura attributes. Spans are metadata
 * only; no prompt or output is sent.
 */
export function betterStackTraceExporter(options: BetterStackTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'Better Stack needs its options.');
  if (typeof options.sourceToken !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/u.test(options.sourceToken)) throw new MayuraError('INVALID_CONFIG', 'Better Stack needs the source token.');
  if (typeof options.ingestingHost !== 'string' || !hostname.test(options.ingestingHost)) {
    throw new MayuraError('INVALID_CONFIG', 'The Better Stack ingesting host must be a host name, such as s1234.eu-nbg-2.betterstackdata.com.');
  }
  const { sourceToken, ingestingHost, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({ ...exporter, endpoint: `https://${ingestingHost}/v1/traces`, headers: { Authorization: `Bearer ${sourceToken}` } });
}
