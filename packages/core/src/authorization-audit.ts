import { authorizationRequest, type AuthorizationRequest, type AuthorizationDecision } from './authorization.js';
import { MayuraError } from './errors.js';
import { jsonValue, freezeJson } from './json.js';

/** One completed authorization check, never a claim that the protected operation ran or committed. */
export interface AuthorizationAuditEvent {
  readonly type: 'authorization.decision';
  readonly id: string;
  readonly timestamp: string;
  readonly durationMs: number;
  /** Null when the request could not be validated; untrusted input is never copied into an event. */
  readonly request: AuthorizationRequest | null;
  readonly decision: AuthorizationDecision;
}
export type AuthorizationAuditSink = (event: AuthorizationAuditEvent, context: { readonly signal: AbortSignal }) => void | Promise<void>;
export interface AuthorizationAuditOptions {
  readonly sink: AuthorizationAuditSink;
  /** Delivery deadline, default 1,000 ms; 1–30,000 ms. Timed-out sinks retain capacity until settlement. */
  readonly timeoutMs?: number;
  /** No queue: excess deliveries are dropped. Default four, at most 64 outstanding sinks. */
  readonly maxConcurrent?: number;
}
export interface AuthorizationAuditSnapshot {
  readonly produced: number; readonly delivered: number; readonly failed: number;
  readonly timedOut: number; readonly cancelled: number; readonly dropped: number; readonly inFlight: number;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const reasons = ['no_match', 'explicit_deny', 'scope_mismatch', 'permission_denied', 'invalid_request', 'unavailable', 'cancelled', 'limit_exceeded'];
/** Strict, bounded privacy boundary for audit consumers. Rejects accessors and unknown fields, without invoking them. */
export function snapshotAuthorizationAuditEvent(input: unknown): AuthorizationAuditEvent {
  const fail = (): never => { throw new MayuraError('INVALID_INPUT', 'Invalid authorization audit event.'); };
  try {
    const value = jsonValue(input, { maxBytes: 6144, maxDepth: 6, maxNodes: 64 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    if (Object.keys(value).sort().join(',') !== 'decision,durationMs,id,request,timestamp,type') return fail();
    const event = value as unknown as AuthorizationAuditEvent;
    if (event.type !== 'authorization.decision' || typeof event.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(event.id)
      || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)) || new Date(event.timestamp).toISOString() !== event.timestamp
      || !Number.isSafeInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > Date.parse(event.timestamp)) return fail();
    if (event.request !== null) {
      if (!event.request || Object.keys(event.request).sort().join(',') !== 'action,resource,subject') return fail();
      authorizationRequest(event.request.subject, event.request.action, event.request.resource);
    }
    const decision = event.decision;
    if (!decision || typeof decision !== 'object' || Object.keys(decision).sort().join(',') !== 'effect,policyVersion,reason,ruleId'
      || typeof decision.policyVersion !== 'string' || !identifier.test(decision.policyVersion)
      || (decision.ruleId !== null && (typeof decision.ruleId !== 'string' || !identifier.test(decision.ruleId)))
      || (decision.effect === 'allow' ? decision.reason !== 'allowed' : decision.effect !== 'deny' || !reasons.includes(decision.reason))
      || (event.request === null && (decision.effect !== 'deny' || decision.reason !== 'invalid_request'))) return fail();
    return freezeJson(value) as unknown as AuthorizationAuditEvent;
  } catch { return fail(); }
}

/** Internal isolated delivery. No retry, queue, network client or infrastructure dependency. */
export function authorizationAudit(options: AuthorizationAuditOptions | undefined, admitted: boolean) {
  const counts = { produced: 0, delivered: 0, failed: 0, timedOut: 0, cancelled: 0, dropped: 0 };
  const active = new Map<AbortController, { done: Promise<void>; cancel: () => void }>(); let closed = false;
  const count = (key: keyof typeof counts) => { counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1); };
  if (options !== undefined && (!options || typeof options.sink !== 'function' || !admitted
    || Object.keys(options).some(key => !['sink', 'timeoutMs', 'maxConcurrent'].includes(key))))
    throw new MayuraError('INVALID_CONFIG', 'Authorization audit requires a sink, bounded limits and authz:audit permission.');
  const sink = options?.sink; const timeoutMs = options?.timeoutMs ?? 1000; const maxConcurrent = options?.maxConcurrent ?? 4;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64)
    throw new MayuraError('INVALID_CONFIG', 'Invalid authorization audit delivery limits.');
  return Object.freeze({
    emit(request: AuthorizationRequest | null, decision: AuthorizationDecision, startedAt: number): void {
      if (!sink) return;
      count('produced');
      if (closed || active.size >= maxConcurrent) { count('dropped'); return; }
      const now = Date.now();
      let event: AuthorizationAuditEvent;
      try { event = snapshotAuthorizationAuditEvent({ type: 'authorization.decision', id: crypto.randomUUID(), timestamp: new Date(now).toISOString(),
        durationMs: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now - startedAt)), request, decision }); } catch { count('failed'); return; }
      const control = new AbortController(); let complete!: () => void; const done = new Promise<void>(resolve => { complete = resolve; });
      let finished = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: 'delivered' | 'failed' | 'timedOut' | 'cancelled') => {
        if (finished) return; finished = true; clearTimeout(timer); count(outcome); complete();
      };
      active.set(control, { done, cancel: () => { finish('cancelled'); control.abort(); } });
      timer = setTimeout(() => { finish('timedOut'); control.abort(); }, timeoutMs);
      const deadline = now + timeoutMs;
      // Rejection handlers stay attached after timeout/close. A non-cooperative sink cannot grow outstanding work.
      void Promise.resolve().then(() => { if (!control.signal.aborted) return sink(event, Object.freeze({ signal: control.signal })); }).then(
        () => { if (!finished && Date.now() >= deadline) { finish('timedOut'); control.abort(); } else finish('delivered'); active.delete(control); },
        () => { finish('failed'); active.delete(control); },
      );
    },
    snapshot(): AuthorizationAuditSnapshot { return Object.freeze({ ...counts, inFlight: active.size }); },
    /** Drain deliveries already admitted, only until their deadlines; does not wait for ignored cancellation. */
    async flush(): Promise<void> { await Promise.all([...active.values()].map(item => item.done)); },
    close(): void { closed = true; for (const entry of active.values()) entry.cancel(); },
  });
}
