import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizationRequest, createAuthorizer, type AuthorizationDecision, type AuthorizationPolicy, type Authorizer } from '../src/index.js';
const subject = { principalId: 'alice', projectId: 'shop' };
const resource = { kind: 'thread' as const, id: 'chat/one', scope: subject, ownerId: 'alice' };
const allow: AuthorizationDecision = Object.freeze({ effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: 'reader' });
const owners: Authorizer[] = []; afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
function setup(authorize: AuthorizationPolicy['authorize'] = () => allow, options: { permissions?: readonly string[]; timeoutMs?: number; maxConcurrent?: number } = {}) {
  const evaluate = vi.fn(authorize); const owner = createAuthorizer({ policy: { version: 'v1', authorize: evaluate }, permissions: { allow: options.permissions ?? ['authz:evaluate'] },
    limits: { timeoutMs: options.timeoutMs ?? 1000, maxConcurrent: options.maxConcurrent ?? 32 } }); owners.push(owner); return { owner, evaluate };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }

describe('core authorization boundary', () => {
  it('copies and freezes subject/resource data before evaluation and returns immutable decisions', async () => {
    const requested = { ...resource, scope: { ...subject } }; const principal = { ...subject };
    const { owner, evaluate } = setup((request, context) => {
      expect(request.subject.principalId).toBe('alice'); expect(request.resource.id).toBe('chat/one');
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.resource.scope)).toBe(true); expect(context.signal).toBeInstanceOf(AbortSignal); return allow;
    });
    const work = owner.authorize(principal, 'read', requested); principal.principalId = 'bob'; requested.id = 'other';
    expect(await work).toEqual(allow); expect(evaluate).toHaveBeenCalledTimes(1); expect(Object.isFrozen(await owner.authorize(subject, 'read', resource))).toBe(true);
  });
  it('denies by default, refuses mismatched scopes and validates input before calling policy', async () => {
    const missing = setup(undefined, { permissions: [] }); expect(await missing.owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'permission_denied' }); expect(missing.evaluate).not.toHaveBeenCalled();
    const { owner, evaluate } = setup();
    for (const scope of [{ ...subject, principalId: 'bob' }, { ...subject, projectId: 'other' }]) expect(await owner.authorize(subject, 'read', { ...resource, scope })).toMatchObject({ effect: 'deny', reason: 'scope_mismatch' });
    for (const bad of [{ ...resource, id: '*' }, { ...resource, roles: ['admin'] }, { ...resource, kind: 'unknown' }]) expect(await owner.authorize(subject, 'read', bad as never)).toMatchObject({ effect: 'deny', reason: 'invalid_request' });
    expect(await owner.authorize(subject, '*', resource)).toMatchObject({ effect: 'deny', reason: 'invalid_request' }); expect(evaluate).not.toHaveBeenCalled();
  });
  it('rejects executable request fields and provider decisions without invoking their getters', async () => {
    const getter = vi.fn(() => 'chat'); const forged = { ...resource }; Object.defineProperty(forged, 'id', { enumerable: true, get: getter });
    const { owner, evaluate } = setup(); expect(await owner.authorize(subject, 'read', forged)).toMatchObject({ effect: 'deny', reason: 'invalid_request' }); expect(evaluate).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    const decision = { ...allow }; Object.defineProperty(decision, 'effect', { enumerable: true, get: getter });
    const other = setup(() => decision); expect(await other.owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'unavailable' }); expect(getter).not.toHaveBeenCalled();
  });
  it('fails closed on throws, malformed decisions, stale versions and arbitrary provider diagnostics', async () => {
    for (const value of [true, { ...allow, policyVersion: 'v0' }, { ...allow, reason: 'no_match' }, { ...allow, raw: 'provider secret' }]) {
      const { owner } = setup(() => value as never); expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'unavailable' });
    }
    const { owner } = setup(() => { throw new Error('private credential details'); });
    expect(JSON.stringify(await owner.authorize(subject, 'read', resource))).not.toContain('credential');
    await expect(owner.require(subject, 'read', resource)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'The operation is not authorized.' });
  });
  it('times out without accepting late allows and retains bounded capacity until callbacks settle', async () => {
    vi.useFakeTimers(); const delayed = deferred<AuthorizationDecision>(); const { owner, evaluate } = setup(() => delayed.promise, { timeoutMs: 10, maxConcurrent: 1 });
    const work = owner.authorize(subject, 'read', resource); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10); expect(await work).toMatchObject({ effect: 'deny', reason: 'unavailable' });
    expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'limit_exceeded' }); expect(evaluate).toHaveBeenCalledTimes(1);
    delayed.resolve(allow); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    evaluate.mockReturnValue(allow); expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'allow' });
  });
  it('denies a synchronous reply that arrives beyond its wall-clock deadline', async () => {
    vi.useFakeTimers(); const { owner } = setup(() => { vi.setSystemTime(Date.now() + 20); return allow; }, { timeoutMs: 10 });
    expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ effect: 'deny', reason: 'unavailable' });
  });
  it('propagates aborts and close without evaluating pre-aborted requests or publishing late allows', async () => {
    const delayed = deferred<AuthorizationDecision>(); let observed: AbortSignal | undefined;
    const { owner, evaluate } = setup((_request, context) => { observed = context.signal; return delayed.promise; });
    const abort = new AbortController(); abort.abort(); expect(await owner.authorize(subject, 'read', resource, { signal: abort.signal })).toMatchObject({ reason: 'cancelled' }); expect(evaluate).not.toHaveBeenCalled();
    const caller = new AbortController(); const work = owner.authorize(subject, 'read', resource, { signal: caller.signal }); await Promise.resolve(); caller.abort();
    expect(await work).toMatchObject({ effect: 'deny', reason: 'cancelled' }); expect(observed?.aborted).toBe(true); delayed.resolve(allow);
    const another = deferred<AuthorizationDecision>(); evaluate.mockReturnValue(another.promise); const closing = owner.authorize(subject, 'read', resource); await Promise.resolve(); owner.close();
    expect(await closing).toMatchObject({ reason: 'cancelled' }); expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ reason: 'cancelled' }); another.resolve(allow);
  });
  it('requires bounded configuration and preserves exact admitted request snapshots', () => {
    for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxConcurrent: 0 }, { maxConcurrent: 1025 }]) expect(() => createAuthorizer({ policy: { version: 'v1', authorize: () => allow }, limits })).toThrow();
    expect(authorizationRequest(subject, 'thread:read', resource)).toEqual({ subject, action: 'thread:read', resource });
  });
});

it('refuses a non-string deny reason without invoking coercion hooks', async () => {
  const toString = vi.fn(() => 'unavailable');
  const { owner } = setup(() => ({ effect: 'deny', reason: { toString }, policyVersion: 'v1', ruleId: null }) as never);
  expect(await owner.authorize(subject, 'read', resource)).toMatchObject({ reason: 'unavailable' }); expect(toString).not.toHaveBeenCalled();
});
