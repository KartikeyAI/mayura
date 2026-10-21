import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorizationAuditEvent } from 'mayura';
import { createPermitAuthorizationPolicy, createPermitAuthorizer, type PermitAuthorizationPolicyOptions } from '../src/index.js';

const scope = { principalId: 'alice', projectId: 'shop' };
const request = { subject: scope, action: 'read', resource: { kind: 'thread' as const, id: 'chat', scope } };
const config = { pdpUrl: 'https://pdp.test/prefix/', apiKey: 'PRIVATE_environment_key', environmentId: 'env-1', version: 'policy-v1', namespace: 'shop-app',
  mappings: [{ kind: 'thread' as const, action: 'read', resourceType: 'thread', permitAction: 'view' },
    { kind: 'run' as const, action: 'execute', resourceType: 'thread', permitAction: 'run' }], permissions: { allow: ['authz:permit'] } };
const owners: { close(): void }[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
const context = () => ({ signal: new AbortController().signal });
const response = (body: unknown = { allow: true }, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(answer: (body: any, init: RequestInit) => Response | Promise<Response> = () => response(), extra: Partial<PermitAuthorizationPolicyOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => answer(JSON.parse(String(init!.body)), init!));
  const policy = createPermitAuthorizationPolicy({ ...config, ...extra, fetch }); owners.push(policy); return { policy, fetch };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('native scoped Permit.io PDP checks (offline)', () => {
  it('uses one native /allowed request with an explicit instance/tenant and isolated credentials', async () => {
    const { policy, fetch } = setup(); expect(fetch).not.toHaveBeenCalled();
    expect(await policy.authorize(request, context())).toEqual({ effect: 'allow', reason: 'allowed', policyVersion: policy.version, ruleId: null });
    expect(fetch).toHaveBeenCalledTimes(1); const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://pdp.test/prefix/allowed');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
    const input = JSON.parse(String(init!.body)); expect(input).toEqual(policy.input(request));
    expect(input).toEqual({ user: { key: expect.stringMatching(/^[a-f0-9]{64}$/) }, action: 'view',
      resource: { type: 'thread', key: expect.stringMatching(/^[a-f0-9]{64}$/), tenant: expect.stringMatching(/^[a-f0-9]{64}$/) }, context: {} });
    expect(String(init!.body)).not.toContain('PRIVATE'); expect(String(init!.body)).not.toContain(config.environmentId);
  });
  it('rejects missing provider grants, unmapped actions, scope mismatches, invalid input and pre-cancellation before transport', async () => {
    const missing = setup(undefined, { permissions: { allow: ['authz:evaluate'] } });
    expect(await missing.policy.authorize(request, context())).toMatchObject({ reason: 'permission_denied' }); expect(missing.fetch).not.toHaveBeenCalled();
    const { policy, fetch } = setup(); expect(await policy.authorize({ ...request, action: 'delete' }, context())).toMatchObject({ reason: 'no_match' });
    expect(await policy.authorize({ ...request, resource: { ...request.resource, scope: { ...scope, principalId: 'bob' } } }, context())).toMatchObject({ reason: 'scope_mismatch' });
    const cancelled = new AbortController(); cancelled.abort(); expect(await policy.authorize(request, { signal: cancelled.signal })).toMatchObject({ reason: 'cancelled' });
    for (const raw of [{ ...request, tenant: 'default' }, { ...request, context: { admin: true } }, { ...request, apiKey: 'other' },
      { ...request, user: 'admin' }, { ...request, subject: { ...scope, roles: ['admin'] } }, { ...request, resource: { ...request.resource, attributes: { owner: true } } }])
      expect(await policy.authorize(raw as never, context())).toMatchObject({ reason: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled(); policy.close(); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' });
  });
  it('isolates full-scope user/resource identities and project tenants with immutable provisioning output', () => {
    const { policy } = setup(); const base = policy.input(request)!;
    for (const other of [{ ...scope, principalId: 'bob' }, { ...scope, projectId: 'other' }]) {
      const next = policy.input({ ...request, subject: other, resource: { ...request.resource, scope: other } })!;
      expect(next.user.key).not.toBe(base.user.key); expect(next.resource.key).not.toBe(base.resource.key);
      if (other.projectId === scope.projectId) expect(next.resource.tenant).toBe(base.resource.tenant); else expect(next.resource.tenant).not.toBe(base.resource.tenant);
    }
    const otherKind = policy.input({ ...request, action: 'execute', resource: { ...request.resource, kind: 'run' } })!;
    expect(otherKind.resource.key).not.toBe(base.resource.key); expect(otherKind.user).toEqual(base.user);
    expect(setup(undefined, { namespace: 'other' }).policy.input(request)).not.toEqual(base);
    expect(policy.input({ ...request, resource: { ...request.resource, ownerId: 'bob' } })).toEqual(base);
    expect(policy.input({ ...request, action: 'delete' })).toBeNull(); expect(Object.isFrozen(base)).toBe(true); expect(Object.isFrozen(base.resource)).toBe(true);
    expect(() => policy.input({ ...request, resource: { ...request.resource, scope: { ...scope, projectId: 'other' } } })).toThrow();
  });
  it('fingerprints endpoint/environment/revision/mappings while excluding credentials and ordering', async () => {
    const { policy } = setup();
    expect(setup(undefined, { mappings: [...config.mappings].reverse() }).policy.version).toBe(policy.version);
    expect(setup(undefined, { apiKey: 'rotated_key' }).policy.version).toBe(policy.version);
    for (const extra of [{ pdpUrl: 'https://other.test' }, { environmentId: 'other' }, { version: 'v2' }, { namespace: 'other' },
      { mappings: [{ ...config.mappings[0]!, permitAction: 'edit' }] }]) expect(setup(undefined, extra).policy.version).not.toBe(policy.version);
    const mutable = { ...config, mappings: config.mappings.map(mapping => ({ ...mapping })) }; const saved = setup(undefined, mutable);
    mutable.apiKey = 'injected'; mutable.mappings[0]!.permitAction = 'injected'; await saved.policy.authorize(request, context());
    expect(saved.policy.input(request)?.action).toBe('view'); expect(new Headers(saved.fetch.mock.calls[0]![1]!.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
  });
  it('accepts boolean allow plus bounded native metadata, rejects ambiguous and wrong protocol responses', async () => {
    expect(await setup(() => response({ allow: false, result: false, query: {}, debug: { reason: 'PRIVATE' } })).policy.authorize(request, context())).toMatchObject({ reason: 'no_match', ruleId: null });
    expect(await setup(() => response({ allow: true, result: true, query: {}, debug: null })).policy.authorize(request, context())).toMatchObject({ effect: 'allow', ruleId: null });
    for (const body of [true, {}, { allow: 'true' }, { allow: 1 }, { result: { allow: true } }, { allow: true, result: false },
      { allow: true, error: 'PRIVATE' }, { allow: true, query: [] }, { allow: true, debug: 'PRIVATE' }, { allow: true, policyVersion: 'v1' }]) {
      const result = await setup(() => response(body)).policy.authorize(request, context()); expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });
  it('denies status, redirects, response origin, malformed media/UTF-8/JSON and oversized bodies without retries', async () => {
    for (const answer of [() => response({ allow: true }, 401), () => response({ allow: true }, 503), () => response({ allow: true }, 302),
      () => new Response('PRIVATE', { headers: { 'content-type': 'text/plain' } }),
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
      () => response({ allow: true, debug: { reason: 'x'.repeat(300) } }),
      () => new Response('{"allow":true}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
      () => { const result = response(); Object.defineProperty(result, 'url', { value: 'https://evil.test/allowed' }); return result; },
      () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; },
      () => { throw new Error('PRIVATE credential error'); }]) {
      const { policy, fetch } = setup(answer, { maxResponseBytes: 256 }); const result = await policy.authorize(request, context());
      expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });
  it('retains capacity after ignored timeout, suppresses late allows and admits only after settlement', async () => {
    vi.useFakeTimers(); const pending = deferred<Response>(); let attempts = 0;
    const { policy, fetch } = setup(() => ++attempts === 1 ? pending.promise : response(), { timeoutMs: 10, maxConcurrent: 1 });
    const first = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(11); expect(await first).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await vi.advanceTimersByTimeAsync(0); expect(await first).toMatchObject({ effect: 'deny' });
    expect(await policy.authorize(request, context())).toMatchObject({ effect: 'allow' }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates cancellation and shutdown without replaying an ignored request', async () => {
    const pending = deferred<Response>(); let signal: AbortSignal | undefined;
    const { policy, fetch } = setup((_body, init) => { signal = init.signal!; return pending.promise; }, { maxConcurrent: 1 });
    const controller = new AbortController(); const first = policy.authorize(request, { signal: controller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined()); controller.abort(); expect(await first).toMatchObject({ reason: 'cancelled' }); expect(signal?.aborted).toBe(true);
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); policy.close(); pending.resolve(response());
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains capacity until uncooperative response cancellation settles', async () => {
    vi.useFakeTimers(); const cancelled = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({ start(control) { control.enqueue(new TextEncoder().encode('{"allow":true}')); }, cancel: () => cancelled.promise });
    const { policy, fetch } = setup(() => new Response(stream, { headers: { 'content-type': 'application/json' } }), { timeoutMs: 10, maxConcurrent: 1 });
    const first = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(11); expect(await first).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(fetch).toHaveBeenCalledTimes(1);
    cancelled.resolve(); await vi.advanceTimersByTimeAsync(0); policy.close();
  });
  it('emits one core audit receipt and keeps core/provider permissions independent', async () => {
    const audit: AuthorizationAuditEvent[] = []; const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const authorizer = createPermitAuthorizer({ ...config, fetch, permissions: { allow: ['authz:permit', 'authz:evaluate', 'authz:audit'] }, audit: { sink: event => { audit.push(event); } } }); owners.push(authorizer);
    await authorizer.require(scope, 'read', request.resource); await authorizer.flushAudit(); expect(audit).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE'); authorizer.close();
    await expect(authorizer.require(scope, 'read', request.resource)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(fetch).toHaveBeenCalledTimes(1);
    const denied = createPermitAuthorizer({ ...config, fetch }); owners.push(denied);
    expect(await denied.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'permission_denied' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses unsafe configuration before transport, with fixed credential-free errors', () => {
    const bad: Partial<PermitAuthorizationPolicyOptions>[] = [{ pdpUrl: 'http://pdp.test' }, { pdpUrl: 'http://localhost', allowInsecureLoopback: true },
      { pdpUrl: 'https://u:PRIVATE@pdp.test' }, { pdpUrl: 'https://pdp.test?token=PRIVATE' }, { pdpUrl: 'https://pdp.test#PRIVATE' },
      { apiKey: '' }, { apiKey: 'PRIVATE\nheader' }, { environmentId: '' }, { namespace: '*' }, { version: '' },
      { mappings: [] }, { mappings: [config.mappings[0]!, config.mappings[0]!] }, { mappings: [{ ...config.mappings[0]!, permitAction: '*' }] },
      { mappings: [{ ...config.mappings[0]!, resourceType: 'thread:admin' }] }, { maxConcurrent: 257 }, { timeoutMs: 0 }, { maxResponseBytes: 255 }];
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const extra of bad) { let failure: unknown; try { createPermitAuthorizationPolicy({ ...config, ...extra, fetch }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(failure)).not.toContain('PRIVATE'); }
    expect(fetch).not.toHaveBeenCalled(); const local = createPermitAuthorizationPolicy({ ...config, pdpUrl: 'http://127.0.0.1:7766', allowInsecureLoopback: true }); local.close();
  });
});
