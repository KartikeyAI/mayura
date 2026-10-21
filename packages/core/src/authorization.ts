import { authorizationAudit, type AuthorizationAuditOptions, type AuthorizationAuditSnapshot } from './authorization-audit.js';
import type { Permissions, Scope } from './contracts.js';
import { MayuraError } from './errors.js';
import { freezeJson, jsonValue } from './json.js';

export const AUTHORIZATION_RESOURCE_KINDS = Object.freeze(['agent', 'tool', 'run', 'workflow', 'thread', 'memory', 'rag_document', 'human_request', 'server'] as const);
export type AuthorizationResourceKind = typeof AUTHORIZATION_RESOURCE_KINDS[number];
/** Verified principal and project. Role membership comes from host policy, never request-supplied claims. */
export type AuthorizationSubject = Scope;
export interface AuthorizationResource {
  readonly kind: AuthorizationResourceKind;
  readonly id: string;
  readonly scope: Scope;
  /** Trusted stored ownership metadata, when a policy needs an ownership condition. */
  readonly ownerId?: string;
}
export interface AuthorizationRequest {
  readonly subject: AuthorizationSubject; readonly action: string; readonly resource: AuthorizationResource;
}
export type AuthorizationDenyReason = 'no_match' | 'explicit_deny' | 'scope_mismatch' | 'permission_denied'
  | 'invalid_request' | 'unavailable' | 'cancelled' | 'limit_exceeded';
export type AuthorizationDecision = {
  readonly effect: 'allow'; readonly reason: 'allowed'; readonly policyVersion: string; readonly ruleId: string | null;
} | {
  readonly effect: 'deny'; readonly reason: AuthorizationDenyReason; readonly policyVersion: string; readonly ruleId: string | null;
};
/** Infrastructure boundary for local policies and external authorization adapters. No raw provider diagnostics. */
export interface AuthorizationPolicy {
  readonly version: string;
  authorize(request: AuthorizationRequest, context: { readonly signal: AbortSignal }): AuthorizationDecision | Promise<AuthorizationDecision>;
}
export interface AuthorizerOptions {
  readonly policy: AuthorizationPolicy;
  /** Optional isolated decision delivery; requires explicit authz:audit permission. */
  readonly audit?: AuthorizationAuditOptions;
  /** Explicit authz:evaluate admission. Missing grants deny evaluation without invoking the policy. */
  readonly permissions?: Permissions;
  readonly limits?: { readonly timeoutMs?: number; readonly maxConcurrent?: number };
}
export interface Authorizer {
  /** Always returns a frozen decision. Invalid requests, aborts, timeouts and policy failures deny. */
  authorize(subject: AuthorizationSubject, action: string, resource: AuthorizationResource, options?: { readonly signal?: AbortSignal }): Promise<AuthorizationDecision>;
  /** Throws a content-free PERMISSION_DENIED unless the bounded policy evaluation explicitly allows. */
  require(subject: AuthorizationSubject, action: string, resource: AuthorizationResource, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Counts only this authorizer; no event history or request content is retained. */
  auditSnapshot(): AuthorizationAuditSnapshot;
  /** Await already admitted deliveries until their bounded delivery deadlines. */
  flushAudit(): Promise<void>;
  /** Abort outstanding decisions and audit deliveries; a closed authorizer never evaluates another policy request. */
  close(): void;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const actionName = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const denyReasons: readonly string[] = ['no_match', 'explicit_deny', 'scope_mismatch', 'permission_denied', 'invalid_request', 'unavailable', 'cancelled', 'limit_exceeded'];
function invalid(): never { throw new MayuraError('INVALID_INPUT', 'Authorization requires bounded plain subject, action and resource data.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !fields[key]!.enumerable || !('value' in fields[key]!))) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function id(value: unknown): void { if (typeof value !== 'string' || !identifier.test(value)) invalid(); }
function scope(value: unknown): void { const raw = record(value); exact(raw, ['principalId', 'projectId']); id(raw['principalId']); id(raw['projectId']); }
/** Validate and snapshot trusted identity/resource data before any asynchronous authorization boundary. */
export function authorizationRequest(subject: AuthorizationSubject, action: string, resource: AuthorizationResource): AuthorizationRequest {
  try {
    scope(subject); const raw = record(resource); exact(raw, ['kind', 'id', 'scope'], ['ownerId']);
    id(raw['id']); scope(raw['scope']); if (raw['ownerId'] !== undefined) id(raw['ownerId']);
    if (!AUTHORIZATION_RESOURCE_KINDS.includes(raw['kind'] as AuthorizationResourceKind) || typeof action !== 'string' || !actionName.test(action)) invalid();
    return freezeJson(jsonValue({ subject, action, resource }, { maxBytes: 4096, maxDepth: 4, maxNodes: 32 })) as unknown as AuthorizationRequest;
  } catch { return invalid(); }
}
/** Bounded fail-closed enforcement. A lingering callback retains its slot until settlement, preventing timeout floods. */
export function createAuthorizer(options: AuthorizerOptions): Authorizer {
  const fail = (): never => { throw new MayuraError('INVALID_CONFIG', 'Authorization requires a versioned policy, bounded limits and explicit permissions.'); };
  const policy = options?.policy;
  if (!policy || typeof policy.version !== 'string' || !identifier.test(policy.version) || typeof policy.authorize !== 'function') return fail();
  const version = policy.version; const evaluate = policy.authorize.bind(policy);
  const allow = options.permissions?.allow ?? [];
  if (!Array.isArray(allow) || allow.length > 4096 || allow.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) fail();
  const admitted = allow.includes('authz:evaluate'); const settings = options.limits ?? {};
  if (!settings || typeof settings !== 'object' || Object.keys(settings).some(key => !['timeoutMs', 'maxConcurrent'].includes(key))) fail();
  const timeoutMs = settings.timeoutMs ?? 1000; const maxConcurrent = settings.maxConcurrent ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 1024) fail();
  const audit = authorizationAudit(options.audit, allow.includes('authz:audit'));
  const active = new Set<AbortController>(); let closed = false;
  const deny = (reason: AuthorizationDenyReason): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId: null });
  const decision = (value: unknown): AuthorizationDecision => {
    try {
      const raw = record(value); exact(raw, ['effect', 'reason', 'policyVersion', 'ruleId']);
      if (raw['policyVersion'] !== version || (raw['ruleId'] !== null && (typeof raw['ruleId'] !== 'string' || !identifier.test(raw['ruleId'])))) return deny('unavailable');
      if (typeof raw['reason'] !== 'string') return deny('unavailable');
      if (raw['effect'] === 'allow' ? raw['reason'] !== 'allowed' : raw['effect'] !== 'deny' || !denyReasons.includes(raw['reason'])) return deny('unavailable');
      return Object.freeze({ effect: raw['effect'], reason: raw['reason'], policyVersion: version, ruleId: raw['ruleId'] }) as AuthorizationDecision;
    } catch { return deny('unavailable'); }
  };
  const authorize: Authorizer['authorize'] = async (subject, action, resource, supplied) => {
    const startedAt = Date.now(); let request: AuthorizationRequest | null = null;
    const decide = async (): Promise<AuthorizationDecision> => {
      let signal: AbortSignal | undefined;
      try {
        request = authorizationRequest(subject, action, resource);
        if (supplied !== undefined) { const raw = record(supplied); exact(raw, [], ['signal']); signal = raw['signal'] as AbortSignal | undefined;
          if (signal !== undefined && !(signal instanceof AbortSignal)) return deny('invalid_request'); }
      } catch { return deny('invalid_request'); }
      const checked = request;
      if (closed || signal?.aborted) return deny('cancelled');
      if (checked.subject.principalId !== checked.resource.scope.principalId || checked.subject.projectId !== checked.resource.scope.projectId) return deny('scope_mismatch');
      if (!admitted) return deny('permission_denied');
      if (active.size >= maxConcurrent) return deny('limit_exceeded');
      const control = new AbortController(); const deadline = Date.now() + timeoutMs; active.add(control);
      return await new Promise<AuthorizationDecision>(resolve => {
        let finished = false; let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: AuthorizationDecision): void => {
          if (finished) return; finished = true; clearTimeout(timer);
          signal?.removeEventListener('abort', relay); control.signal.removeEventListener('abort', aborted); resolve(result);
        };
        const relay = () => control.abort();
        const aborted = () => finish(deny(expired ? 'unavailable' : 'cancelled'));
        control.signal.addEventListener('abort', aborted, { once: true }); signal?.addEventListener('abort', relay, { once: true });
        timer = setTimeout(() => { expired = true; control.abort(); }, timeoutMs);
        if (signal?.aborted) relay();
        // Both fulfillment and rejection handlers remain attached after timeout/cancellation. Late allows cannot escape.
        void Promise.resolve().then(() => control.signal.aborted ? deny('cancelled') : evaluate(checked, Object.freeze({ signal: control.signal }))).then(
          raw => {
            const result = control.signal.aborted ? deny(expired ? 'unavailable' : 'cancelled') : decision(raw);
            if (Date.now() >= deadline && !control.signal.aborted) { expired = true; control.abort(); }
            active.delete(control); finish(control.signal.aborted ? deny(expired ? 'unavailable' : 'cancelled') : result);
          },
          () => { active.delete(control); finish(deny('unavailable')); },
        );
      });
    };
    const result = await decide();
    audit.emit(request, result, startedAt);
    return result;
  };
  return Object.freeze({ authorize, auditSnapshot: audit.snapshot, flushAudit: audit.flush,
    async require(subject: AuthorizationSubject, action: string, resource: AuthorizationResource, supplied?: { readonly signal?: AbortSignal }) {
      if ((await authorize(subject, action, resource, supplied)).effect !== 'allow' || closed) throw new MayuraError('PERMISSION_DENIED', 'The operation is not authorized.');
    },
    close() { if (closed) return; closed = true; audit.close(); for (const control of active) control.abort(); },
  });
}
