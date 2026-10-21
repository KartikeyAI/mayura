import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, createAuthorizer, type AuthorizationAuditEvent, type Authorizer } from '@mayura/core';
import { bindToolApproval } from '../src/host.js';
import { defineTool, invokeTool, invokeBatch, type InvokeToolContext } from '../src/index.js';
const owners: Authorizer[] = []; afterEach(() => { owners.splice(0).forEach(owner => owner.close()); vi.useRealTimers(); });
const scope = { principalId: 'alice', projectId: 'shop' };
function policy() {
  let allowed = true; const events: AuthorizationAuditEvent[] = [];
  const authorization = createAuthorizer({ policy: { version: 'v1', authorize: () => allowed
    ? { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } : { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null } },
    permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(authorization);
  return { authorization, events, revoke: () => { allowed = false; }, allow: () => { allowed = true; } };
}
function setup(execute = vi.fn(() => ({ saved: 'SECRET result' })), approval?: 'required') {
  const tool = defineTool({ id: 'save', version: '1', description: 'Save', input: z.object({ value: z.string() }), output: z.object({ saved: z.string() }),
    effects: 'write', capabilities: ['records:write'], costMicros: 7, execute, ...(approval ? { approval } : {}) });
  const budget = new Budget(100, 10);
  const context: InvokeToolContext = { runId: 'run-1', callId: 'call-1', scope, signal: new AbortController().signal,
    budget, permissions: { allow: ['tool:save', 'effect:write', 'records:write'] } };
  return { tool, execute, budget, context };
}
describe('tool execution authorization', () => {
  it('blocks direct writes before the handler and charges nothing while auditing only resource metadata', async () => {
    const { authorization, events, revoke } = policy(); revoke(); const { tool, execute, context, budget } = setup();
    const result = await invokeTool(tool, { value: 'SECRET arguments' }, { ...context, authorization });
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' }, receipt: { execution: 'not_started', disclosure: 'withheld' } });
    expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot()).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
    await authorization.flushAudit(); expect(events).toHaveLength(1); expect(events[0]?.request?.resource).toEqual({ kind: 'tool', id: 'save', scope });
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });
  it('keeps static capability admission ahead of policy callbacks', async () => {
    const { authorization, events } = policy(); const { tool, context } = setup();
    expect(await invokeTool(tool, { value: 'input' }, { ...context, authorization, permissions: { allow: [] } })).toMatchObject({ status: 'blocked' });
    await authorization.flushAudit(); expect(events).toHaveLength(0);
  });
  it('rechecks after scheduler waits and releases the permit without dispatch or spending', async () => {
    const { authorization, revoke } = policy(); const { tool, execute, context, budget } = setup(); const release = vi.fn();
    const result = await invokeTool(tool, { value: 'input' }, { ...context, authorization, acquireExecution: async () => { revoke(); return release; } });
    expect(result).toMatchObject({ status: 'blocked', receipt: { execution: 'not_started' } }); expect(release).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().spentMicros).toBe(0);
  });
  it('withholds revoked output while preserving successful execution evidence and its settled cost', async () => {
    const access = policy(); const execute = vi.fn(() => { access.revoke(); return { saved: 'SECRET result' }; }); const { tool, context, budget } = setup(execute);
    const result = await invokeTool(tool, { value: 'input' }, { ...context, authorization: access.authorization });
    expect(result).toMatchObject({ status: 'blocked', receipt: { execution: 'succeeded', disclosure: 'withheld' } }); expect(result).not.toHaveProperty('output');
    expect(execute).toHaveBeenCalledTimes(1); expect(budget.snapshot().spentMicros).toBe(7);
  });
  it('does not consume an exact approval proof when initial authorization denies', async () => {
    const access = policy(); access.revoke(); const { tool, execute, context } = setup(undefined, 'required'); const input = { value: 'input' };
    const approvalBinding = bindToolApproval(tool, { runId: context.runId, callId: context.callId, input });
    expect(await invokeTool(tool, input, { ...context, authorization: access.authorization, approvalBinding })).toMatchObject({ status: 'blocked' });
    access.allow(); expect(await invokeTool(tool, input, { ...context, authorization: access.authorization, approvalBinding })).toMatchObject({ status: 'succeeded' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('forwards the same authorizer into batch broker calls', async () => {
    const access = policy(); access.revoke(); const { tool, execute, context } = setup();
    await expect(invokeBatch([{ id: 'one', tool, input: { value: 'input' } }], { ...context, authorization: access.authorization })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('cancels policy work before tool dispatch and reports sanitized failures', async () => {
    let started!: () => void; let release!: (value: never) => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<never>(resolve => { release = resolve; }); let signal: AbortSignal | undefined;
    const authorization = createAuthorizer({ policy: { version: 'v1', authorize: (_request, context) => { signal = context.signal; started(); return delayed; } }, permissions: { allow: ['authz:evaluate'] } }); owners.push(authorization);
    const { tool, context, execute } = setup(); const abort = new AbortController(); const work = invokeTool(tool, { value: 'input' }, { ...context, signal: abort.signal, authorization });
    await ready; abort.abort(); expect(await work).toMatchObject({ status: 'cancelled' }); expect(signal?.aborted).toBe(true); expect(execute).not.toHaveBeenCalled(); release(undefined as never);
  });
  it('rejects forged prepared-input/prepaid proofs before execution or budget spending', async () => {
    const { tool, context, execute, budget } = setup();
    const result = await invokeTool(tool, { value: 'input' }, { ...context, preparedInput: { kind: 'prepared-tool-input' } });
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(execute).not.toHaveBeenCalled(); expect(budget.snapshot().spentMicros).toBe(0);
  });

});
