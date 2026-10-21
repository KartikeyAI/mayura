import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorizationAuditEvent } from 'mayura';
import { createOsoAuthorizationPolicy, createOsoAuthorizer, type OsoAuthorizationPolicyOptions } from '../src/index.js';

const scope = { principalId: 'alice', projectId: 'shop' };
const request = { subject: scope, action: 'read', resource: { kind: 'thread' as const, id: 'chat', scope } };
const config = { apiUrl: 'https://oso.test/prefix/', apiKey: 'PRIVATE_environment_key', environmentId: 'env-1', version: 'policy-v1', namespace: 'shop-app', actorType: 'User',
  mappings: [{ kind: 'thread' as const, action: 'read', resourceType: 'Thread', osoAction: 'view' },
    { kind: 'run' as const, action: 'execute', resourceType: 'Thread', osoAction: 'run' }], permissions: { allow: ['authz:oso'] } };
const owners: { close(): void }[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
const context = () => ({ signal: new AbortController().signal });
const response = (body: unknown = { allowed: true }, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(answer: (body: any, init: RequestInit) => Response | Promise<Response> = () => response(), extra: Partial<OsoAuthorizationPolicyOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => answer(JSON.parse(String(init!.body)), init!));
  const policy = createOsoAuthorizationPolicy({ ...config, ...extra, fetch }); owners.push(policy); return { policy, fetch };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('native scoped Oso Cloud checks (offline)', () => {
  it('sends exactly one native /api/authorize request with scoped typed IDs and isolated credentials', async () => {
    const { policy, fetch } = setup(); expect(fetch).not.toHaveBeenCalled();
    expect(await policy.authorize(request, context())).toEqual({ effect: 'allow', reason: 'allowed', policyVersion: policy.version, ruleId: null });
    expect(fetch).toHaveBeenCalledTimes(1); const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://oso.test/prefix/api/authorize');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
    expect(JSON.parse(String(init!.body))).toEqual({ actor_type: 'User', actor_id: expect.stringMatching(/^[a-f0-9]{64}$/), action: 'view',
      resource_type: 'Thread', resource_id: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.parse(String(init!.body))).toEqual(policy.input(request)); expect(String(init!.body)).not.toContain('PRIVATE');
    expect(String(init!.body)).not.toContain(config.environmentId);
  });
  it('rejects provider permission, bad scope, unmapped actions, cancellation and request overrides before I/O', async () => {
    const missing = setup(undefined, { permissions: { allow: ['authz:evaluate'] } });
    expect(await missing.policy.authorize(request, context())).toMatchObject({ reason: 'permission_denied' }); expect(missing.fetch).not.toHaveBeenCalled();
    const { policy, fetch } = setup(); expect(await policy.authorize({ ...request, action: 'delete' }, context())).toMatchObject({ reason: 'no_match' });
    const wrong = { ...request, resource: { ...request.resource, scope: { ...scope, principalId: 'bob' } } };
    expect(await policy.authorize(wrong, context())).toMatchObject({ reason: 'scope_mismatch' }); expect(() => policy.input(wrong)).toThrow();
    const cancelled = new AbortController(); cancelled.abort(); expect(await policy.authorize(request, { signal: cancelled.signal })).toMatchObject({ reason: 'cancelled' });
    for (const raw of [{ ...request, context_facts: [['has_role', 'admin']] }, { ...request, query: 'allow' }, { ...request, apiKey: 'other' },
      { ...request, actor_id: 'admin' }, { ...request, subject: { ...scope, roles: ['admin'] } }, { ...request, resource: { ...request.resource, policy: 'allow' } }])
      expect(await policy.authorize(raw as never, context())).toMatchObject({ reason: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled(); policy.close(); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' });
  });
  it('isolates namespaces, principals, projects and resource kinds without implicit ownership grants', () => {
    const { policy } = setup(); const base = policy.input(request)!;
    for (const other of [{ ...scope, principalId: 'bob' }, { ...scope, projectId: 'other' }]) {
      const next = policy.input({ ...request, subject: other, resource: { ...request.resource, scope: other } })!;
      expect(next.actor_id).not.toBe(base.actor_id); expect(next.resource_id).not.toBe(base.resource_id);
    }
    const otherKind = policy.input({ ...request, action: 'execute', resource: { ...request.resource, kind: 'run' } })!;
    expect(otherKind.resource_id).not.toBe(base.resource_id); expect(otherKind.actor_id).toBe(base.actor_id);
    expect(setup(undefined, { namespace: 'other' }).policy.input(request)).not.toEqual(base);
    expect(policy.input({ ...request, resource: { ...request.resource, ownerId: 'bob' } })).toEqual(base);
    expect(policy.input({ ...request, action: 'delete' })).toBeNull(); expect(Object.isFrozen(base)).toBe(true);
    // Actor and resource must remain distinct even when both use the same native type and local ID.
    const sameType = setup(undefined, { actorType: 'Thread' }).policy.input(request)!; expect(sameType.actor_id).not.toBe(sameType.resource_id);
  });
  it('fingerprints deployment/mappings independent of order and key rotation, and snapshots mutable settings', async () => {
    const { policy } = setup(); expect(setup(undefined, { mappings: [...config.mappings].reverse() }).policy.version).toBe(policy.version);
    expect(setup(undefined, { apiKey: 'rotated_key' }).policy.version).toBe(policy.version);
    for (const extra of [{ apiUrl: 'https://other.test' }, { environmentId: 'other' }, { version: 'v2' }, { namespace: 'other' }, { actorType: 'Principal' },
      { mappings: [{ ...config.mappings[0]!, osoAction: 'edit' }] }]) expect(setup(undefined, extra).policy.version).not.toBe(policy.version);
    const mutable = { ...config, mappings: config.mappings.map(mapping => ({ ...mapping })) }; const saved = setup(undefined, mutable);
    mutable.apiKey = 'injected'; mutable.mappings[0]!.osoAction = 'injected'; await saved.policy.authorize(request, context());
    expect(saved.policy.input(request)?.action).toBe('view'); expect(new Headers(saved.fetch.mock.calls[0]![1]!.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
  });
  it('accepts only native booleans without inventing policy/rule receipts', async () => {
    expect(await setup(() => response({ allowed: false })).policy.authorize(request, context())).toMatchObject({ reason: 'no_match', ruleId: null });
    for (const body of [true, {}, { allowed: 'true' }, { allowed: 1 }, { allow: true }, { result: { allowed: true } },
      { allowed: true, error: 'PRIVATE' }, { allowed: true, policyVersion: 'v1' }, { allowed: [true] }]) {
      const result = await setup(() => response(body)).policy.authorize(request, context()); expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
    const duplicate = setup(() => new Response('{"allowed":false,"allowed":true}', { headers: { 'content-type': 'application/json' } }));
    expect(await duplicate.policy.authorize(request, context())).toMatchObject({ reason: 'unavailable' });
  });
  it('denies response status, redirects, wrong origins, invalid JSON/media/UTF-8 and oversized bodies with no retries', async () => {
    for (const answer of [() => response({ allowed: true }, 401), () => response({ allowed: true }, 503), () => response({ allowed: true }, 302),
      () => new Response('PRIVATE', { headers: { 'content-type': 'text/plain' } }), () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
      () => new Response(' '.repeat(300) + '{"allowed":true}', { headers: { 'content-type': 'application/json' } }),
      () => new Response('{"allowed":true}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
      () => { const result = response(); Object.defineProperty(result, 'url', { value: 'https://evil.test/api/authorize' }); return result; },
      () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; },
      () => { throw new Error('PRIVATE credential error'); }]) {
      const { policy, fetch } = setup(answer, { maxResponseBytes: 256 }); const result = await policy.authorize(request, context());
      expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(fetch).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
  });
  it('retains capacity through an ignored fetch timeout and suppresses late allows', async () => {
    vi.useFakeTimers(); const pending = deferred<Response>(); let attempts = 0;
    const { policy, fetch } = setup(() => ++attempts === 1 ? pending.promise : response(), { timeoutMs: 10, maxConcurrent: 1 });
    const first = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(11); expect(await first).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await vi.advanceTimersByTimeAsync(0); expect(await first).toMatchObject({ effect: 'deny' });
    expect(await policy.authorize(request, context())).toMatchObject({ effect: 'allow' }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('propagates cancellation and close without replaying an ignored request', async () => {
    const pending = deferred<Response>(); let signal: AbortSignal | undefined;
    const { policy, fetch } = setup((_body, init) => { signal = init.signal!; return pending.promise; }, { maxConcurrent: 1 });
    const controller = new AbortController(); const first = policy.authorize(request, { signal: controller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined()); controller.abort(); expect(await first).toMatchObject({ reason: 'cancelled' }); expect(signal?.aborted).toBe(true);
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); policy.close(); pending.resolve(response());
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains capacity until uncooperative stream cancellation actually settles', async () => {
    vi.useFakeTimers(); const cancelled = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({ start(control) { control.enqueue(new TextEncoder().encode('{"allowed":true}')); }, cancel: () => cancelled.promise });
    const { policy, fetch } = setup(() => new Response(stream, { headers: { 'content-type': 'application/json' } }), { timeoutMs: 10, maxConcurrent: 1 });
    const first = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(11); expect(await first).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(fetch).toHaveBeenCalledTimes(1);
    cancelled.resolve(); await vi.advanceTimersByTimeAsync(0); policy.close();
  });
  it('produces one final core audit receipt for both allowed and denied checks', async () => {
    const audit: AuthorizationAuditEvent[] = []; let allowed = true; const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ allowed }));
    const authorizer = createOsoAuthorizer({ ...config, fetch, permissions: { allow: ['authz:oso', 'authz:evaluate', 'authz:audit'] }, audit: { sink: event => { audit.push(event); } } }); owners.push(authorizer);
    await authorizer.require(scope, 'read', request.resource); allowed = false; expect(await authorizer.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'no_match' });
    await authorizer.flushAudit(); expect(audit).toHaveLength(2); expect(fetch).toHaveBeenCalledTimes(2); expect(JSON.stringify(audit)).not.toContain('PRIVATE');
    authorizer.close(); await expect(authorizer.require(scope, 'read', request.resource)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(fetch).toHaveBeenCalledTimes(2);
    const denied = createOsoAuthorizer({ ...config, fetch }); owners.push(denied);
    expect(await denied.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'permission_denied' }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects unsafe config without leaking credentials or issuing requests', () => {
    const bad: Partial<OsoAuthorizationPolicyOptions>[] = [{ apiUrl: 'http://oso.test' }, { apiUrl: 'http://localhost', allowInsecureLoopback: true },
      { apiUrl: 'https://u:PRIVATE@oso.test' }, { apiUrl: 'https://oso.test?token=PRIVATE' }, { apiUrl: 'https://oso.test#PRIVATE' },
      { apiKey: '' }, { apiKey: 'PRIVATE\nheader' }, { environmentId: '' }, { namespace: '*' }, { actorType: 'User(*)' }, { version: '' },
      { mappings: [] }, { mappings: [config.mappings[0]!, config.mappings[0]!] }, { mappings: [{ ...config.mappings[0]!, osoAction: '*' }] },
      { mappings: [{ ...config.mappings[0]!, resourceType: 'Thread:admin' }] }, { maxConcurrent: 257 }, { timeoutMs: 0 }, { maxResponseBytes: 255 }];
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const extra of bad) { let failure: unknown; try { createOsoAuthorizationPolicy({ ...config, ...extra, fetch }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(failure)).not.toContain('PRIVATE'); }
    expect(fetch).not.toHaveBeenCalled(); const local = createOsoAuthorizationPolicy({ ...config, apiUrl: 'http://127.0.0.1:8080', allowInsecureLoopback: true }); local.close();
  });
});
