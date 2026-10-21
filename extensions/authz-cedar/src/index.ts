import { AUTHORIZATION_RESOURCE_KINDS, authorizationRequest, createAuthorizer, freezeJson, jsonValue, MayuraError,
  type AuthorizationDecision, type AuthorizationDenyReason, type AuthorizationPolicy, type AuthorizationRequest,
  type AuthorizationResourceKind, type Authorizer, type AuthorizerOptions, type Permissions } from 'mayura';
import { sha256Hex, utf8ByteLength } from 'mayura/core/host';

/** Native Cedar UID object. Identifiers are never interpolated into policy source. */
export interface CedarEntityUid { readonly type: string; readonly id: string }
/** Bounded Cedar literal subset: no null, floating point, entity escapes or extension constructors. */
export type CedarAttributeValue = string | boolean | number | readonly CedarAttributeValue[] | { readonly [key: string]: CedarAttributeValue };
export interface CedarAuthorizationAttributes {
  readonly principal: Readonly<Record<string, CedarAttributeValue>>;
  readonly resource: Readonly<Record<string, CedarAttributeValue>>;
  readonly context: Readonly<Record<string, CedarAttributeValue>>;
}
export interface CedarAuthorizationMapping {
  readonly kind: AuthorizationResourceKind; readonly action: string;
  readonly resourceType: string; readonly actionId: string;
}
/** Native stateless cedar-wasm isAuthorized input, restricted to static policies and literal attributes. */
export interface CedarAuthorizationCall {
  readonly principal: CedarEntityUid; readonly action: CedarEntityUid; readonly resource: CedarEntityUid;
  readonly context: Readonly<Record<string, CedarAttributeValue>>;
  readonly schema: string; readonly validateRequest: true;
  readonly policies: { readonly staticPolicies: Readonly<Record<string, string>> };
  readonly entities: readonly { readonly uid: CedarEntityUid; readonly attrs: Readonly<Record<string, CedarAttributeValue>>; readonly parents: readonly CedarEntityUid[] }[];
}
/** Inject native isAuthorized, or a worker wrapper preserving its complete success/failure diagnostics. */
export type CedarAuthorizationEvaluator = (call: CedarAuthorizationCall, context: { readonly signal: AbortSignal }) => unknown | Promise<unknown>;
export interface CedarAuthorizationPolicyOptions {
  /** Host-pinned policy/data revision and exact evaluator implementation version. Both enter the fingerprint. */
  readonly version: string; readonly engineVersion: string;
  readonly namespace: string; readonly principalType: string; readonly actionType: string;
  readonly mappings: readonly CedarAuthorizationMapping[];
  /** Named native static policy sources, and a native Cedar schema source. Neither is caller-controlled. */
  readonly policies: Readonly<Record<string, string>>; readonly schema: string;
  readonly evaluate: CedarAuthorizationEvaluator;
  /** Trusted, read-only attribute source. No entity graph, request identity or policy overrides are accepted. */
  readonly attributes?: (request: AuthorizationRequest, context: { readonly signal: AbortSignal }) => CedarAuthorizationAttributes | Promise<CedarAuthorizationAttributes>;
  /** authz:cedar admits host callbacks; core enforcement/audit require their own grants. */
  readonly permissions?: Permissions;
  /** Whole attribute/evaluation deadline, default 1,000 ms; 1–30,000 ms. Synchronous engines cannot be preempted. */
  readonly timeoutMs?: number;
  /** Unsettled operations, default 32; 1–256. Ignored cancellation retains the slot until settlement. */
  readonly maxConcurrent?: number;
}
export interface CedarAuthorizationPolicy extends AuthorizationPolicy {
  /** Pure identity helper for provisioning/debugging. Unmapped requests return null; invalid scope throws. */
  identities(request: AuthorizationRequest): { readonly principal: CedarEntityUid; readonly action: CedarEntityUid; readonly resource: CedarEntityUid } | null;
  /** Cancels checks and refuses new work; never disposes the caller-owned evaluator. */
  close(): void;
}
export interface CedarAuthorizerOptions extends CedarAuthorizationPolicyOptions {
  readonly audit?: AuthorizerOptions['audit']; readonly limits?: AuthorizerOptions['limits'];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const entityType = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/u;
const actionName = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const bindingKey = (kind: string, action: string) => JSON.stringify([kind, action]);
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'Cedar authorization requires pinned policy/schema/engine revisions, exact scoped mappings and bounded callbacks.'); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bound(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1 || result > max) return invalid(); return result;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const data = value as Record<string, unknown>;
  return `{${Object.keys(data).sort().map(key => `${JSON.stringify(key)}:${canonical(data[key])}`).join(',')}}`;
}
function capture(raw: AuthorizationRequest): AuthorizationRequest {
  const snapshot = jsonValue(raw, { maxBytes: 4096, maxDepth: 4, maxNodes: 32 });
  if (!record(snapshot) || Object.keys(snapshot).sort().join(',') !== 'action,resource,subject') throw new MayuraError('INVALID_INPUT', 'Invalid scoped authorization request.');
  const data = snapshot as unknown as AuthorizationRequest; return authorizationRequest(data.subject, data.action, data.resource);
}
/** Literal-only attributes deliberately exclude implicit/explicit entity references and extension constructors. */
function attributes(raw: unknown): CedarAuthorizationAttributes {
  const data = jsonValue(raw, { maxBytes: 16_384, maxDepth: 8, maxNodes: 2048 });
  const literal = (value: unknown): boolean => typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isSafeInteger(value)) || (Array.isArray(value) ? value.every(literal)
      : record(value) && Object.entries(value).every(([key, entry]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) && literal(entry)));
  if (!record(data) || Object.keys(data).sort().join(',') !== 'context,principal,resource'
    || !['principal', 'resource', 'context'].every(name => record(data[name]) && literal(data[name]))) throw new Error('Invalid trusted Cedar attributes.');
  return freezeJson(data) as unknown as CedarAuthorizationAttributes;
}
/**
 * Scoped, read-only Cedar policy through the core authorization contract. Native parse/evaluation errors deny,
 * including error diagnostics accompanying an allow. No evaluator, credential, policy or schema is discovered.
 */
export function createCedarAuthorizationPolicy(options: CedarAuthorizationPolicyOptions): CedarAuthorizationPolicy {
  let version: string; let namespace: string; let principalType: string; let actionType: string; let schema: string;
  let policies: Readonly<Record<string, string>>; let mappings: ReadonlyMap<string, CedarAuthorizationMapping>;
  let evaluate: CedarAuthorizationEvaluator; let load: CedarAuthorizationPolicyOptions['attributes'];
  let admitted: boolean; let timeoutMs: number; let maxConcurrent: number;
  try {
    if (!options || [options.version, options.engineVersion, options.namespace].some(value => typeof value !== 'string' || !identifier.test(value))
      || [options.principalType, options.actionType].some(value => typeof value !== 'string' || value.length > 128 || !entityType.test(value))
      || options.principalType === options.actionType || typeof options.evaluate !== 'function'
      || (options.attributes !== undefined && typeof options.attributes !== 'function')
      || typeof options.schema !== 'string' || !options.schema.trim() || utf8ByteLength(options.schema) > 65_536) return invalid();
    const sources = jsonValue(options.policies, { maxBytes: 262_144, maxDepth: 1, maxNodes: 257 });
    if (!record(sources) || !Object.keys(sources).length || Object.keys(sources).length > 256
      || !Object.entries(sources).every(([id, source]) => identifier.test(id) && typeof source === 'string' && !!source.trim())) return invalid();
    policies = freezeJson(sources) as Readonly<Record<string, string>>;
    const captured = jsonValue(options.mappings, { maxBytes: 65_536, maxDepth: 2, maxNodes: 2561 });
    if (!Array.isArray(captured) || !captured.length || captured.length > 512) return invalid();
    const mapped = new Map<string, CedarAuthorizationMapping>();
    for (const raw of captured) {
      if (!record(raw) || Object.keys(raw).sort().join(',') !== 'action,actionId,kind,resourceType'
        || !AUTHORIZATION_RESOURCE_KINDS.includes(raw['kind'] as AuthorizationResourceKind)
        || typeof raw['action'] !== 'string' || !actionName.test(raw['action']) || typeof raw['actionId'] !== 'string' || !identifier.test(raw['actionId'])
        || typeof raw['resourceType'] !== 'string' || raw['resourceType'].length > 128 || !entityType.test(raw['resourceType'])
        || raw['resourceType'] === options.actionType) return invalid();
      const binding = freezeJson(raw) as unknown as CedarAuthorizationMapping; const key = bindingKey(binding.kind, binding.action);
      if (mapped.has(key)) return invalid(); mapped.set(key, binding);
    }
    const grants = jsonValue(options.permissions?.allow ?? [], { maxBytes: 1_048_576, maxDepth: 1, maxNodes: 4097 });
    if (!Array.isArray(grants) || grants.length > 4096 || grants.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) return invalid();
    admitted = grants.includes('authz:cedar'); namespace = options.namespace; principalType = options.principalType; actionType = options.actionType;
    schema = options.schema; mappings = mapped; evaluate = options.evaluate; load = options.attributes;
    timeoutMs = bound(options.timeoutMs, 1000, 30_000); maxConcurrent = bound(options.maxConcurrent, 32, 256);
    version = `cedar:${sha256Hex(canonical({ protocol: 'mayura.cedar.v1', revision: options.version, engineVersion: options.engineVersion,
      namespace, principalType, actionType, schema, policies, mappings: [...mapped.values()].sort((a, b) => bindingKey(a.kind, a.action) < bindingKey(b.kind, b.action) ? -1 : 1) }))}`;
  } catch { return invalid(); }
  let closed = false; const active = new Set<AbortController>();
  const deny = (reason: AuthorizationDenyReason): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId: null });
  const identities: CedarAuthorizationPolicy['identities'] = raw => {
    const request = capture(raw); const scope = request.subject;
    if (scope.principalId !== request.resource.scope.principalId || scope.projectId !== request.resource.scope.projectId) throw new MayuraError('INVALID_INPUT', 'The authorization resource does not belong to the verified scope.');
    const mapping = mappings.get(bindingKey(request.resource.kind, request.action)); if (!mapping) return null;
    const identity = (domain: string, extra: readonly string[]) => sha256Hex(JSON.stringify([domain, namespace, scope.projectId, scope.principalId, ...extra]));
    return Object.freeze({ principal: Object.freeze({ type: principalType, id: identity('mayura.cedar.subject.v1', []) }),
      action: Object.freeze({ type: actionType, id: mapping.actionId }),
      resource: Object.freeze({ type: mapping.resourceType, id: identity('mayura.cedar.resource.v1', [request.resource.kind, request.resource.id]) }) });
  };
  const normalize = (raw: unknown): AuthorizationDecision => {
    const answer = jsonValue(raw, { maxBytes: 16_384, maxDepth: 12, maxNodes: 2048 });
    if (!record(answer) || answer['type'] !== 'success' || Object.keys(answer).sort().join(',') !== 'response,type,warnings'
      || !Array.isArray(answer['warnings']) || !record(answer['response'])) return deny('unavailable');
    const response = answer['response']; const diagnostics = response['diagnostics'];
    if (Object.keys(response).sort().join(',') !== 'decision,diagnostics' || !record(diagnostics)
      || Object.keys(diagnostics).sort().join(',') !== 'errors,reason' || !Array.isArray(diagnostics['errors']) || diagnostics['errors'].length
      || !Array.isArray(diagnostics['reason']) || diagnostics['reason'].some(id => typeof id !== 'string' || !Object.hasOwn(policies, id))
      || new Set(diagnostics['reason']).size !== diagnostics['reason'].length) return deny('unavailable');
    if (response['decision'] === 'deny') return deny(diagnostics['reason'].length ? 'explicit_deny' : 'no_match');
    if (response['decision'] !== 'allow' || !diagnostics['reason'].length) return deny('unavailable');
    return Object.freeze({ effect: 'allow', reason: 'allowed', policyVersion: version, ruleId: diagnostics['reason'].length === 1 ? diagnostics['reason'][0] as string : null });
  };
  const authorize: AuthorizationPolicy['authorize'] = async (raw, context) => {
    let request: AuthorizationRequest;
    try { request = capture(raw); if (!(context?.signal instanceof AbortSignal)) return deny('invalid_request'); } catch { return deny('invalid_request'); }
    if (closed || context.signal.aborted) return deny('cancelled');
    if (request.subject.principalId !== request.resource.scope.principalId || request.subject.projectId !== request.resource.scope.projectId) return deny('scope_mismatch');
    if (!admitted) return deny('permission_denied');
    const ids = identities(request); if (!ids) return deny('no_match');
    if (active.size >= maxConcurrent) return deny('limit_exceeded');
    const control = new AbortController(); active.add(control); const deadline = Date.now() + timeoutMs; let expired = false;
    return new Promise<AuthorizationDecision>(resolve => {
      let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (decision: AuthorizationDecision) => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer);
        context.signal.removeEventListener('abort', abort); control.signal.removeEventListener('abort', stopped); resolve(decision); };
      const abort = () => control.abort();
      const stopped = () => finish(deny(expired ? 'unavailable' : 'cancelled'));
      const stoppedOrExpired = () => { if (!control.signal.aborted && Date.now() >= deadline) { expired = true; control.abort(); } return control.signal.aborted || closed; };
      control.signal.addEventListener('abort', stopped, { once: true }); context.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { expired = true; control.abort(); }, timeoutMs);
      if (context.signal.aborted || closed) control.abort();
      // Capacity remains owned by this task even if its observable decision has already timed out.
      void Promise.resolve().then(async () => {
        if (stoppedOrExpired()) return deny(expired ? 'unavailable' : 'cancelled');
        const data = attributes(load ? await load(request, { signal: control.signal }) : { principal: {}, resource: {}, context: {} });
        if (stoppedOrExpired()) return deny(expired ? 'unavailable' : 'cancelled');
        const call: CedarAuthorizationCall = { ...ids, context: data.context, schema, validateRequest: true, policies: { staticPolicies: policies },
          entities: [{ uid: ids.principal, attrs: data.principal, parents: [] }, { uid: ids.resource, attrs: data.resource, parents: [] }] };
        // A fresh mutable copy supports wasm-bindgen conversion without exposing the pinned configuration.
        const result = await evaluate(jsonValue(call, { maxBytes: 360_448, maxDepth: 12, maxNodes: 4096 }) as unknown as CedarAuthorizationCall, { signal: control.signal });
        if (stoppedOrExpired()) return deny(expired ? 'unavailable' : 'cancelled');
        return normalize(result);
      }).then(result => { active.delete(control); finish(stoppedOrExpired() ? deny(expired ? 'unavailable' : 'cancelled') : result); },
        () => { active.delete(control); stoppedOrExpired(); finish(deny(control.signal.aborted ? expired ? 'unavailable' : 'cancelled' : 'unavailable')); });
    });
  };
  return Object.freeze({ version, identities, authorize, close() { if (closed) return; closed = true; for (const control of active) control.abort(); } });
}
/** Core enforcement and audit own the single final receipt; evaluator lifetime remains with its host. */
export function createCedarAuthorizer(options: CedarAuthorizerOptions): Authorizer {
  const policy = createCedarAuthorizationPolicy(options);
  try {
    const authorizer = createAuthorizer({ policy, ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
    return Object.freeze({ ...authorizer, close() { authorizer.close(); policy.close(); } });
  } catch (error) { policy.close(); throw error; }
}
