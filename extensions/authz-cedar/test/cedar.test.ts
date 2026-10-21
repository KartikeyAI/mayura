import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorizationAuditEvent } from 'mayura';
import { createCedarAuthorizationPolicy, createCedarAuthorizer, type CedarAuthorizationPolicyOptions } from '../src/index.js';

const scope = { principalId: 'alice', projectId: 'shop' };
const request = { subject: scope, action: 'read', resource: { kind: 'thread' as const, id: 'chat', scope } };
const answer = (decision = 'allow', reason: string[] = ['read'], errors: unknown[] = []) => ({ type: 'success', response: { decision, diagnostics: { reason, errors } }, warnings: [] });
const config = { version: 'shop-v1', engineVersion: '4.10.0', namespace: 'shop', principalType: 'Shop::User', actionType: 'Shop::Action',
  mappings: [{ kind: 'thread' as const, action: 'read', resourceType: 'Shop::Thread', actionId: 'read' }],
  policies: { read: 'permit(principal, action == Shop::Action::"read", resource);' },
  schema: 'namespace Shop { entity User; entity Thread; action read appliesTo { principal: User, resource: Thread, context: {} }; }',
  permissions: { allow: ['authz:cedar'] } };
const owners: { close(): void }[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
const context = () => ({ signal: new AbortController().signal });
function setup(extra: Partial<CedarAuthorizationPolicyOptions> = {}) {
  const evaluate = vi.fn(() => answer()); const policy = createCedarAuthorizationPolicy({ ...config, evaluate, ...extra });
  owners.push(policy); return { policy, evaluate };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('scoped native Cedar authorization (offline)', () => {
  it('passes pinned native policy/schema, exact action UIDs and trusted literal attributes', async () => {
    const attributes = vi.fn(() => ({ principal: { roles: ['reader'] }, resource: { published: true }, context: { hour: 9 } }));
    const { policy, evaluate } = setup({ attributes }); expect(evaluate).not.toHaveBeenCalled();
    expect(await policy.authorize(request, context())).toEqual({ effect: 'allow', reason: 'allowed', policyVersion: policy.version, ruleId: 'read' });
    expect(evaluate).toHaveBeenCalledTimes(1); const call = evaluate.mock.calls[0] as unknown as [any];
    expect(call[0]).toMatchObject({ ...policy.identities(request), schema: config.schema, validateRequest: true, policies: { staticPolicies: config.policies }, context: { hour: 9 } });
    expect(call[0].entities).toEqual([{ uid: call[0].principal, attrs: { roles: ['reader'] }, parents: [] }, { uid: call[0].resource, attrs: { published: true }, parents: [] }]);
    expect(attributes).toHaveBeenCalledTimes(1);
  });
  it('rejects scope, permission, input injection, unmapped actions and pre-cancellation before callbacks', async () => {
    const { policy, evaluate } = setup();
    expect(await policy.authorize({ ...request, resource: { ...request.resource, scope: { ...scope, projectId: 'other' } } }, context())).toMatchObject({ reason: 'scope_mismatch' });
    expect(await policy.authorize({ ...request, action: 'delete' }, context())).toMatchObject({ reason: 'no_match' });
    for (const injected of [{ ...request, context: { admin: true } }, { ...request, policies: config.policies }, { ...request, subject: { ...scope, roles: ['admin'] } }])
      expect(await policy.authorize(injected as never, context())).toMatchObject({ reason: 'invalid_request' });
    const controller = new AbortController(); controller.abort(); expect(await policy.authorize(request, { signal: controller.signal })).toMatchObject({ reason: 'cancelled' });
    const missing = setup({ permissions: { allow: [] } }); expect(await missing.policy.authorize(request, context())).toMatchObject({ reason: 'permission_denied' });
    expect(missing.evaluate).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });
  it('isolates principal/project/namespace/kind identities and freezes helper results', () => {
    const { policy } = setup(); const ids = policy.identities(request)!; expect(Object.isFrozen(ids.principal)).toBe(true);
    for (const other of [{ ...scope, principalId: 'bob' }, { ...scope, projectId: 'other' }]) {
      const changed = policy.identities({ ...request, subject: other, resource: { ...request.resource, scope: other } })!;
      expect(changed.principal).not.toEqual(ids.principal); expect(changed.resource).not.toEqual(ids.resource); expect(changed.action).toEqual(ids.action);
    }
    expect(setup({ namespace: 'other' }).policy.identities(request)).not.toEqual(ids);
    const second = setup({ mappings: [...config.mappings, { ...config.mappings[0]!, kind: 'run' }] }).policy;
    expect(second.identities({ ...request, resource: { ...request.resource, kind: 'run' } })!.resource).not.toEqual(ids.resource);
    expect(policy.identities({ ...request, resource: { ...request.resource, ownerId: 'bob' } })).toEqual(ids);
    expect(policy.identities({ ...request, action: 'delete' })).toBeNull();
    expect(() => policy.identities({ ...request, resource: { ...request.resource, scope: { ...scope, principalId: 'bob' } } })).toThrow();
  });
  it('denies native errors even when Cedar also reports allow, and never exposes diagnostic content', async () => {
    for (const raw of [answer('allow', ['read'], [{ error: { message: 'PRIVATE' } }]), { type: 'failure', errors: ['PRIVATE'], warnings: [] },
      answer('allow', []), answer('allow', ['unknown']), answer('allow', ['read', 'read']), { allowed: true }, answer('ALLOW'), null]) {
      const { policy } = setup({ evaluate: () => raw }); const decision = await policy.authorize(request, context());
      expect(decision).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(JSON.stringify(decision)).not.toContain('PRIVATE');
    }
    expect(await setup({ evaluate: () => answer('deny', []) }).policy.authorize(request, context())).toMatchObject({ reason: 'no_match' });
    expect(await setup({ evaluate: () => answer('deny', ['read']) }).policy.authorize(request, context())).toMatchObject({ reason: 'explicit_deny' });
    expect(await setup({ evaluate: () => { throw new Error('PRIVATE'); } }).policy.authorize(request, context())).toMatchObject({ reason: 'unavailable' });
  });
  it('rejects unsafe attributes, oversized snapshots and loader failures without evaluation', async () => {
    for (const value of [null, 1.5, { __entity: { type: 'Admin', id: 'admin' } }, 'x'.repeat(20_000)]) {
      const { policy, evaluate } = setup({ attributes: () => ({ principal: { value }, resource: {}, context: {} }) as never });
      expect(await policy.authorize(request, context())).toMatchObject({ reason: 'unavailable' }); expect(evaluate).not.toHaveBeenCalled();
    }
    const failed = setup({ attributes: () => { throw new Error('PRIVATE'); } });
    expect(await failed.policy.authorize(request, context())).toMatchObject({ reason: 'unavailable' }); expect(failed.evaluate).not.toHaveBeenCalled();
  });
  it('fingerprints policies, schema, mappings and engine/data revisions and snapshots configuration', async () => {
    const mutable = { ...config.policies }; const { policy, evaluate } = setup({ policies: mutable }); mutable.read = 'forbid(principal, action, resource);';
    await policy.authorize(request, context()); expect((evaluate.mock.calls[0] as unknown as [any])[0].policies.staticPolicies.read).toBe(config.policies.read);
    for (const extra of [{ version: 'v2' }, { engineVersion: 'v2' }, { schema: config.schema + ' ' }, { policies: mutable }, { namespace: 'other' },
      { mappings: [{ ...config.mappings[0]!, actionId: 'other' }] }]) expect(setup(extra).policy.version).not.toBe(policy.version);
    const mappings = [...config.mappings, { ...config.mappings[0]!, action: 'write', actionId: 'write' }];
    expect(setup({ mappings }).policy.version).toBe(setup({ mappings: [...mappings].reverse() }).policy.version);
  });
  it('retains capacity through ignored evaluator timeout and suppresses late allows', async () => {
    vi.useFakeTimers(); const pending = deferred<unknown>(); const evaluate = vi.fn(() => pending.promise);
    const { policy } = setup({ evaluate, timeoutMs: 10, maxConcurrent: 1 }); const first = policy.authorize(request, context());
    await vi.advanceTimersByTimeAsync(10); expect(await first).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(evaluate).toHaveBeenCalledTimes(1);
    pending.resolve(answer()); await vi.advanceTimersByTimeAsync(0); expect(await first).toMatchObject({ effect: 'deny' });
    expect(await policy.authorize(request, context())).toMatchObject({ effect: 'allow' });
  });
  it('cancels loading without evaluating and retains capacity until the loader settles', async () => {
    const pending = deferred<any>(); const { policy, evaluate } = setup({ attributes: () => pending.promise, maxConcurrent: 1 });
    const controller = new AbortController(); const first = policy.authorize(request, { signal: controller.signal }); await Promise.resolve(); controller.abort();
    expect(await first).toMatchObject({ reason: 'cancelled' }); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' });
    pending.resolve({ principal: {}, resource: {}, context: {} }); await Promise.resolve(); await Promise.resolve(); expect(evaluate).not.toHaveBeenCalled();
    policy.close(); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' });
  });
  it('denies synchronous evaluation that completes beyond the deadline', async () => {
    let now = 0; const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try { const { policy } = setup({ timeoutMs: 10, evaluate: () => { now = 11; return answer(); } }); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'unavailable' }); }
    finally { clock.mockRestore(); }
  });
  it('emits one core audit receipt, excludes attributes and requires independent core grants', async () => {
    const events: AuthorizationAuditEvent[] = []; const authorizer = createCedarAuthorizer({ ...config, evaluate: () => answer(),
      permissions: { allow: ['authz:evaluate', 'authz:cedar', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(authorizer);
    await authorizer.authorize(scope, 'read', request.resource); await authorizer.flushAudit(); expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(config.policies.read);
    const denied = createCedarAuthorizer({ ...config, evaluate: () => answer() }); owners.push(denied);
    expect(await denied.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'permission_denied' });
  });
  it('rejects invalid construction without invoking the evaluator', () => {
    const evaluate = vi.fn(() => answer());
    for (const extra of [{ version: '' }, { engineVersion: '*' }, { schema: '' }, { policies: {} }, { mappings: [] }, { mappings: [config.mappings[0]!, config.mappings[0]!] },
      { mappings: [{ ...config.mappings[0]!, action: '*' }] }, { principalType: 'x::*' }, { timeoutMs: 0 }, { maxConcurrent: 257 }])
      expect(() => createCedarAuthorizationPolicy({ ...config, evaluate, ...extra })).toThrow();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
