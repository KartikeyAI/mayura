import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, type AuthorizationAuditEvent, type AuthorizationDecision } from 'mayura';
import { createHttpAuthorizer, createHttpAuthorizationPolicy, HTTP_AUTHORIZATION_PROTOCOL, type HttpAuthorizationPolicyOptions } from '../src/index.js';
const endpoint = 'https://policy.test/check'; const scope = { principalId: 'alice', projectId: 'shop' };
const request = { subject: scope, action: 'read', resource: { kind: 'thread' as const, id: 'chat', scope } };
const allow: AuthorizationDecision = { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: 'reader' };
const owners: { close(): void }[] = []; afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
const context = () => ({ signal: new AbortController().signal });
function response(requestId: string, decision: unknown = allow, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ protocol: HTTP_AUTHORIZATION_PROTOCOL, requestId, decision, ...extra }), { headers: { 'content-type': 'application/json' } });
}
function setup(answer: (frame: Record<string, any>, init: RequestInit) => Response | Promise<Response> = body => response(body.requestId), extra: Partial<HttpAuthorizationPolicyOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => answer(JSON.parse(String(init!.body)), init!));
  const policy = createHttpAuthorizationPolicy({ endpoint, version: 'v1', permissions: { allow: ['authz:http'] }, fetch, ...extra }); owners.push(policy); return { policy, fetch };
}

describe('external HTTP authorization', () => {
  it('does no I/O on construction and sends only correlated scoped metadata through an isolated POST', async () => {
    const headers = { Authorization: 'Bearer service-secret' }; const grants = { allow: ['authz:http'] };
    const { policy, fetch } = setup(undefined, { headers, permissions: grants }); expect(fetch).not.toHaveBeenCalled();
    headers.Authorization = 'changed'; grants.allow.length = 0;
    expect(await policy.authorize(request, context())).toEqual(allow); expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!; expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer service-secret');
    expect(JSON.parse(String(init!.body))).toMatchObject({ protocol: HTTP_AUTHORIZATION_PROTOCOL, policyVersion: 'v1', request });
    expect(String(init!.body)).not.toContain('service-secret'); expect(Object.isFrozen(await policy.authorize(request, context()))).toBe(true);
  });
  it('blocks absent transport grants, cross-scope, invalid input, cancellation and closure without I/O', async () => {
    const missing = setup(undefined, { permissions: { allow: [] } }); expect(await missing.policy.authorize(request, context())).toMatchObject({ reason: 'permission_denied' }); expect(missing.fetch).not.toHaveBeenCalled();
    const { policy, fetch } = setup(); const aborted = new AbortController(); aborted.abort();
    expect(await policy.authorize(request, { signal: aborted.signal })).toMatchObject({ reason: 'cancelled' });
    expect(await policy.authorize({ ...request, resource: { ...request.resource, scope: { ...scope, principalId: 'bob' } } }, context())).toMatchObject({ reason: 'scope_mismatch' });
    for (const raw of [{ ...request, roles: ['admin'] }, { ...request, action: '*' }, { ...request, subject: { ...scope, token: 'SECRET' } }])
      expect(await policy.authorize(raw as never, context())).toMatchObject({ reason: 'invalid_request' });
    policy.close(); expect(await policy.authorize(request, context())).toMatchObject({ reason: 'cancelled' }); expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts explicit remote deny receipts and refuses stale, unrelated, boolean or malformed decisions', async () => {
    const denied = setup(body => response(body.requestId, { ...allow, effect: 'deny', reason: 'explicit_deny' }));
    expect(await denied.policy.authorize(request, context())).toMatchObject({ reason: 'explicit_deny', ruleId: 'reader' });
    for (const answer of [
      (body: Record<string, any>) => response(body.requestId, { ...allow, policyVersion: 'old' }),
      () => response('another-request'), (body: Record<string, any>) => response(body.requestId, true),
      (body: Record<string, any>) => response(body.requestId, { ...allow, role: 'admin' }),
      (body: Record<string, any>) => response(body.requestId, { ...allow, effect: 'deny', reason: ['unavailable'] }),
      (body: Record<string, any>) => response(body.requestId, allow, { protocol: 'other' }),
      (body: Record<string, any>) => response(body.requestId, allow, { debug: 'SECRET provider diagnostics' }),
    ]) {
      const { policy } = setup(answer); const result = await policy.authorize(request, context());
      expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable', ruleId: null }); expect(JSON.stringify(result)).not.toContain('SECRET');
    }
  });
  it('bounds statuses, redirect responses, body bytes, decoding and media types without retries', async () => {
    for (const answer of [
      () => new Response('SECRET', { status: 503 }), () => new Response('', { status: 302, headers: { location: 'https://other.test' } }),
      () => new Response('SECRET', { headers: { 'content-type': 'text/plain' } }),
      () => new Response('x'.repeat(300), { headers: { 'content-type': 'application/json' } }),
      () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '9999999' } }),
      () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
      () => { throw new Error('SECRET transport token'); },
    ]) {
      const { policy, fetch } = setup(answer, { maxResponseBytes: 256 }); const result = await policy.authorize(request, context());
      expect(result).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(JSON.stringify(result)).not.toContain('SECRET'); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('requires secure explicit endpoints and snapshots supported headers without exposing configuration', () => {
    for (const extra of [
      { endpoint: 'http://policy.test' }, { endpoint: 'http://localhost/check', allowInsecureLoopback: true },
      { endpoint: 'https://user:SECRET@policy.test/check' }, { endpoint: endpoint + '?token=SECRET' }, { endpoint: endpoint + '#SECRET' },
      { headers: { Cookie: 'SECRET' } }, { headers: { 'content-length': '0' } }, { headers: { Authorization: 'SECRET\nvalue' } },
      { maxConcurrent: 257 }, { timeoutMs: 0 }, { maxResponseBytes: 16_385 },
    ]) {
      let error: unknown; try { setup(undefined, extra); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(error)).not.toContain('SECRET');
    }
    const { fetch } = setup(undefined, { endpoint: 'http://127.0.0.1:8787/check', allowInsecureLoopback: true }); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects oversized metadata before transport', async () => {
    const long = 'a'.repeat(128); const big = { subject: { principalId: long, projectId: long }, action: long,
      resource: { kind: 'thread' as const, id: long, ownerId: long, scope: { principalId: long, projectId: long } } };
    const { policy, fetch } = setup(undefined, { maxRequestBytes: 1024 });
    expect(await policy.authorize(big, context())).toMatchObject({ reason: 'limit_exceeded' }); expect(fetch).not.toHaveBeenCalled();
  });
  it('retains capacity for an ignored timeout, ignores late allows, and cancels the late body', async () => {
    vi.useFakeTimers(); let release!: (value: Response) => void; let signal: AbortSignal | undefined;
    const late = new Promise<Response>(resolve => { release = resolve; });
    const { policy, fetch } = setup((_body, init) => { signal = init.signal!; return late; }, { timeoutMs: 10, maxConcurrent: 1 });
    const work = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(10);
    expect(await work).toMatchObject({ reason: 'unavailable' }); expect(signal?.aborted).toBe(true);
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' });
    const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }));
    await vi.advanceTimersByTimeAsync(0); expect(cancel).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps transport capacity while underlying stream cancellation is still pending', async () => {
    vi.useFakeTimers(); let finishCancel!: () => void;
    const cancelled = new Promise<void>(resolve => { finishCancel = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel: () => cancelled });
    const { policy } = setup(() => new Response(body, { headers: { 'content-type': 'application/json' } }), { timeoutMs: 10, maxConcurrent: 1 });
    const work = policy.authorize(request, context()); await vi.advanceTimersByTimeAsync(10);
    expect(await work).toMatchObject({ reason: 'unavailable' });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'limit_exceeded' });
    finishCancel(); await vi.advanceTimersByTimeAsync(0);
  });
  it('denies a valid response whose transport returns after the wall-clock deadline', async () => {
    vi.useFakeTimers();
    const { policy } = setup(body => { vi.setSystemTime(Date.now() + 20); return response(body.requestId); }, { timeoutMs: 10 });
    expect(await policy.authorize(request, context())).toMatchObject({ reason: 'unavailable' });
  });
  it('propagates caller and owner cancellation without admitting a late response', async () => {
    for (const close of [false, true]) {
      let release!: (value: Response) => void; let started!: () => void; let signal: AbortSignal | undefined;
      const ready = new Promise<void>(resolve => { started = resolve; }); const late = new Promise<Response>(resolve => { release = resolve; });
      const { policy } = setup((_body, init) => { signal = init.signal!; started(); return late; }); const abort = new AbortController();
      const work = policy.authorize(request, { signal: abort.signal }); await ready; if (close) policy.close(); else abort.abort();
      expect(await work).toMatchObject({ reason: 'cancelled' }); expect(signal?.aborted).toBe(true); release(new Response());
    }
  });
  it('composes with core and emits exactly one audit receipt without credentials or remote diagnostics', async () => {
    const events: AuthorizationAuditEvent[] = [];
    const { policy, fetch } = setup(() => { throw new Error('SECRET remote error'); });
    const authorizer = createAuthorizer({ policy, permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(authorizer);
    expect(await authorizer.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'unavailable' }); await authorizer.flushAudit();
    expect(events).toHaveLength(1); expect(events[0]?.request).toEqual(request); expect(JSON.stringify(events)).not.toContain('SECRET'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('forwards core audit settings and owns HTTP cancellation in the convenience authorizer', async () => {
    const events: AuthorizationAuditEvent[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => response(JSON.parse(String(init!.body)).requestId));
    const authorizer = createHttpAuthorizer({ endpoint, version: 'v1', fetch, permissions: { allow: ['authz:http', 'authz:evaluate', 'authz:audit'] },
      audit: { sink: event => { events.push(event); } } }); owners.push(authorizer);
    await authorizer.require(scope, 'read', request.resource); await authorizer.flushAudit(); expect(events).toHaveLength(1);
    authorizer.close(); expect(await authorizer.authorize(scope, 'read', request.resource)).toMatchObject({ reason: 'cancelled' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
