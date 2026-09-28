import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type Schema, type Scope } from '@mayura/core';
import { defineAgent, type AgentDefinition } from '@mayura/runtime';
import { defineTool, type AnyTool } from '@mayura/tools';
import { agentStep, createWorkflowLifecycleRuntime, defineWorkflowLifecycle, type WorkflowLifecycleRuntime } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';
import { testImage } from '../../testing/src/index.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'agent-step-test', validate: value => ({ value: value as JsonValue }) } };
const text: Schema<string> = { '~standard': { version: 1, vendor: 'agent-step-test',
  validate: value => typeof value === 'string' ? { value } : { issues: [{ message: 'text required' }] } } };
const scope = { principalId: 'operator', projectId: 'project' };
const final = (output: JsonValue, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const call = (toolId: string, input: JsonValue, costMicros = 0): ModelResponse => ({ type: 'tool_calls', calls: [{ id: `${toolId}-1`, toolId, input }], usage: { costMicros } });

/** A model that answers from a script, one response per call; a function may wait (for example for cancellation). */
function model(script: ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>)[]): ModelAdapter {
  let index = 0;
  return { id: 'fixture.model', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 40,
    generate: async request => { const next = script[Math.min(index++, script.length - 1)]!; return next(request); } };
}
const agentWith = (script: Parameters<typeof model>[0], tools: readonly AnyTool[] = []): AgentDefinition<Schema<JsonValue>, Schema<string>> =>
  defineAgent({ id: 'fixture.writer', version: '3', instructions: 'Fixture.', input: any, output: text, tools, model: model(script) });
const workflowOf = (tool: AnyTool) => defineWorkflowLifecycle({ id: 'agent-steps', version: '1', input: any, output: any,
  nodes: [{ kind: 'tool', id: 'write', tool, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'write', path: [] } });

describe('agentStep', () => {
  let fixture: WorkflowFixture | undefined; const runtimes: WorkflowLifecycleRuntime[] = [];
  afterEach(async () => { for (const runtime of runtimes.splice(0)) runtime.close(); await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });
  const run = async (tool: AnyTool, grants: readonly string[], input: JsonValue = 'topic', maxCostMicros = 1_000) => {
    fixture ??= await sqliteFixture(); await fixture.store.initialize();
    const runtime = createWorkflowLifecycleRuntime({ store: fixture.store, scope, permissions: { allow: [...grants] }, policyVersion: '1', maxCostMicros });
    runtimes.push(runtime);
    const workflow = workflowOf(tool);
    const submitted = await runtime.submit(workflow, { input, idempotencyKey: `run-${Math.random()}` });
    return { runtime, workflow, submitted, settle: () => runtime.runUntilSettled(workflow, submitted.id) };
  };

  it('runs the agent in the run\'s scope and charges what it actually spent', async () => {
    let seenScope: Scope | undefined;
    const lookup = defineTool({ id: 'fixture.lookup', version: '1', description: 'Look up.', input: any, output: any, effects: 'read', capabilities: [],
      execute: (_input, context) => { seenScope = context.scope; return 'facts'; } });
    const agent = agentWith([() => call('fixture.lookup', 'q', 5), () => final('a summary', 7)], [lookup]);
    const step = agentStep(agent, { id: 'writer.step', permissions: ['model:fixture.model', 'tool:fixture.lookup', 'effect:read'], limits: { maxCostMicros: 100 } });
    expect(step).toMatchObject({ id: 'writer.step', version: '3', effects: 'none', costMicros: 100, capabilities: ['effect:read'] });
    const { settle } = await run(step, ['tool:writer.step', 'effect:read']);
    expect(await settle()).toMatchObject({ status: 'succeeded', output: 'a summary', budget: { spentMicros: 12, reservedMicros: 0 } });
    expect(seenScope).toEqual(scope);
  });

  it('gives the agent media found when the step runs, while the workflow keeps only its JSON input', async () => {
    const seen: ModelRequest[] = [];
    const eyes = defineAgent({ id: 'fixture.eyes', version: '1', instructions: 'Look.', input: any, output: text, tools: [], media: { accept: ['image/png'] },
      model: { ...model([request => { seen.push(request); return final('a cat'); }]), capabilities: { tools: true, structuredOutput: true, media: { types: ['image/png'], urls: false } } } });
    const resolved: JsonValue[] = [];
    const step = agentStep(eyes, { id: 'eyes.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 100 },
      media: input => { resolved.push(input); return [testImage({ name: 'photo.png' })]; } });
    const { settle } = await run(step, ['tool:eyes.step'], { photo: 'artifact-ref-1' });
    expect(await settle()).toMatchObject({ status: 'succeeded', output: 'a cat' });
    expect(resolved).toEqual([{ photo: 'artifact-ref-1' }]);
    expect((seen[0]!.messages[0] as { media: readonly { name?: string }[] }).media.map(item => item.name)).toEqual(['photo.png']);
    // A media resolver that fails refuses the step before the agent runs, charging nothing.
    const broken = agentStep(eyes, { id: 'eyes.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 100 }, media: () => { throw new Error('gone'); } });
    expect(await (await run(broken, ['tool:eyes.step'], { photo: 'missing' })).settle()).toMatchObject({ status: 'failed', budget: { spentMicros: 0, reservedMicros: 0 } });
  });

  it('fails the step when the agent fails or is blocked, charging what it spent', async () => {
    const failing = agentStep(agentWith([() => final(42, 9)]), { id: 'writer.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 100 } });
    expect(await (await run(failing, ['tool:writer.step'])).settle()).toMatchObject({ status: 'failed', steps: { write: { status: 'failed' } },
      budget: { reservedMicros: 0 } });
    // No model grant: the agent is blocked before it spends anything.
    const blocked = agentStep(agentWith([() => final('x')]), { id: 'writer.step', permissions: [], limits: { maxCostMicros: 100 } });
    expect(await (await run(blocked, ['tool:writer.step'])).settle()).toMatchObject({ status: 'failed', steps: { write: { status: 'failed' } },
      budget: { spentMicros: 0, reservedMicros: 0 } });
  });

  it('makes the step unknown when the agent\'s outcome is unknown, keeping its ceiling reserved', async () => {
    const send = defineTool({ id: 'fixture.send', version: '1', description: 'Send.', input: any, output: any, effects: 'write', capabilities: [],
      execute: () => { throw new Error('connection reset after sending'); } });
    const agent = agentWith([() => call('fixture.send', 'hello', 3), () => final('sent')], [send]);
    const step = agentStep(agent, { id: 'writer.step', permissions: ['model:fixture.model', 'tool:fixture.send', 'effect:write'], limits: { maxCostMicros: 100 } });
    expect(step.capabilities).toEqual(['effect:write']);
    const settled = await (await run(step, ['tool:writer.step', 'effect:write'])).settle();
    expect(settled).toMatchObject({ status: 'outcome_unknown', steps: { write: { status: 'unknown' } }, budget: { spentMicros: 0, reservedMicros: 100 } });
  });

  it('needs the workflow to grant the effects of the agent\'s tools', async () => {
    const send = defineTool({ id: 'fixture.send', version: '1', description: 'Send.', input: any, output: any, effects: 'write', capabilities: [], execute: () => 'ok' });
    const step = agentStep(agentWith([() => final('x')], [send]), { id: 'writer.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 100 } });
    expect(await (await run(step, ['tool:writer.step'])).settle()).toMatchObject({ status: 'blocked', steps: { write: { status: 'blocked' } } });
  });

  it('cancels the agent with the step: an agent that can act leaves the step unknown, one that cannot leaves it failed', async () => {
    for (const acting of [true, false]) {
      let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
      const waitForAbort = (request: ModelRequest) => new Promise<ModelResponse>((_resolve, reject) => {
        started(); request.signal.addEventListener('abort', () => reject(new MayuraError('CANCELLED', 'Cancelled.')), { once: true });
      });
      const send = defineTool({ id: 'fixture.send', version: '1', description: 'Send.', input: any, output: any, effects: acting ? 'write' : 'read', capabilities: [], execute: () => 'ok' });
      const step = agentStep(agentWith([waitForAbort], [send]), { id: 'writer.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 100 } });
      const { runtime, submitted, settle } = await run(step, ['tool:writer.step', acting ? 'effect:write' : 'effect:read']);
      const settling = settle(); await running;
      await runtime.cancel(submitted.id);
      const settled = await settling;
      expect(settled.status).toBe('cancelled');
      expect((await runtime.inspect(submitted.id)).steps['write']).toMatchObject({ status: acting ? 'unknown' : 'failed' });
    }
  });

  it('maps input and output around the agent and can build the agent per run', async () => {
    const seen: JsonValue[] = [];
    const factoryStep = agentStep((input: { topic: string }) => agentWith([request => { seen.push(request.messages[0]?.role === 'user' ? request.messages[0].content : null); return final(`about ${input.topic}`, 2); }]), {
      id: 'writer.step', input: { '~standard': { version: 1, vendor: 't', validate: value => ({ value: value as { topic: string } }) } } as Schema<{ topic: string }>,
      output: any, effects: 'none', permissions: ['model:fixture.model'], limits: { maxCostMicros: 50 },
      prepare: input => `prepared ${input.topic}`,
      finish: (output, input) => ({ text: output, topic: input.topic }),
    });
    expect(await (await run(factoryStep, ['tool:writer.step'], { topic: 'tides' })).settle()).toMatchObject({ status: 'succeeded',
      output: { text: 'about tides', topic: 'tides' }, budget: { spentMicros: 2 } });
    expect(seen).toEqual(['prepared tides']);
    // `finish` may refuse the output: the step fails, and what the agent spent is still charged.
    const refusing = agentStep(agentWith([() => final('bad', 4)]), { id: 'writer.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 50 },
      finish: () => { throw new Error('The output cites an unknown source.'); } });
    expect(await (await run(refusing, ['tool:writer.step'])).settle()).toMatchObject({ status: 'failed', budget: { spentMicros: 4, reservedMicros: 0 } });
    // A built agent with stronger tools than declared never runs.
    const send = defineTool({ id: 'fixture.send', version: '1', description: 'Send.', input: any, output: any, effects: 'write', capabilities: [], execute: () => 'ok' });
    const understated = agentStep(() => agentWith([() => final('x')], [send]), { id: 'writer.step', input: any, output: any, effects: 'read',
      permissions: ['model:fixture.model'], limits: { maxCostMicros: 50 } });
    expect(await (await run(understated, ['tool:writer.step', 'effect:read'])).settle()).toMatchObject({ status: 'failed', budget: { spentMicros: 0 } });
  });

  it('keeps outcomes precise for an acting agent on a free model, which can report no cost', async () => {
    const free = (script: Parameters<typeof model>[0], tools: readonly AnyTool[]) => defineAgent({ id: 'fixture.free', version: '1', instructions: 'Fixture.',
      input: any, output: text, tools, model: { ...model(script), maxCostMicros: 0 } });
    const send = (fails: boolean) => defineTool({ id: 'fixture.send', version: '1', description: 'Send.', input: any, output: any, effects: 'write', capabilities: [],
      execute: () => { if (fails) throw new Error('connection reset after sending'); return 'sent'; } });
    const options = { id: 'writer.step', permissions: ['model:fixture.model', 'tool:fixture.send', 'effect:write'], limits: { maxCostMicros: 0 } };
    const grants = ['tool:writer.step', 'effect:write'];
    // With nothing to charge, the step declares the agent's effects itself, so the workflow grants effect:write for it.
    const succeeding = agentStep(free([() => call('fixture.send', 'x'), () => final('done')], [send(false)]), options);
    expect(succeeding).toMatchObject({ effects: 'write', costMicros: 0, capabilities: [] });
    expect(await (await run(succeeding, grants, 'x', 0)).settle()).toMatchObject({ status: 'succeeded', output: 'done' });
    expect(await (await run(succeeding, ['tool:writer.step'], 'x', 0)).settle()).toMatchObject({ status: 'blocked' });
    // A failed agent (it answered with the wrong type) is a plain failure; an uncertain tool call makes the step unknown.
    const failing = agentStep(free([() => call('fixture.send', 'x'), () => final(7)], [send(false)]), options);
    expect(await (await run(failing, grants, 'x', 0)).settle()).toMatchObject({ status: 'failed', steps: { write: { status: 'failed' } } });
    const uncertain = agentStep(free([() => call('fixture.send', 'x'), () => final('done')], [send(true)]), options);
    expect(await (await run(uncertain, grants, 'x', 0)).settle()).toMatchObject({ status: 'outcome_unknown', steps: { write: { status: 'unknown' } } });
  });

  it('observes the agent\'s run without letting an observer fail the step', async () => {
    const observed: string[] = [];
    const step = agentStep(agentWith([() => final('ok', 1)]), { id: 'writer.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: 50 },
      onRun: run => { observed.push(run.id); return () => { observed.push('ended'); throw new Error('observer failed'); }; } });
    expect(await (await run(step, ['tool:writer.step'])).settle()).toMatchObject({ status: 'succeeded', output: 'ok' });
    expect(observed).toEqual([expect.any(String), 'ended']);
  });

  it('refuses incomplete configuration with a message that says what is missing', () => {
    const agent = agentWith([() => final('x')]);
    expect(() => agentStep(agent, { id: 'writer.step', permissions: ['model:fixture.model'], limits: {} as never })).toThrow(/needs limits\.maxCostMicros/);
    expect(() => agentStep(agent, { id: 'writer.step', permissions: ['model:fixture.model'], limits: { maxCostMicros: -1 } })).toThrow(/needs limits\.maxCostMicros/);
    expect(() => agentStep(agent, { id: '', permissions: [], limits: { maxCostMicros: 1 } })).toThrow(/needs an id/);
    expect(() => agentStep(agent, { id: 'writer.step', permissions: 'model:x' as never, limits: { maxCostMicros: 1 } })).toThrow(/needs permissions/);
    expect(() => agentStep((() => agent) as never, { id: 'writer.step', permissions: [], limits: { maxCostMicros: 1 } } as never)).toThrow(/input and output schemas/);
    expect(() => agentStep({} as never, { id: 'writer.step', permissions: [], limits: { maxCostMicros: 1 } })).toThrow(MayuraError);
  });
});
