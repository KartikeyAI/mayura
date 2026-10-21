import { AUTHORIZATION_RESOURCE_KINDS, authorizationRequest, createAuthorizer, freezeJson, jsonValue, MayuraError,
  type AuthorizationDecision, type AuthorizationDenyReason, type AuthorizationPolicy, type AuthorizationRequest,
  type AuthorizationResourceKind, type Authorizer, type AuthorizerOptions, type Permissions } from 'mayura';
import { sha256Hex } from 'mayura/core/host';
import { createPermitTransport, type PermitTransportOptions } from './transport.js';
export type { PermitTransportOptions } from './transport.js';

/** Exact trusted Mayura resource/action to native Permit.io resource type/action mapping. */
export interface PermitAuthorizationMapping {
  readonly kind: AuthorizationResourceKind; readonly action: string;
  readonly resourceType: string; readonly permitAction: string;
}
/** Native /allowed input. Instance keys and tenant are always explicit; caller attributes/context are excluded. */
export interface PermitAuthorizationInput {
  readonly user: { readonly key: string }; readonly action: string;
  readonly resource: { readonly type: string; readonly key: string; readonly tenant: string };
  readonly context: Readonly<Record<string, never>>;
}
export interface PermitAuthorizationPolicyOptions extends PermitTransportOptions {
  /** Trusted PDP base URL, optionally including a fixed reverse-proxy prefix. No discovery or control-plane calls. */
  readonly pdpUrl: string;
  /** Fixed environment-scoped PDP credential. Never read from the caller or the environment. */
  readonly apiKey: string;
  /** Host assertion of credential/PDP environment identity; the native boolean response cannot attest it. */
  readonly environmentId: string;
  /** Host deployment revision. The PDP does not pin or echo this value; keep deployment and data in sync. */
  readonly version: string;
  /** Stable application namespace used for scoped provisioning identities. */
  readonly namespace: string;
  readonly mappings: readonly PermitAuthorizationMapping[];
  /** authz:permit admits provider transport. Core enforcement and audit require their separate grants. */
  readonly permissions?: Permissions;
}
export interface PermitAuthorizationPolicy extends AuthorizationPolicy {
  /** Pure provisioning helper. Unmapped actions return null; malformed or cross-scope requests throw fixed errors. */
  input(request: AuthorizationRequest): PermitAuthorizationInput | null;
  /** Refuse new checks and cancel admitted work without writing or replaying provisioning data. */
  close(): void;
}
export interface PermitAuthorizerOptions extends PermitAuthorizationPolicyOptions {
  readonly audit?: AuthorizerOptions['audit']; readonly limits?: AuthorizerOptions['limits'];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const action = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const nativeName = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const key = (kind: string, action: string) => JSON.stringify([kind, action]);
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'Permit.io authorization requires explicit PDP/environment settings, scoped mappings and bounded transport.'); }
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
 * Native Permit.io PDP policy with full-scope identities and explicit project tenants. The host provisions policy,
 * users, tenants, role assignments, instance attributes and relationships separately. Checks never synchronize data.
 * The effective version fingerprints configuration, not an attested native policy revision or consistency receipt.
 */
export function createPermitAuthorizationPolicy(options: PermitAuthorizationPolicyOptions): PermitAuthorizationPolicy {
  let namespace: string; let version: string; let admitted: boolean;
  let mappings: ReadonlyMap<string, PermitAuthorizationMapping>; let transport: ReturnType<typeof createPermitTransport>;
  try {
    if (!options || [options.version, options.namespace, options.environmentId].some(value => typeof value !== 'string' || !identifier.test(value))
      || typeof options.pdpUrl !== 'string' || options.pdpUrl.length > 2048
      || (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== 'boolean')) return invalid();
    const base = new URL(options.pdpUrl);
    if (base.username || base.password || base.search || base.hash || !base.hostname
      || (base.protocol !== 'https:' && !(options.allowInsecureLoopback === true && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))) return invalid();
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/allowed`; const endpoint = base.href;
    const captured = jsonValue(options.mappings, { maxBytes: 65_536, maxDepth: 2, maxNodes: 2561 });
    if (!Array.isArray(captured) || captured.length < 1 || captured.length > 512) return invalid();
    const mapped = new Map<string, PermitAuthorizationMapping>();
    for (const raw of captured) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'action,kind,permitAction,resourceType'
        || !AUTHORIZATION_RESOURCE_KINDS.includes(raw['kind'] as AuthorizationResourceKind) || typeof raw['action'] !== 'string' || !action.test(raw['action'])
        || typeof raw['resourceType'] !== 'string' || !nativeName.test(raw['resourceType']) || typeof raw['permitAction'] !== 'string' || !nativeName.test(raw['permitAction'])) return invalid();
      const binding = freezeJson(raw) as unknown as PermitAuthorizationMapping; const name = key(binding.kind, binding.action);
      if (mapped.has(name)) return invalid(); mapped.set(name, binding);
    }
    const grants = jsonValue(options.permissions?.allow ?? [], { maxBytes: 1_048_576, maxDepth: 1, maxNodes: 4097 });
    if (!Array.isArray(grants) || grants.length > 4096 || grants.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) return invalid();
    admitted = grants.includes('authz:permit'); namespace = options.namespace; mappings = mapped;
    version = `permit:${sha256Hex(canonical({ protocol: 'mayura.permit.v1', endpoint, environmentId: options.environmentId,
      revision: options.version, namespace, mappings: [...mapped.values()].sort((a, b) => key(a.kind, a.action) < key(b.kind, b.action) ? -1 : 1) }))}`;
    transport = createPermitTransport(endpoint, options.apiKey, options);
  } catch { return invalid(); }
  let closed = false;
  const deny = (reason: AuthorizationDenyReason): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId: null });
  const input: PermitAuthorizationPolicy['input'] = raw => {
    const request = capture(raw); const scope = request.subject;
    if (scope.principalId !== request.resource.scope.principalId || scope.projectId !== request.resource.scope.projectId) {
      throw new MayuraError('INVALID_INPUT', 'The authorization resource does not belong to the verified scope.');
    }
    const binding = mappings.get(key(request.resource.kind, request.action)); if (!binding) return null;
    const identity = (domain: string, values: readonly string[]) => sha256Hex(JSON.stringify([domain, namespace, scope.projectId, scope.principalId, ...values]));
    return Object.freeze({ user: Object.freeze({ key: identity('mayura.permit.subject.v1', []) }), action: binding.permitAction,
      resource: Object.freeze({ type: binding.resourceType, key: identity('mayura.permit.resource.v1', [request.resource.kind, request.resource.id]),
        tenant: sha256Hex(JSON.stringify(['mayura.permit.tenant.v1', namespace, scope.projectId])) }), context: Object.freeze({}) });
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
/** One final core enforcement/audit receipt per check; closing owns the Permit.io transport lifecycle. */
export function createPermitAuthorizer(options: PermitAuthorizerOptions): Authorizer {
  const policy = createPermitAuthorizationPolicy(options);
  try {
    const authorizer = createAuthorizer({ policy, ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
    return Object.freeze({ ...authorizer, close() { authorizer.close(); policy.close(); } });
  } catch (error) { policy.close(); throw error; }
}
