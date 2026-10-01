import { MayuraError } from 'mayura';
import { createOtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporter, type OtlpHttpJsonTraceExporterOptions } from 'mayura/exporter-otlp';

/** PostHog Cloud's regions. */
export type PostHogRegion = 'us' | 'eu';

export interface PostHogTraceExporterOptions extends Omit<OtlpHttpJsonTraceExporterOptions, 'endpoint' | 'headers' | 'allowInsecureLoopback' | 'standardPath'> {
  /** The project's API token (`phc_…`), from its settings. */
  readonly projectToken: string;
  /** PostHog Cloud's region, `us` by default. */
  readonly region?: PostHogRegion;
  /**
   * The person the traces belong to in PostHog (`posthog.distinct_id`), a stable identifier. It applies to everything
   * this exporter sends, so give one exporter per person, or leave it out for anonymous events.
   */
  readonly distinctId?: string;
}

const regions: Readonly<Record<PostHogRegion, string>> = { us: 'https://us.i.posthog.com/i/v0/ai/otel', eu: 'https://eu.i.posthog.com/i/v0/ai/otel' };
const stable = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

/**
 * An OTLP trace exporter for PostHog's LLM analytics: give its `sink` the spans of `agentRunTraceSpans`. PostHog turns
 * model calls into `$ai_generation` events with their model, provider and token counts, runs and tool calls into
 * `$ai_span` events, and each trace into an `$ai_trace`. Spans are metadata only; no prompt or output is sent.
 */
export function posthogTraceExporter(options: PostHogTraceExporterOptions): OtlpHttpJsonTraceExporter {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'PostHog needs its options.');
  if (typeof options.projectToken !== 'string' || !/^phc_[A-Za-z0-9]{8,128}$/u.test(options.projectToken)) throw new MayuraError('INVALID_CONFIG', 'PostHog needs the project\'s API token (phc_…).');
  const region = options.region ?? 'us';
  if (typeof region !== 'string' || !Object.hasOwn(regions, region)) throw new MayuraError('INVALID_CONFIG', 'The PostHog region must be us or eu.');
  if (options.distinctId !== undefined && (typeof options.distinctId !== 'string' || !stable.test(options.distinctId))) {
    throw new MayuraError('INVALID_CONFIG', 'The PostHog distinctId must be a stable identifier, such as a user id.');
  }
  const { projectToken, region: _region, distinctId, ...exporter } = options;
  return createOtlpHttpJsonTraceExporter({
    ...exporter, endpoint: regions[region], standardPath: false, headers: { Authorization: `Bearer ${projectToken}` },
    ...(distinctId === undefined ? {} : { resourceAttributes: { ...options.resourceAttributes, 'posthog.distinct_id': distinctId } }),
  });
}
