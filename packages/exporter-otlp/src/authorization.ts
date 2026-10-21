import { context as contexts, SpanKind, SpanStatusCode, type Attributes, type Context, type Counter, type Histogram, type Meter, type Tracer } from '@opentelemetry/api';
import { MayuraError, snapshotAuthorizationAuditEvent, type AuthorizationAuditSink } from '@mayura/core';

export interface OpenTelemetryAuthorizationOptions {
  readonly tracer?: Tracer;
  readonly meter?: Meter;
  /** Invoked for each decision span; defaults to the application's active context. */
  readonly context?: () => Context;
  /** Opt in to principal, project, resource, owner, rule and policy identifiers on spans only. Default false. */
  readonly includeIdentifiers?: boolean;
}
export interface OpenTelemetryAuthorization {
  /** Attach as AuthorizerOptions.audit.sink. Export never receives credentials, inputs, tool arguments or policy errors. */
  readonly sink: AuthorizationAuditSink;
  /** Refuse future deliveries. SDK flushing/shutdown remains the application's responsibility. */
  close(): void;
}
/**
 * One fixed-name internal span and bounded-cardinality metrics per admitted decision. Expected policy denials are
 * ordinary decisions; only unavailable policy evaluation marks a span as failed. No sampler or exporter is installed.
 */
export function createOpenTelemetryAuthorization(options: OpenTelemetryAuthorizationOptions): OpenTelemetryAuthorization {
  const tracer = options?.tracer; const meter = options?.meter;
  if ((!tracer && !meter) || (tracer && typeof tracer.startSpan !== 'function')
    || (meter && (typeof meter.createCounter !== 'function' || typeof meter.createHistogram !== 'function'))
    || (options.context !== undefined && typeof options.context !== 'function')
    || (options.includeIdentifiers !== undefined && typeof options.includeIdentifiers !== 'boolean'))
    throw new MayuraError('INVALID_CONFIG', 'Authorization telemetry requires a tracer or meter and supported options.');
  const base = options.context ?? (() => contexts.active()); const identifiers = options.includeIdentifiers === true;
  let count: Counter | undefined; let duration: Histogram | undefined; let closed = false;
  try {
    count = meter?.createCounter('mayura.authorization.decisions', { unit: '{decision}', description: 'Observed authorization decisions.' });
    duration = meter?.createHistogram('mayura.authorization.duration', { unit: 's', description: 'Authorization evaluation duration.' });
  } catch { throw new MayuraError('INVALID_CONFIG', 'Authorization telemetry requires a working meter.'); }
  const sink: AuthorizationAuditSink = async (raw, context) => {
    if (closed) throw new MayuraError('CONFLICT', 'Authorization telemetry is closed.');
    if (!(context?.signal instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'Authorization telemetry requires a signal.');
    if (context.signal.aborted) throw new MayuraError('CANCELLED', 'Authorization telemetry was cancelled.');
    const event = snapshotAuthorizationAuditEvent(raw); const { request, decision } = event;
    // Only closed enumerations enter metric labels. No action names, tenants, policy versions, rules or resource ids.
    const labels: Attributes = { 'mayura.authorization.effect': decision.effect, 'mayura.authorization.reason': decision.reason,
      'mayura.authorization.resource.kind': request?.resource.kind ?? 'invalid_request' };
    try {
      if (tracer) {
        const attributes: Attributes = { ...labels, ...(request === null ? {} : { 'mayura.authorization.action': request.action }) };
        if (identifiers) {
          attributes['mayura.authorization.event.id'] = event.id;
          attributes['mayura.authorization.policy.version'] = decision.policyVersion;
          if (decision.ruleId !== null) attributes['mayura.authorization.rule.id'] = decision.ruleId;
          if (request) {
            attributes['mayura.authorization.principal.id'] = request.subject.principalId;
            attributes['mayura.authorization.project.id'] = request.subject.projectId;
            attributes['mayura.authorization.resource.id'] = request.resource.id;
            attributes['mayura.authorization.resource.principal.id'] = request.resource.scope.principalId;
            attributes['mayura.authorization.resource.project.id'] = request.resource.scope.projectId;
            if (request.resource.ownerId !== undefined) attributes['mayura.authorization.owner.id'] = request.resource.ownerId;
          }
        }
        const end = Date.parse(event.timestamp);
        const span = tracer.startSpan('authorization.decision', { kind: SpanKind.INTERNAL,
          startTime: end - event.durationMs, attributes }, base());
        try {
          span.setStatus({ code: decision.reason === 'unavailable' ? SpanStatusCode.ERROR : decision.effect === 'allow' ? SpanStatusCode.OK : SpanStatusCode.UNSET });
        } finally { span.end(end); }
      }
      if (!context.signal.aborted) { count?.add(1, labels); duration?.record(event.durationMs / 1000, labels); }
    } catch { throw new MayuraError('TOOL_FAILED', 'Authorization telemetry delivery failed.'); }
  };
  return Object.freeze({ sink, close() { closed = true; } });
}
