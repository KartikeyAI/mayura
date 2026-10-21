import { AUTHORIZATION_RESOURCE_KINDS, authorizationRequest, createAuthorizer, freezeJson, jsonValue, MayuraError,
  type AuthorizationDecision, type AuthorizationDenyReason, type AuthorizationPolicy, type AuthorizationRequest,
  type AuthorizationResourceKind, type Authorizer, type AuthorizerOptions, type Permissions } from 'mayura';
import { sha256Hex } from 'mayura/core/host';
import { createOsoTransport, type OsoTransportOptions } from './transport.js';
export type { OsoTransportOptions } from './transport.js';

/** Exact trusted Mayura resource/action to native Oso resource type/action mapping. No inferred grants. */
export interface OsoAuthorizationMapping {
  readonly kind: AuthorizationResourceKind; readonly action: string;
  readonly resourceType: string; readonly osoAction: string;
}
/** Native Oso Cloud single authorization input. Facts, variables and policy overrides are deliberately absent. */
export interface OsoAuthorizationInput {
  readonly actor_type: string; readonly actor_id: string; readonly action: string;
  readonly resource_type: string; readonly resource_id: string;
}
export interface OsoAuthorizationPolicyOptions extends OsoTransportOptions {
  /** Explicit service base URL, optionally with a fixed reverse-proxy prefix. Appends /api/authorize. */
  readonly apiUrl: string;
  /** Fixed environment credential; never read from an incoming request or ambient environment. */
  readonly apiKey: string;
  /** Host assertion of credential/environment identity. Native check results cannot attest this value. */
  readonly environmentId: string;
  /** Host deployment revision, not a native policy pin. Update with policy/data semantics changes. */
  readonly version: string;
  /** Stable application namespace; changing it requires separate fact provisioning. */
  readonly namespace: string;
  /** Actor type declared by the host's deployed Polar policy. */
  readonly actorType: string;
  readonly mappings: readonly OsoAuthorizationMapping[];
  /** authz:oso admits provider I/O; core evaluation/audit retain their separate grants. */
  readonly permissions?: Permissions;
}
export interface OsoAuthorizationPolicy extends AuthorizationPolicy {
  /** Pure fact-provisioning helper. Unmapped actions return null; malformed or mismatched scope throws fixed errors. */
  input(request: AuthorizationRequest): OsoAuthorizationInput | null;
  /** Refuse new work and cancel admitted transport. Never writes facts, policies or tool results. */
  close(): void;
}
export interface OsoAuthorizerOptions extends OsoAuthorizationPolicyOptions {
  readonly audit?: AuthorizerOptions['audit']; readonly limits?: AuthorizerOptions['limits'];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const action = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const nativeType = /^[A-Z][A-Za-z0-9_]{0,127}$/u;
const nativeAction = /^[a-z][a-z0-9_-]{0,127}$/u;
const key = (kind: string, action: string) => JSON.stringify([kind, action]);
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'Oso authorization requires explicit service/environment settings, scoped mappings and bounded transport.'); }
function capture(raw: AuthorizationRequest): AuthorizationRequest {
  const snapshot = jsonValue(raw, { maxBytes: 4096, maxDepth: 4, maxNodes: 32 });
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).sort().join(',') !== 'action,resource,subject') {
    throw new MayuraError('INVALID_INPUT', 'Invalid scoped authorization request.');
  }
  const data = snapshot as unknown as AuthorizationRequest; return authorizationRequest(data.subject, data.action, data.resource);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(name => `${JSON.stringify(name)}:${canonical(record[name])}`).join(',')}}`;
}
/**
 * Read-only native Oso Cloud checks with full verified principal/project/namespace encoded in both typed IDs.
 * The host deploys Polar and provisions facts separately; requests cannot inject facts, queries or policy source.
 * Configuration fingerprints describe host deployment identity, not an attested service revision or data watermark.
 */
export function createOsoAuthorizationPolicy(options: OsoAuthorizationPolicyOptions): OsoAuthorizationPolicy {
  let namespace: string; let actorType: string; let version: string; let admitted: boolean;
  let mappings: ReadonlyMap<string, OsoAuthorizationMapping>; let transport: ReturnType<typeof createOsoTransport>;
  try {
    if (!options || [options.version, options.namespace, options.environmentId].some(value => typeof value !== 'string' || !identifier.test(value))
      || typeof options.actorType !== 'string' || !nativeType.test(options.actorType)
      || typeof options.apiUrl !== 'string' || options.apiUrl.length > 2048
      || (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== 'boolean')) return invalid();
    const base = new URL(options.apiUrl);
    if (base.username || base.password || base.search || base.hash || !base.hostname
      || (base.protocol !== 'https:' && !(options.allowInsecureLoopback === true && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))) return invalid();
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/authorize`; const endpoint = base.href;
    const captured = jsonValue(options.mappings, { maxBytes: 65_536, maxDepth: 2, maxNodes: 2561 });
    if (!Array.isArray(captured) || captured.length < 1 || captured.length > 512) return invalid();
    const mapped = new Map<string, OsoAuthorizationMapping>();
    for (const raw of captured) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'action,kind,osoAction,resourceType'
        || !AUTHORIZATION_RESOURCE_KINDS.includes(raw['kind'] as AuthorizationResourceKind) || typeof raw['action'] !== 'string' || !action.test(raw['action'])
        || typeof raw['resourceType'] !== 'string' || !nativeType.test(raw['resourceType']) || typeof raw['osoAction'] !== 'string' || !nativeAction.test(raw['osoAction'])) return invalid();
      const binding = freezeJson(raw) as unknown as OsoAuthorizationMapping; const name = key(binding.kind, binding.action);
      if (mapped.has(name)) return invalid(); mapped.set(name, binding);
    }
    const grants = jsonValue(options.permissions?.allow ?? [], { maxBytes: 1_048_576, maxDepth: 1, maxNodes: 4097 });
    if (!Array.isArray(grants) || grants.length > 4096 || grants.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) return invalid();
    admitted = grants.includes('authz:oso'); namespace = options.namespace; actorType = options.actorType; mappings = mapped;
    version = `oso:${sha256Hex(canonical({ protocol: 'mayura.oso.v1', endpoint, environmentId: options.environmentId,
      revision: options.version, namespace, actorType, mappings: [...mapped.values()].sort((a, b) => key(a.kind, a.action) < key(b.kind, b.action) ? -1 : 1) }))}`;
    transport = createOsoTransport(endpoint, options.apiKey, options);
  } catch { return invalid(); }
  let closed = false;
  const deny = (reason: AuthorizationDenyReason): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId: null });
  const input: OsoAuthorizationPolicy['input'] = raw => {
    const request = capture(raw); const scope = request.subject;
    if (scope.principalId !== request.resource.scope.principalId || scope.projectId !== request.resource.scope.projectId) {
      throw new MayuraError('INVALID_INPUT', 'The authorization resource does not belong to the verified scope.');
    }
    const binding = mappings.get(key(request.resource.kind, request.action)); if (!binding) return null;
    const identity = (domain: string, values: readonly string[]) => sha256Hex(JSON.stringify([domain, namespace, scope.projectId, scope.principalId, ...values]));
    return Object.freeze({ actor_type: actorType, actor_id: identity('mayura.oso.actor.v1', []), action: binding.osoAction,
      resource_type: binding.resourceType, resource_id: identity('mayura.oso.resource.v1', [request.resource.kind, request.resource.id]) });
  };
  const authorize: AuthorizationPolicy['authorize'] = async (raw, context) => {
    let request: AuthorizationRequest;
    try { request = capture(raw); if (!(context?.signal instanceof AbortSignal)) return deny('invalid_request'); } catch { return deny('invalid_request'); }
    if (closed || context.signal.aborted) return deny('cancelled');
    if (request.subject.principalId !== request.resource.scope.principalId || request.subject.projectId !== request.resource.scope.projectId) return deny('scope_mismatch');
    if (!admitted) return deny('permission_denied');
    const mapped = input(request); if (!mapped) return deny('no_match');
    const result = await transport.check(mapped, context.signal);
    if (closed || context.signal.aborted) return deny('cancelled');
    return result === true ? Object.freeze({ effect: 'allow', reason: 'allowed', policyVersion: version, ruleId: null }) : deny(result === false ? 'no_match' : result);
  };
  return Object.freeze({ version, input, authorize, close() { if (closed) return; closed = true; transport.close(); } });
}
/** Core enforcement/audit own the final receipt; closing also shuts down the policy transport. */
export function createOsoAuthorizer(options: OsoAuthorizerOptions): Authorizer {
  const policy = createOsoAuthorizationPolicy(options);
  try {
    const authorizer = createAuthorizer({ policy, ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
    return Object.freeze({ ...authorizer, close() { authorizer.close(); policy.close(); } });
  } catch (error) { policy.close(); throw error; }
}
