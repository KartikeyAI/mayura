import { AUTHORIZATION_RESOURCE_KINDS, authorizationRequest, createAuthorizer, freezeJson, jsonValue, MayuraError,
  type AuthorizationDecision, type AuthorizationDenyReason, type AuthorizationPolicy, type AuthorizationRequest,
  type AuthorizationResourceKind, type Authorizer, type AuthorizerOptions, type Permissions } from 'mayura';
import { sha256Hex } from 'mayura/core/host';
import { createCheckTransport, type CheckTransportOptions } from './transport.js';
export type { CheckTransportOptions as OpenFgaTransportOptions } from './transport.js';

/** One exact Mayura resource/action pair, mapped only by trusted host configuration. No wildcard mapping exists. */
export interface OpenFgaAuthorizationRelation {
  readonly kind: AuthorizationResourceKind; readonly action: string; readonly objectType: string; readonly relation: string;
}
/** Native OpenFGA Check tuple. Generated identifiers cannot become a wildcard or a userset. */
export interface OpenFgaTupleKey { readonly user: string; readonly relation: string; readonly object: string }
export interface OpenFgaAuthorizationPolicyOptions extends CheckTransportOptions {
  /** OpenFGA base API URL, optionally with a fixed reverse-proxy path prefix. Never supplied by a caller. */
  readonly apiUrl: string;
  /** Explicit native store and immutable authorization-model IDs. Latest-model discovery is never used. */
  readonly storeId: string; readonly authorizationModelId: string;
  /** Host policy revision; the effective policy version fingerprints it together with model/mapping identity. */
  readonly version: string;
  /** Stable application namespace used for tuple identities; changing it requires reprovisioning relationships. */
  readonly namespace: string;
  /** OpenFGA principal type from the pinned model. */
  readonly userType: string;
  readonly relations: readonly OpenFgaAuthorizationRelation[];
  /** authz:openfga admits transport; core enforcement and audit require their own grants. */
  readonly permissions?: Permissions;
}
export interface OpenFgaAuthorizationPolicy extends AuthorizationPolicy {
  /** Pure provisioning helper. Returns null for unmapped actions; malformed/cross-scope requests throw fixed errors. */
  tuple(request: AuthorizationRequest): OpenFgaTupleKey | null;
  /** Stops admitted checks and refuses future evaluation; no decision cache is retained. */
  close(): void;
}
export interface OpenFgaAuthorizerOptions extends OpenFgaAuthorizationPolicyOptions {
  readonly audit?: AuthorizerOptions['audit']; readonly limits?: AuthorizerOptions['limits'];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const action = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const typeName = /^[A-Za-z][A-Za-z0-9_]{0,49}$/u;
const nativeId = /^[ABCDEFGHJKMNPQRSTVWXYZ0-9]{26}$/u;
const key = (kind: string, action: string) => JSON.stringify([kind, action]);
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'OpenFGA authorization requires explicit pinned store/model identifiers, scoped mappings and bounded transport settings.'); }
function capture(raw: AuthorizationRequest): AuthorizationRequest {
  const snapshot = jsonValue(raw, { maxBytes: 4096, maxDepth: 4, maxNodes: 32 });
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).sort().join(',') !== 'action,resource,subject') {
    throw new MayuraError('INVALID_INPUT', 'Invalid scoped authorization request.');
  }
  const data = snapshot as unknown as AuthorizationRequest;
  return authorizationRequest(data.subject, data.action, data.resource);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(name => `${JSON.stringify(name)}:${canonical(record[name])}`).join(',')}}`;
}
/**
 * Read-only native OpenFGA Check policy. Full verified scope is encoded into tuple identities, so separate Mayura
 * namespaces/principals/projects and resource kinds cannot alias one another through a shared FGA object type.
 * The host provisions the corresponding graph separately; requests cannot inject tuples, conditions or roles.
 */
export function createOpenFgaAuthorizationPolicy(options: OpenFgaAuthorizationPolicyOptions): OpenFgaAuthorizationPolicy {
  let namespace: string; let userType: string; let version: string; let admitted: boolean;
  let endpoint: string; let relations: ReadonlyMap<string, OpenFgaAuthorizationRelation>;
  let transport: ReturnType<typeof createCheckTransport>;
  try {
    if (!options || ['apiUrl', 'storeId', 'authorizationModelId', 'version', 'namespace', 'userType'].some(name => typeof (options as any)[name] !== 'string') || !nativeId.test(options.storeId) || !nativeId.test(options.authorizationModelId)
      || !identifier.test(options.version) || !identifier.test(options.namespace) || !typeName.test(options.userType)) return invalid();
    const captured = jsonValue(options.relations, { maxBytes: 65_536, maxDepth: 2, maxNodes: 2561 });
    if (!Array.isArray(captured) || captured.length < 1 || captured.length > 512) return invalid();
    const mapped = new Map<string, OpenFgaAuthorizationRelation>();
    for (const raw of captured) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'action,kind,objectType,relation'
        || !AUTHORIZATION_RESOURCE_KINDS.includes(raw['kind'] as AuthorizationResourceKind) || typeof raw['action'] !== 'string' || !action.test(raw['action'])
        || typeof raw['objectType'] !== 'string' || !typeName.test(raw['objectType']) || typeof raw['relation'] !== 'string' || !typeName.test(raw['relation'])) return invalid();
      const binding = freezeJson(raw) as unknown as OpenFgaAuthorizationRelation; const name = key(binding.kind, binding.action);
      if (mapped.has(name)) return invalid(); mapped.set(name, binding);
    }
    const grants = jsonValue(options.permissions?.allow ?? [], { maxBytes: 1_048_576, maxDepth: 1, maxNodes: 4097 });
    if (!Array.isArray(grants) || grants.length > 4096 || grants.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) return invalid();
    admitted = grants.includes('authz:openfga'); namespace = options.namespace; userType = options.userType; relations = mapped;
    const base = new URL(options.apiUrl);
    if (typeof options.apiUrl !== 'string' || options.apiUrl.length > 2048 || base.username || base.password || base.search || base.hash
      || !base.hostname || (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== 'boolean')
      || (base.protocol !== 'https:' && !(options.allowInsecureLoopback === true && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))) return invalid();
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/stores/${options.storeId}/check`; endpoint = base.href;
    version = `openfga:${sha256Hex(canonical({ protocol: 'mayura.openfga.v1', endpoint, model: options.authorizationModelId,
      revision: options.version, namespace, userType, relations: [...mapped.values()].sort((a, b) => key(a.kind, a.action) < key(b.kind, b.action) ? -1 : 1) }))}`;
    transport = createCheckTransport(endpoint, options.authorizationModelId, options);
  } catch { return invalid(); }
  let closed = false;
  const deny = (reason: AuthorizationDenyReason): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId: null });
  const tuple = (raw: AuthorizationRequest): OpenFgaTupleKey | null => {
    const request = capture(raw); const scope = request.subject;
    if (scope.principalId !== request.resource.scope.principalId || scope.projectId !== request.resource.scope.projectId) {
      throw new MayuraError('INVALID_INPUT', 'The authorization resource does not belong to the verified scope.');
    }
    const binding = relations.get(key(request.resource.kind, request.action)); if (!binding) return null;
    const identity = (domain: string, values: readonly string[]) => sha256Hex(JSON.stringify([domain, namespace, scope.projectId, scope.principalId, ...values]));
    return Object.freeze({ user: `${userType}:${identity('mayura.openfga.subject.v1', [])}`, relation: binding.relation,
      object: `${binding.objectType}:${identity('mayura.openfga.resource.v1', [request.resource.kind, request.resource.id])}` });
  };
  const authorize: AuthorizationPolicy['authorize'] = async (raw, context) => {
    let request: AuthorizationRequest;
    try { request = capture(raw); if (!(context?.signal instanceof AbortSignal)) return deny('invalid_request'); }
    catch { return deny('invalid_request'); }
    if (closed || context.signal.aborted) return deny('cancelled');
    if (request.subject.principalId !== request.resource.scope.principalId || request.subject.projectId !== request.resource.scope.projectId) return deny('scope_mismatch');
    if (!admitted) return deny('permission_denied');
    const mapped = tuple(request); if (!mapped) return deny('no_match');
    const result = await transport.check(mapped, context.signal);
    if (closed || context.signal.aborted) return deny('cancelled');
    return result === true ? Object.freeze({ effect: 'allow', reason: 'allowed', policyVersion: version, ruleId: null })
      : deny(result === false ? 'no_match' : result);
  };
  return Object.freeze({ version, tuple, authorize, close() { if (closed) return; closed = true; transport.close(); } });
}
/** Core enforcement/audit emit one final decision event; closing also owns the OpenFGA transport lifecycle. */
export function createOpenFgaAuthorizer(options: OpenFgaAuthorizerOptions): Authorizer {
  const policy = createOpenFgaAuthorizationPolicy(options);
  try {
    const authorizer = createAuthorizer({ policy, ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
    return Object.freeze({ ...authorizer, close() { authorizer.close(); policy.close(); } });
  } catch (error) { policy.close(); throw error; }
}
