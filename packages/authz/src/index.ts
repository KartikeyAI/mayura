import { AUTHORIZATION_RESOURCE_KINDS, authorizationRequest, createAuthorizer, freezeJson, jsonValue, MayuraError,
  type AuthorizationDecision, type AuthorizationDenyReason, type AuthorizationPolicy, type AuthorizationRequest,
  type AuthorizationResourceKind, type AuthorizationSubject, type Authorizer, type AuthorizerOptions } from '@mayura/core';

export interface RbacResourceSelector {
  readonly kind: AuthorizationResourceKind;
  /** Exact resource id, or an explicit * for all ids within the verified subject scope. */
  readonly id: string;
  /** Optional ownership condition, compared against trusted stored ownerId metadata. */
  readonly owner?: 'subject';
}
export interface RbacRule {
  readonly id: string;
  readonly effect: 'allow' | 'deny';
  /** Exact action names only. There are no action wildcards or implicit administrative roles. */
  readonly actions: readonly string[];
  readonly resource: RbacResourceSelector;
}
export interface RbacRole {
  readonly id: string;
  readonly inherits?: readonly string[];
  readonly rules: readonly RbacRule[];
}
export interface RbacBinding {
  readonly subject: AuthorizationSubject;
  readonly roles: readonly string[];
}
export interface RbacPolicyOptions {
  readonly version: string;
  readonly roles: readonly RbacRole[];
  readonly bindings: readonly RbacBinding[];
  readonly limits?: {
    readonly maxRoles?: number; readonly maxRules?: number; readonly maxBindings?: number;
    readonly maxRoleDepth?: number; readonly maxPolicyBytes?: number;
  };
}
export interface RbacAuthorizerOptions extends Omit<AuthorizerOptions, 'policy'> { readonly policy: RbacPolicyOptions }
interface CompiledRule { readonly rule: RbacRule; readonly actions: ReadonlySet<string> }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const actionName = /^[a-z][a-z0-9_.:-]{0,127}$/u;
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'RBAC requires bounded versioned roles, rules and scoped bindings without cycles or unknown references.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function id(value: unknown): void { if (typeof value !== 'string' || !identifier.test(value)) invalid(); }
const subjectKey = (value: AuthorizationSubject): string => JSON.stringify([value.principalId, value.projectId]);
/** Compile immutable local policy once. No I/O, provider, server, database or user-asserted role resolution. */
export function createRbacPolicy(options: RbacPolicyOptions): AuthorizationPolicy {
  const settings = options?.limits ?? {};
  if (!settings || typeof settings !== 'object' || Object.keys(settings).some(key => !['maxRoles', 'maxRules', 'maxBindings', 'maxRoleDepth', 'maxPolicyBytes'].includes(key))) invalid();
  const bound = (value: number | undefined, fallback: number, maximum: number): number => {
    const actual = value ?? fallback; if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) invalid(); return actual;
  };
  const maxRoles = bound(settings.maxRoles, 128, 256); const maxRules = bound(settings.maxRules, 1024, 2048);
  const maxBindings = bound(settings.maxBindings, 2048, 8192); const maxDepth = bound(settings.maxRoleDepth, 16, 32);
  const maxBytes = bound(settings.maxPolicyBytes, 1_048_576, 4_194_304);
  let captured: RbacPolicyOptions;
  try { captured = freezeJson(jsonValue(options, { maxBytes, maxDepth: 12, maxNodes: 500_000 })) as unknown as RbacPolicyOptions; } catch { return invalid(); }
  const raw = object(captured); fields(raw, ['version', 'roles', 'bindings'], ['limits']); id(captured.version);
  if (!Array.isArray(captured.roles) || captured.roles.length > maxRoles || !Array.isArray(captured.bindings) || captured.bindings.length > maxBindings) invalid();
  const roles = new Map<string, RbacRole>(); const compiled = new Map<string, CompiledRule>();
  for (const role of captured.roles) {
    fields(object(role), ['id', 'rules'], ['inherits']); id(role.id);
    if (roles.has(role.id) || !Array.isArray(role.rules) || role.rules.length > maxRules) invalid();
    const parents = role.inherits ?? [];
    if (!Array.isArray(parents) || parents.length > 32 || new Set(parents).size !== parents.length) invalid();
    parents.forEach(id); roles.set(role.id, role);
    for (const rule of role.rules) {
      fields(object(rule), ['id', 'effect', 'actions', 'resource']); id(rule.id);
      if (compiled.has(rule.id) || !['allow', 'deny'].includes(rule.effect) || !Array.isArray(rule.actions) || !rule.actions.length
        || rule.actions.length > 32 || new Set(rule.actions).size !== rule.actions.length || rule.actions.some((action: unknown) => typeof action !== 'string' || !actionName.test(action))) invalid();
      const selector = object(rule.resource); fields(selector, ['kind', 'id'], ['owner']);
      if (!AUTHORIZATION_RESOURCE_KINDS.includes(rule.resource.kind) || (rule.resource.id !== '*' && (typeof rule.resource.id !== 'string' || !identifier.test(rule.resource.id)))
        || (rule.resource.owner !== undefined && rule.resource.owner !== 'subject')) invalid();
      compiled.set(rule.id, { rule, actions: new Set(rule.actions) }); if (compiled.size > maxRules) invalid();
    }
  }
  const expanded = new Map<string, readonly CompiledRule[]>(); const heights = new Map<string, number>(); const visiting = new Set<string>();
  const expand = (name: string, depth: number): readonly CompiledRule[] => {
    if (depth > maxDepth || visiting.has(name)) invalid();
    const prior = expanded.get(name);
    if (prior) { if (depth + heights.get(name)! - 1 > maxDepth) invalid(); return prior; }
    const role = roles.get(name); if (!role) return invalid(); visiting.add(name);
    const rules = new Map(role.rules.map(rule => [rule.id, compiled.get(rule.id)!])); let height = 1;
    for (const parent of role.inherits ?? []) {
      for (const entry of expand(parent, depth + 1)) rules.set(entry.rule.id, entry);
      height = Math.max(height, 1 + heights.get(parent)!);
    }
    visiting.delete(name); heights.set(name, height);
    const ordered = Object.freeze([...rules.values()].sort((a, b) => a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));
    expanded.set(name, ordered); return ordered;
  };
  for (const name of roles.keys()) expand(name, 1);
  // Only configured memberships are cached. Evaluating arbitrary principals cannot grow this map.
  const memberships = new Map<string, readonly CompiledRule[]>();
  const selections = new Map<string, readonly CompiledRule[]>();
  for (const binding of captured.bindings) {
    fields(object(binding), ['subject', 'roles']); const subject = object(binding.subject); fields(subject, ['principalId', 'projectId']);
    id(binding.subject.principalId); id(binding.subject.projectId);
    if (!Array.isArray(binding.roles) || binding.roles.length < 1 || binding.roles.length > 32 || new Set(binding.roles).size !== binding.roles.length) invalid();
    const key = subjectKey(binding.subject); if (memberships.has(key)) invalid();
    const selection = JSON.stringify([...binding.roles].sort()); let selected = selections.get(selection);
    if (!selected) {
      const rules = new Map<string, CompiledRule>();
      for (const name of binding.roles) {
        id(name); const entries = expanded.get(name); if (!entries) return invalid();
        for (const entry of entries) rules.set(entry.rule.id, entry);
      }
      selected = Object.freeze([...rules.values()].sort((a, b) => a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));
      selections.set(selection, selected);
    }
    memberships.set(key, selected);
  }
  const version = captured.version;
  const deny = (reason: AuthorizationDenyReason, ruleId: string | null = null): AuthorizationDecision => Object.freeze({ effect: 'deny', reason, policyVersion: version, ruleId });
  return Object.freeze({ version,
    authorize(supplied: AuthorizationRequest, context: { readonly signal: AbortSignal }): AuthorizationDecision {
      let request: AuthorizationRequest;
      try {
        request = authorizationRequest(supplied.subject, supplied.action, supplied.resource);
        if (!(context?.signal instanceof AbortSignal)) return deny('invalid_request');
      } catch { return deny('invalid_request'); }
      if (context.signal.aborted) return deny('cancelled');
      const { subject, action, resource } = request;
      if (subject.principalId !== resource.scope.principalId || subject.projectId !== resource.scope.projectId) return deny('scope_mismatch');
      let allow: string | null = null;
      for (const entry of memberships.get(subjectKey(subject)) ?? []) {
        if (context.signal.aborted) return deny('cancelled');
        const { rule } = entry;
        if (!entry.actions.has(action) || rule.resource.kind !== resource.kind || (rule.resource.id !== '*' && rule.resource.id !== resource.id)
          || (rule.resource.owner === 'subject' && resource.ownerId !== subject.principalId)) continue;
        if (rule.effect === 'deny') return deny('explicit_deny', rule.id);
        allow ??= rule.id;
      }
      return allow === null ? deny('no_match') : Object.freeze({ effect: 'allow', reason: 'allowed', policyVersion: version, ruleId: allow });
    },
  });
}
/** Built-in RBAC behind the same explicit grant, cancellation, scope and deadline boundary as any external policy. */
export function createRbacAuthorizer(options: RbacAuthorizerOptions): Authorizer {
  if (!options || typeof options !== 'object') return invalid();
  return createAuthorizer({ policy: createRbacPolicy(options.policy),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }), ...(options.limits === undefined ? {} : { limits: options.limits }) });
}
