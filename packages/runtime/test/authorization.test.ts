import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAuthorizer, type AuthorizationAuditEvent, type Authorizer, type ModelResponse, type ModelStreamEvent, type RunHandle } from '@mayura/core';
import { scriptedModel } from '@mayura/testing';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent, type AgentDefinition, type AgentHandoff, type Runtime, type RuntimeOptions } from '../src/index.js';
const scope = { principalId: 'alice', projectId: 'shop' }; const runtimes: Runtime[] = []; const owners: Authorizer[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); owners.splice(0).forEach(owner => owner.close()); });
const final: ModelResponse = { type: 'final', output: { reply: 'SECRET final' }, usage: { costMicros: 0 } };
function policy() {
  const denied = new Set<string>(); const events: AuthorizationAuditEvent[] = [];
  const authorization = createAuthorizer({ policy: { version: 'v1', authorize: request => denied.has(`${request.resource.kind}:${request.action}:${request.resource.id}`) || denied.has(`${request.resource.kind}:${request.action}:*`)
    ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null } : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } },
    permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(authorization); return { authorization, denied, events };
}
function agent(steps: Parameters<typeof scriptedModel>[0], extra: { id?: string; tools?: readonly ReturnType<typeof defineTool>[]; handoffs?: readonly AgentHandoff[] } = {}) {
  const model = scriptedModel(steps); const generate = vi.fn(model.generate.bind(model));
  const definition = defineAgent({ id: extra.id ?? 'support', version: '1', instructions: 'PRIVATE instructions', tools: extra.tools ?? [], handoffs: extra.handoffs ?? [],
    model: { ...model, generate }, input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }) });
  return { definition, generate };
}
function runtime(authorization: Authorizer, options: Partial<RuntimeOptions> = {}) {
  const value = createRuntime({ profile: 'ephemeral', scope, authorization, permissions: { allow: ['model:scripted', 'tool:save', 'effect:write'] }, limits: { maxCostMicros: 100 }, ...options }); runtimes.push(value); return value;
}
async function waiting(run: RunHandle<unknown>) { for await (const event of run.observe()) if (event.type === 'approval.requested') return; throw new Error('Run did not wait'); }
function writer(approval?: 'required') {
  const execute = vi.fn(() => ({ saved: true })); const tool = defineTool({ id: 'save', version: '1', description: 'Save', input: z.object({}), output: z.object({ saved: z.boolean() }),
    effects: 'write', capabilities: [], execute, ...(approval ? { approval } : {}) }); return { tool, execute };
}
describe('runtime execution authorization', () => {
  it('keeps submit synchronous while denying agent/run admission before model, hooks or recording', async () => {
    for (const resource of ['agent', 'run']) {
      const { authorization, denied, events } = policy(); denied.add(`${resource}:execute:*`); const { definition, generate } = agent([final]); const begin = vi.fn(async () => {});
      const engine = runtime(authorization, { recorder: { begin, complete: vi.fn(async () => {}) } });
      const run = engine.submit(definition, { input: { message: 'SECRET input' }, recording: { threadId: 'chat' } }); expect(typeof run.id).toBe('string');
      expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } }); expect(generate).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
      await authorization.flushAudit(); expect(events.some(event => event.decision.effect === 'deny')).toBe(true); expect(JSON.stringify(events)).not.toContain('SECRET');
    }
  });
  it('withholds a final result if run execution is revoked while the model is running', async () => {
    const { authorization, denied } = policy(); const { definition, generate } = agent([() => { denied.add('run:execute:*'); return final; }]);
    const engine = runtime(authorization); const result = await engine.submit(definition, { input: { message: 'Hello' } }).result();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } }); expect(result).not.toHaveProperty('output'); expect(generate).toHaveBeenCalledTimes(1);
  });
  it('blocks revoked streamed output without misclassifying the denial as a provider failure', async () => {
    const { authorization, denied } = policy();
    const model = scriptedModel([final]);
    const definition = defineAgent({ id: 'streamed', version: '1', instructions: 'Private', tools: [], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
      model: { ...model, async *stream(): AsyncIterable<ModelStreamEvent> {
        denied.add('run:execute:*'); yield { type: 'output.delta', text: JSON.stringify({ reply: 'SECRET streamed output' }) };
        yield { type: 'response', response: final };
      } }, stream: { field: ['reply'], guards: [], batch: { minChars: 1, maxChars: 16 } } });
    const run = runtime(authorization).submit(definition, { input: { message: 'Hello' } });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    const emitted = []; for await (const event of run.observe()) emitted.push(event); expect(emitted.some(event => event.type === 'output.delta')).toBe(false);
  });
  it('refuses denied tool proposals without prompting approval or executing a write', async () => {
    const { authorization, denied } = policy(); denied.add('tool:execute:save'); const { tool, execute } = writer('required');
    const { definition } = agent([{ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'save', input: {} }], usage: { costMicros: 0 } }, final], { tools: [tool] });
    const run = runtime(authorization).submit(definition, { input: { message: 'Hello' } }); await run.result();
    const events = []; for await (const event of run.observe()) events.push(event.type); expect(events).not.toContain('approval.requested'); expect(execute).not.toHaveBeenCalled();
  });
  it('rechecks current tool policy before accepting human approval and leaves the pending answer intact', async () => {
    const access = policy(); const { tool, execute } = writer('required'); const { definition } = agent([{ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'save', input: {} }], usage: { costMicros: 0 } }, final], { tools: [tool] });
    const engine = runtime(access.authorization); const run = engine.submit(definition, { input: { message: 'Hello' } }); await waiting(run); const pending = engine.inspect(run).approval!;
    access.denied.add('tool:execute:save'); await expect(engine.approve(run, { callId: pending.callId, digest: pending.digest, decision: 'approved', actorId: 'human' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(execute).not.toHaveBeenCalled(); expect(engine.inspect(run).approval?.digest).toBe(pending.digest);
    access.denied.clear(); await engine.approve(run, { callId: pending.callId, digest: pending.digest, decision: 'approved', actorId: 'human' }); await run.result(); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('gates target agent policy on a handoff despite explicit target execution grants', async () => {
    const { authorization, denied } = policy(); denied.add('agent:handoff:billing'); const target = agent([final], { id: 'billing' });
    const source = agent([{ type: 'tool_calls', calls: [{ id: 'h1', toolId: 'handoff.billing', input: { message: 'Forward' } }], usage: { costMicros: 0 } }],
      { handoffs: [{ agent: target.definition as AgentDefinition, permissions: { allow: ['model:scripted'] } }] });
    const engine = runtime(authorization, { permissions: { allow: ['model:scripted', 'agent:billing'] } });
    expect(await engine.submit(source.definition, { input: { message: 'Hello' } }).result()).toMatchObject({ status: 'blocked' }); expect(target.generate).not.toHaveBeenCalled();
  });
  it('refuses child execution while preserving separate delegation grants', async () => {
    const { authorization, denied } = policy(); denied.add('agent:delegate:child'); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }); const pending = new Promise<void>(resolve => { release = resolve; });
    const parent = agent([async () => { started(); await pending; return final; }]); const child = agent([final], { id: 'child' });
    const engine = runtime(authorization, { permissions: { allow: ['model:scripted', 'agent:delegate', 'agent:child'] } }); const root = engine.submit(parent.definition, { input: { message: 'Hello' } }); await ready;
    const run = engine.spawn(root, child.definition, { input: { message: 'Child' }, permissions: { allow: ['model:scripted'] } });
    expect(await run.result()).toMatchObject({ status: 'blocked' }); expect(child.generate).not.toHaveBeenCalled(); release(); await root.result();
  });
});
