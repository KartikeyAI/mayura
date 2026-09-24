import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Guard, type GuardContext, type JsonValue, type ModelAdapter, type ModelResponse, type Schema } from '@mayura/core';
import { createPipeline, type ContentProcessor } from '../../guardrails/src/index.js';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent, defineHook, type Runtime } from '../src/index.js';

const schema: Schema<JsonValue> = {
  '~standard': { version: 1, vendor: 'release-gate-v08', validate: value => ({ value: value as JsonValue }) },
};
const context = (): GuardContext => ({
  runId: 'release-gate-v08', callId: 'candidate', boundary: 'output',
  scope: { principalId: 'release', projectId: 'mayura' }, signal: new AbortController().signal,
});
const final = (output: JsonValue): ModelResponse => ({ type: 'final', output, usage: { costMicros: 0 } });
const model = (generate: ModelAdapter['generate']): ModelAdapter => ({
  id: 'primary', maxCostMicros: 0, capabilities: { tools: true, structuredOutput: true }, generate,
});
const runtimes: Runtime[] = [];

function runtime(): Runtime {
  const value = createRuntime({
    profile: 'ephemeral', scope: { principalId: 'release', projectId: 'mayura' },
    permissions: { allow: ['model:primary', 'tool:write', 'effect:write'] },
    limits: { maxDurationMs: 2_000, maxCostMicros: 0, maxSteps: 2 },
  });
  runtimes.push(value); return value;
}

afterEach(async () => { await Promise.all(runtimes.splice(0).map(value => value.close())); });

describe('V08 processor and hook integrity acceptance', () => {
  it('invalidates pre-transform identity and binds guard evidence only to the transformed candidate', async () => {
    const seen: JsonValue[] = [];
    const transform: ContentProcessor = { id: 'transform', version: '1', process: () => 'transformed' };
    const guard: Guard = { id: 'exact-candidate', check: value => { seen.push(value); return { decision: value === 'transformed' ? 'allow' : 'block' }; } };
    const result = await createPipeline({ processors: [transform], guards: [guard] }).process('original', context());
    expect(result).toMatchObject({ status: 'succeeded', output: { version: 2, value: 'transformed' } });
    if (result.status !== 'succeeded') throw new Error('Expected transformed candidate admission.');
    expect(seen).toEqual(['transformed']);
    expect(result.output.checks).toEqual([{
      guardId: 'exact-candidate', version: 2, digest: result.output.digest, decision: 'allow',
    }]);

    const denied = await createPipeline({
      processors: [{ id: 'unsafe-transform', version: '1', process: () => 'unsafe' }],
      guards: [{ id: 'deny-transformed', check: value => ({ decision: value === 'original' ? 'allow' : 'block' }) }],
    }).process('original', context());
    expect(denied).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(denied).not.toHaveProperty('output');
  });

  it('rejects a hook replacement after final guards instead of releasing a mutated candidate', async () => {
    const release = defineHook({
      id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [],
      handler: event => {
        expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(event.candidate)).toBe(true);
        return { decision: 'continue', replacement: 'forged-output' } as never;
      },
    });
    const engine = runtime();
    const run = engine.submit(defineAgent({
      id: 'agent', version: '1', instructions: 'fixture', input: schema, output: schema, tools: [],
      model: model(async () => final('guarded-output')),
      guards: { output: [{ id: 'allow', check: () => ({ decision: 'allow' }) }] }, hooks: [release],
    }), { input: 1 });

    const result = await run.result();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(result).not.toHaveProperty('output');
    expect(JSON.stringify(result)).not.toContain('forged-output');
  });

  it('keeps a completed effect truthful and withheld when a required callback fails', async () => {
    const execute = vi.fn(async () => 'private-tool-output');
    const write = defineTool({ id: 'write', version: '1', description: 'Write fixture.', input: schema, output: schema,
      effects: 'write', capabilities: [], execute });
    const release = defineHook({
      id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [],
      handler: () => { throw new Error('private-callback-failure'); },
    });
    const primary = vi.fn(async (): Promise<ModelResponse> => ({
      type: 'tool_calls', calls: [{ id: 'call.1', toolId: 'write', input: 1 }], usage: { costMicros: 0 },
    }));
    const engine = runtime();
    const run = engine.submit(defineAgent({
      id: 'agent', version: '1', instructions: 'fixture', input: schema, output: schema, tools: [write],
      model: model(primary), guards: { output: [{ id: 'allow', check: () => ({ decision: 'allow' }) }] }, hooks: [release],
    }), { input: 1 });

    const result = await run.result();
    expect(result).toMatchObject({
      status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' },
      receipt: { toolId: 'write', callId: 'call.1', execution: 'succeeded', disclosure: 'withheld' },
    });
    expect(execute).toHaveBeenCalledOnce(); expect(primary).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/private-tool-output|private-callback-failure/u);
  });

  it('keeps denial final when its notification callback fails', async () => {
    const pipeline = createPipeline({
      guards: [{ id: 'deny', check: () => ({ decision: 'block' }) }],
      onBlocked: () => { throw new Error('private-notification-failure'); },
    });
    const result = await pipeline.process('private-candidate', context());
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(result).not.toHaveProperty('output');
    expect(JSON.stringify(result)).not.toMatch(/private-candidate|private-notification-failure/u);
  });
});
