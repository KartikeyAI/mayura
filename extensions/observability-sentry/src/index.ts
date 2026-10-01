import { MayuraError } from 'mayura';
import { createOtlpHttpJsonTraceExporter, type OtlpExtraAttributes, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions, type OtlpTraceSpan } from 'mayura/exporter-otlp';

export interface SentryTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'spanAttributes'> {
  /**
   * The project's DSN, from its Client Keys settings: `https://<public key>@o<org>.ingest.<region>.sentry.io/<project>`,
   * or a self-hosted Sentry's. Its public key authenticates the spans; nothing is read from the environment.
   */
  readonly dsn: string;
}

/** Sentry's span op for a span with a GenAI operation, `gen_ai.<operation>` (`gen_ai.chat`, `gen_ai.invoke_agent`), which its AI Agents view reads. */
export function sentryAttributes(span: OtlpTraceSpan): OtlpExtraAttributes | undefined {
  const operation = span.attributes?.['gen_ai.operation.name'];
  return typeof operation === 'string' ? { 'sentry.op': `gen_ai.${operation}` } : undefined;
}

function destination(dsn: unknown): { readonly endpoint: string; readonly publicKey: string } {
  try {
    if (typeof dsn !== 'string' || dsn.length > 2_000) throw new Error();
    const url = new URL(dsn); const publicKey = decodeURIComponent(url.username);
    const path = /^((?:\/[A-Za-z0-9._~-]+)*)\/(\d{1,20})\/?$/u.exec(url.pathname);
    if (!/^[A-Za-z0-9]{16,64}$/u.test(publicKey) || !path || url.search || url.hash) throw new Error();
    // A legacy DSN's secret key is never sent: OTLP ingestion authenticates with the public key alone.
    return { endpoint: `${url.protocol}//${url.host}${path[1]}/api/${path[2]}/integration/otlp/v1/traces`, publicKey };
  } catch { throw new MayuraError('INVALID_CONFIG', 'Sentry needs the project\'s DSN, such as https://<public key>@o1.ingest.sentry.io/2.'); }
}

/**
 * An OTLP trace exporter for Sentry's OTLP endpoint (in beta at Sentry): give its `sink` the spans of
 * `agentRunTraceSpans` or of `createWorkflowTraceExport`. Agent, model and tool spans carry Sentry's `gen_ai.*` span
 * ops beside their GenAI attributes. Spans are metadata only; no prompt or output is sent.
 */
export function sentryTraceExporter(options: SentryTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'Sentry needs its options.');
  const { endpoint, publicKey } = destination(options.dsn);
  const { dsn: _dsn, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({ ...exporter, endpoint, headers: { 'x-sentry-auth': `sentry sentry_key=${publicKey}` }, spanAttributes: sentryAttributes });
}
