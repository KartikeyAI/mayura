import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, type AuthorizationAuditEvent } from 'mayura';
import { createOpenFgaAuthorizationPolicy, createOpenFgaAuthorizer, type OpenFgaAuthorizationPolicyOptions } from '../src/index.js';

const scope = { principalId: 'alice', projectId: 'shop' };
const request = { subject: scope, action: 'read', resource: { kind: 'thread' as const, id: 'chat', scope } };
const storeId = '01YCP46JKYM8FJCQ37NMBYHE5X'; const modelId = '01G5JAVJ41T49E9TT3SKVS7X1J';
const options = { apiUrl: 'https://fga.test/policy/', storeId, authorizationModelId: modelId, version: 'shop-v1', namespace: 'shop-app', userType: 'principal',
  permissions: { allow: ['authz:openfga'] }, relations: [
    { kind: 'thread' as const, action: 'read', objectType: 'scoped_resource', relation: 'can_read' },
    { kind: 'run' as const, action: 'execute', objectType: 'scoped_resource', relation: 'can_execute' },
  ] };
const owners: { close(): void }[] = []; afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
const context = () => ({ signal: new AbortController().signal });
const response = (body: unknown = { allowed: true }, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(answer: (body: any, init: RequestInit) => Response | Promise<Response> = () => response(), extra: Partial<OpenFgaAuthorizationPolicyOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => answer(JSON.parse(String(init!.body)), init!));
  const policy = createOpenFgaAuthorizationPolicy({ ...options, ...extra, fetch }); owners.push(policy); return { policy, fetch };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('native OpenFGA authorization policy (offline)', () => {
  it('pins the native store/model, sends exact host mappings and higher consistency without discovery or credentials in the body', async () => {
    const headers = { Authorization: 'Bearer PRIVATE-service-token' }; const { policy, fetch } = setup(undefined, { headers }); headers.Authorization = 'changed';
    expect(fetch).not.toHaveBeenCalled(); expect(await policy.authorize(request, context())).toEqual({ effect: 'allow', reason: 'allowed', policyVersion: policy.version, ruleId: null });
    expect(fetch).toHaveBeenCalledTimes(1); const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://fga.test/policy/stores/${storeId}/check`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer PRIVATE-service-token');
    expect(JSON.parse(String(init!.body))).toEqual({ tuple_key: policy.tuple(request), authorization_model_id: modelId, consistency: 'HIGHER_CONSISTENCY' });
    expect(String(init!.body)).not.toContain('PRIVATE'); expect(Object.isFrozen(policy.tuple(request))).toBe(true);
  });
  it('denies missing grants, unmapped actions, bad scope, cancellation and closed policies before I/O', async () => {
    const missing = setup(undefined, { permissions: { allow: [] } }); expect(await missing.policy.authorize(request, context())).toMatchObject({ reason: 'permission_denied' }); expect(missing.fetch).not.toHaveBeenCalled();
    const { policy, fetch } = setup();
    expect(await policy.authorize({ ...request, action: 'delete' }, context())).toMatchObject({ reason: 'no_match' }); expect(policy.tuple({ ...request, action: 'delete' })).toBeNull();
    const wrongScope = { ...request, resource: { ...request.resource, scope: { ...scope, principalId: 'bob' } } };
    expect(await policy.authorize(wrongScope, context())).toMatchObject({ reason: 'scope_mismatch' }); expect(() => policy.tuple(wrongScope)).toThrow();
    const cancelled = new AbortController(); cancelled.abort(); expect(await policy.authorize(request, { signal: cancelled.signal })).toMatchObject({ reason: 'cancelled' });
    policy.close(); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' }); expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps native principal/resource identities distinct across namespace, project, principal and kind without userset injection', () => {
    const { policy } = setup(); const base = policy.tuple(request)!;
    expect(base.user).toMatch(/^principal:[a-f0-9]{64}$/); expect(base.object).toMatch(/^scoped_resource:[a-f0-9]{64}$/);
    for (const nextScope of [{ ...scope, projectId: 'other' }, { ...scope, principalId: 'bob' }]) {
      const next = policy.tuple({ ...request, subject: nextScope, resource: { ...request.resource, scope: nextScope } })!;
      expect(next.user).not.toBe(base.user); expect(next.object).not.toBe(base.object);
    }
    const nextKind = policy.tuple({ ...request, action: 'execute', resource: { ...request.resource, kind: 'run' } })!;
    expect(nextKind.user).toBe(base.user); expect(nextKind.object).not.toBe(base.object);
    expect(setup(undefined, { namespace: 'other-app' }).policy.tuple(request)).not.toEqual(base);
    expect(policy.tuple({ ...request, resource: { ...request.resource, ownerId: 'bob' } })).toEqual(base);
    for (const principalId of ['*', 'principal:*', 'group:admin#member']) {
      const injected = { ...scope, principalId }; expect(() => policy.tuple({ ...request, subject: injected, resource: { ...request.resource, scope: injected } })).toThrow();
    }
  });
  it('does not serialize request-supplied context, tuples, roles, transport settings or model selection', async () => {
    const { policy, fetch } = setup();
    for (const raw of [
      { ...request, contextual_tuples: { tuple_keys: [] } }, { ...request, context: { is_admin: true } }, { ...request, authorization_model_id: modelId },
      { ...request, subject: { ...scope, roles: ['admin'] } }, { ...request, action: '*' }, { ...request, endpoint: 'https://evil.test' },
    ]) expect(await policy.authorize(raw as never, context())).toMatchObject({ reason: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fingerprints model/mapping configuration, ignores mapping order, and snapshots configuration before evaluation', () => {
    const { policy } = setup(); const reversed = setup(undefined, { relations: [...options.relations].reverse() }).policy;
    expect(reversed.version).toBe(policy.version);
    for (const extra of [{ authorizationModelId: '01H0H015178Y2V4CX10C2KGHF4' }, { namespace: 'other' }, { version: 'v2' },
      { storeId: '01H0H015178Y2V4CX10C2KGHF4' }, { relations: [{ ...options.relations[0]!, relation: 'other' }] }]) expect(setup(undefined, extra).policy.version).not.toBe(policy.version);
    const relations = options.relations.map(item => ({ ...item })); const current = setup(undefined, { relations }).policy;
    relations[0]!.relation = 'injected'; expect(current.tuple(request)?.relation).toBe('can_read');
  });
  it('accepts only boolean native decisions and discards trace data without inventing provider rule receipts', async () => {
    expect(await setup(() => response({ allowed: false, resolution: 'PRIVATE trace' })).policy.authorize(request, context())).toMatchObject({ effect: 'deny', reason: 'no_match', ruleId: null });
    expect(await setup(() => response({ allowed: true, resolution: '' })).policy.authorize(request, context())).toMatchObject({ effect: 'allow', ruleId: null });
    for (const body of [{}, true, { allowed: 'true' }, { allowed: 1 }, { allowed: true, error: 'PRIVATE provider error' }, { allowed: true, resolution: {} }, { allowed: true, policyVersion: 'latest' }]) {
      const result = await setup(() => response(body)).policy.authorize(request, context()); expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });
  it('bounds status, redirect, response origin, JSON/media decoding and body bytes without retries', async () => {
    for (const answer of [
      () => response({ allowed: true }, 503), () => response({ allowed: true }, 302), () => new Response('PRIVATE', { headers: { 'content-type': 'text/plain' } }),
      () => response({ allowed: true, resolution: 'x'.repeat(300) }), () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
      () => new Response('{"allowed":true}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
      () => { const value = response(); Object.defineProperty(value, 'url', { value: 'https://evil.test/check' }); return value; },
      () => { throw new Error('PRIVATE credential exception'); },
    ]) {
      const { policy, fetch } = setup(answer, { maxResponseBytes: 256 }); const result = await policy.authorize(request, context());
      expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('holds capacity after a timed-out uncooperative transport and never replaces the returned denial with a late allow', async () => {
    vi.useFakeTimers(); const pending = deferred<Response>(); let attempts = 0; const { policy, fetch } = setup(() => ++attempts === 1 ? pending.promise : response(), { timeoutMs: 10, maxConcurrent: 1 });
    const first = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(11); expect(await first).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await vi.advanceTimersByTimeAsync(0);
    expect(await policy.authorize(request, context())).toMatchObject({ effect: 'allow' }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates cancellation and shutdown while retaining ignored work until actual settlement', async () => {
    const pending = deferred<Response>(); let signal: AbortSignal | undefined;
    const { policy } = setup((_body, init) => { signal = init.signal!; return pending.promise; }, { maxConcurrent: 1 }); const abort = new AbortController();
    const first = policy.authorize(request, { signal: abort.signal }); await vi.waitFor(() => expect(signal).toBeDefined()); abort.abort();
    expect(await first).toMatchObject({ reason: 'cancelled' }); expect(signal?.aborted).toBe(true);
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); policy.close();
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' }); pending.resolve(response());
  });
  it('refuses unsafe endpoints, invalid or ambiguous mappings, credentials in URLs and invalid transport bounds', () => {
    const bad: Partial<OpenFgaAuthorizationPolicyOptions>[] = [
      { apiUrl: 'http://fga.test' }, { apiUrl: 'http://localhost', allowInsecureLoopback: true }, { apiUrl: 'https://u:PRIVATE@fga.test' }, { apiUrl: 'https://fga.test?token=PRIVATE' },
      { authorizationModelId: '' }, { storeId: '../other' }, { version: undefined } as unknown as Partial<OpenFgaAuthorizationPolicyOptions>, { namespace: undefined } as unknown as Partial<OpenFgaAuthorizationPolicyOptions>, { userType: 'principal:*' }, { relations: [] },
      { relations: [options.relations[0]!, options.relations[0]!] }, { relations: [{ ...options.relations[0]!, action: '*' }] },
      { relations: [{ ...options.relations[0]!, relation: 'viewer#admin' }] }, { headers: { Cookie: 'PRIVATE' } }, { headers: { 'x-openfga-authorization-model-id': modelId } },
      { headers: { Authorization: 'PRIVATE\ninvalid' } }, { timeoutMs: 0 }, { maxConcurrent: 257 }, { maxResponseBytes: 16_385 },
    ];
    for (const extra of bad) { const failure = (() => { try { createOpenFgaAuthorizationPolicy({ ...options, ...extra }); } catch (error) { return error; } })();
      expect(failure).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(failure)).not.toContain('PRIVATE'); }
    const dev = createOpenFgaAuthorizationPolicy({ ...options, apiUrl: 'http://127.0.0.1:8080', allowInsecureLoopback: true }); dev.close();
  });
  it('shares the core enforcement/audit path once per check and owns shutdown of its remote policy', async () => {
    const audit: AuthorizationAuditEvent[] = []; const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const authorizer = createOpenFgaAuthorizer({ ...options, fetch, permissions: { allow: ['authz:openfga', 'authz:evaluate', 'authz:audit'] }, audit: { sink: event => { audit.push(event); } } }); owners.push(authorizer);
    await authorizer.require(scope, 'read', request.resource); await authorizer.flushAudit(); expect(audit).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
    const denied = await authorizer.authorize(scope, 'delete', request.resource); expect(denied).toMatchObject({ effect: 'deny', reason: 'no_match' }); await authorizer.flushAudit(); expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('Bearer'); authorizer.close(); await expect(authorizer.require(scope, 'read', request.resource)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const policy = setup().policy; const core = createAuthorizer({ policy, permissions: { allow: [] } }); owners.push(core);
    expect(await core.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'permission_denied' });
  });
});
