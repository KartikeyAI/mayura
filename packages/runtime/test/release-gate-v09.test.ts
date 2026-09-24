import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Guard,
  type JsonValue,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type Schema,
} from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineModerationGuard } from '../../guardrails/src/index.js';
import { createRuntime, defineAgent, type Runtime } from '../src/index.js';

const schema: Schema<JsonValue> = {
  '~standard': { version: 1, vendor: 'release-gate-v09', validate: value => ({ value: value as JsonValue }) },
};
const final = (output: JsonValue, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const adapter = (id: string, maxCostMicros: number, generate: ModelAdapter['generate']): ModelAdapter => ({
  id, maxCostMicros, capabilities: { tools: true, structuredOutput: true }, generate,
});
const runtimes: Runtime[] = [];

function runtime(maxCostMicros = 10): Runtime {
  const value = createRuntime({
    profile: 'ephemeral',
    scope: { principalId: 'release', projectId: 'mayura' },
    permissions: { allow: ['model:primary', 'model:moderator', 'tool:write', 'effect:write'] },
    limits: { maxDurationMs: 2_000, maxCostMicros, maxModelCalls: 3, maxToolCalls: 1, maxSteps: 2 },
  });
  runtimes.push(value); return value;
}

afterEach(async () => { await Promise.all(runtimes.splice(0).map(value => value.close())); });

describe('V09 guardrail barrier acceptance', () => {
  it('performs zero primary generation and zero tool dispatch after mandatory local admission denial', async () => {
    const execute = vi.fn(async () => 1);
    const write = defineTool({ id: 'write', version: '1', description: 'Write fixture.', input: schema, output: schema,
      effects: 'write', capabilities: [], execute });
    const primary = vi.fn(async (): Promise<ModelResponse> => ({
      type: 'tool_calls', calls: [{ id: 'call.1', toolId: 'write', input: 1 }], usage: { costMicros: 0 },
    }));
    const deny: Guard = { id: 'mandatory', check: () => ({ decision: 'block' }) };
    const engine = runtime();
    const run = engine.submit(defineAgent({
      id: 'agent', version: '1', instructions: 'fixture', input: schema, output: schema, tools: [write],
      model: adapter('primary', 0, primary), guards: { input: [deny] },
    }), { input: 1 });

    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(primary).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('runs a mandatory auxiliary check without tools or recursion and accounts its denial exactly', async () => {
    const requests: ModelRequest[] = [];
    const moderator = vi.fn(async (request: ModelRequest) => {
      requests.push(request); return final({ decision: 'block', categories: ['policy.release'] }, 2);
    });
    const primary = vi.fn(async () => final(1));
    const guard = defineModerationGuard({
      id: 'moderation', version: '1', instructions: 'fixture', egressGuards: [],
      model: adapter('moderator', 2, moderator), limits: { maxOutputTokens: 32 },
    });
    const engine = runtime();
    const run = engine.submit(defineAgent({
      id: 'agent', version: '1', instructions: 'fixture', input: schema, output: schema, tools: [],
      model: adapter('primary', 0, primary), guards: { input: [guard] },
    }), { input: { private: 'candidate' } });

    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(primary).not.toHaveBeenCalled(); expect(moderator).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({ tools: [], maxOutputTokens: 32 });
    expect(requests[0]).not.toHaveProperty('continuation');
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
  });

  it('atomically rejects an unaffordable required auxiliary barrier before any model dispatch', async () => {
    const moderator = vi.fn(async () => final({ decision: 'allow', categories: [] }, 2));
    const primary = vi.fn(async () => final(1));
    const guard = defineModerationGuard({
      id: 'moderation', version: '1', instructions: 'fixture', egressGuards: [],
      model: adapter('moderator', 2, moderator),
    });
    const engine = runtime(1);
    const run = engine.submit(defineAgent({
      id: 'agent', version: '1', instructions: 'fixture', input: schema, output: schema, tools: [],
      model: adapter('primary', 0, primary), guards: { input: [guard] },
    }), { input: 1 });

    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(moderator).not.toHaveBeenCalled(); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });
});
