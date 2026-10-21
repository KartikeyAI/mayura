import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, snapshotAuthorizationAuditEvent, type AuthorizationAuditEvent, type AuthorizationAuditOptions, type AuthorizationDecision, type AuthorizationPolicy, type Authorizer } from '../src/index.js';
const scope = { principalId: 'alice', projectId: 'shop' };
const resource = { kind: 'thread' as const, id: 'chat', scope };
const allow: AuthorizationDecision = { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: 'reader' };
const owners: Authorizer[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
function setup(audit: AuthorizationAuditOptions, authorize: AuthorizationPolicy['authorize'] = () => allow, permissions = ['authz:evaluate', 'authz:audit']) {
  const owner = createAuthorizer({ policy: { version: 'v1', authorize }, audit, permissions: { allow: permissions } }); owners.push(owner); return owner;
}

describe('authorization audit delivery', () => {
  it('emits one immutable allow/deny receipt per evaluation, including local refusals without policy execution', async () => {
    const events: AuthorizationAuditEvent[] = []; const evaluate = vi.fn(() => allow);
    const owner = setup({ sink: event => { events.push(event); } }, evaluate);
    await owner.authorize(scope, 'read', resource);
    await owner.authorize(scope, 'read', { ...resource, scope: { ...scope, projectId: 'other' } });
    await owner.require(scope, 'read', resource);
    await owner.flushAudit();
    expect(evaluate).toHaveBeenCalledTimes(2); expect(events.map(event => event.decision.reason)).toEqual(['allowed', 'scope_mismatch', 'allowed']);
    expect(new Set(events.map(event => event.id)).size).toBe(3);
    expect(events.every(event => Object.isFrozen(event) && Object.isFrozen(event.request!.resource))).toBe(true);
    expect(owner.auditSnapshot()).toMatchObject({ produced: 3, delivered: 3, dropped: 0, failed: 0, inFlight: 0 });
  });
  it('never copies rejected request fields or provider exceptions', async () => {
    const events: AuthorizationAuditEvent[] = []; const owner = setup({ sink: event => { events.push(event); } }, () => { throw new Error('SECRET backend key'); });
    await owner.authorize(scope, 'read', { ...resource, secret: 'SECRET input' } as never);
    await owner.authorize(scope, 'read', resource); await owner.flushAudit();
    expect(events[0]).toMatchObject({ request: null, decision: { reason: 'invalid_request' } });
    expect(events[1]?.decision.reason).toBe('unavailable'); expect(JSON.stringify(events)).not.toContain('SECRET');
  });
  it('requires a separate audit grant and validates bounds without calling a sink', () => {
    const sink = vi.fn(); expect(() => setup({ sink }, undefined, ['authz:evaluate'])).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    for (const audit of [{ sink, maxConcurrent: 0 }, { sink, timeoutMs: 30_001 }, { sink, extra: true }])
      expect(() => setup(audit)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(sink).not.toHaveBeenCalled();
  });
  it('audits missing evaluate permissions without evaluating policy', async () => {
    const events: AuthorizationAuditEvent[] = []; const evaluate = vi.fn(() => allow);
    const owner = setup({ sink: event => { events.push(event); } }, evaluate, ['authz:audit']);
    await expect(owner.require(scope, 'read', resource)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); await owner.flushAudit();
    expect(events[0]?.decision.reason).toBe('permission_denied'); expect(evaluate).not.toHaveBeenCalled();
  });
  it('isolates sink throws and rejected promises from allow decisions', async () => {
    for (const sink of [() => { throw new Error('SECRET sink'); }, () => Promise.reject(new Error('SECRET sink'))]) {
      const owner = setup({ sink }); expect(await owner.authorize(scope, 'read', resource)).toEqual(allow); await owner.flushAudit();
      expect(owner.auditSnapshot()).toMatchObject({ delivered: 0, failed: 1, inFlight: 0 });
      expect(JSON.stringify(owner.auditSnapshot())).not.toContain('SECRET');
    }
  });
  it('drops excess deliveries, retains timed-out capacity until settlement and flushes only to the deadline', async () => {
    vi.useFakeTimers(); let release!: () => void; let signal: AbortSignal | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = setup({ maxConcurrent: 1, timeoutMs: 10, sink: (_event, context) => { signal = context.signal; return pending; } });
    await owner.authorize(scope, 'read', resource); await owner.authorize(scope, 'read', resource);
    const drain = owner.flushAudit(); await vi.advanceTimersByTimeAsync(10); await drain;
    expect(signal?.aborted).toBe(true); expect(owner.auditSnapshot()).toMatchObject({ produced: 2, timedOut: 1, dropped: 1, inFlight: 1 });
    await owner.authorize(scope, 'read', resource); expect(owner.auditSnapshot().dropped).toBe(2);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(owner.auditSnapshot()).toMatchObject({ timedOut: 1, delivered: 0, inFlight: 0 });
  });
  it('emits one timeout denial even when a policy later resolves with allow', async () => {
    vi.useFakeTimers(); const events: AuthorizationAuditEvent[] = []; let release!: (value: AuthorizationDecision) => void;
    const late = new Promise<AuthorizationDecision>(resolve => { release = resolve; });
    const owner = setup({ sink: event => { events.push(event); } }, () => late);
    const work = owner.authorize(scope, 'read', resource); await vi.advanceTimersByTimeAsync(1000);
    expect(await work).toMatchObject({ reason: 'unavailable' }); await owner.flushAudit();
    release(allow); await Promise.resolve(); await Promise.resolve();
    expect(events).toHaveLength(1); expect(events[0]?.decision.reason).toBe('unavailable');
  });
  it('records caller cancellation but cancels delivery on explicit authorizer close', async () => {
    const events: AuthorizationAuditEvent[] = []; const owner = setup({ sink: event => { events.push(event); } });
    const abort = new AbortController(); abort.abort(); await owner.authorize(scope, 'read', resource, { signal: abort.signal }); await owner.flushAudit();
    expect(events[0]?.decision.reason).toBe('cancelled');
    let release!: () => void; let signal: AbortSignal | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const hanging = setup({ sink: (_event, context) => { signal = context.signal; return pending; } });
    await hanging.authorize(scope, 'read', resource); hanging.close(); await hanging.flushAudit();
    expect(signal?.aborted).toBe(true); expect(hanging.auditSnapshot().cancelled).toBe(1); release();
  });
  it('rejects executable and unknown fields at the consumer boundary without invoking getters', async () => {
    let event!: AuthorizationAuditEvent; const owner = setup({ sink: value => { event = value; } });
    await owner.authorize(scope, 'read', resource); await owner.flushAudit();
    const getter = vi.fn(() => 'SECRET'); const executable = { ...event }; Object.defineProperty(executable, 'timestamp', { enumerable: true, get: getter });
    for (const bad of [executable, { ...event, prompt: 'SECRET' }, { ...event, request: { ...event.request!, roles: ['admin'] } },
      { ...event, decision: { ...event.decision, reason: 'SECRET' } }]) expect(() => snapshotAuthorizationAuditEvent(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(getter).not.toHaveBeenCalled();
  });
});
