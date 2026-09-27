import { describe, expect, it } from 'vitest';
import { MayuraError, ModelInvocationError, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type ModelStreamEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createModelRouter, createRuntime, defineAgent, type ModelRouterAttempt } from '../src/index.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'router-test', validate: value => ({ value: value as JsonValue }) } };
type Behaviour = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>;
function adapter(id: string, maxCostMicros: number, behaviour: Behaviour): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { id, maxCostMicros, requests, capabilities: { tools: true, structuredOutput: true },
    async generate(request) { requests.push(request); return behaviour(request); } };
}
const final = (output: JsonValue, costMicros = 1): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const unavailable: Behaviour = () => { throw new MayuraError('MODEL_FAILED', 'Provider unavailable.'); };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest =>
  ({ instructions: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal, maxOutputTokens: 64, ...overrides });

describe('createModelRouter', () => {
  it('uses the first route and pins the run to it', async () => {
    const primary = adapter('primary', 10, () => final('a', 3)); const backup = adapter('backup', 20, () => final('b'));
    const router = createModelRouter({ id: 'router.main', routes: [primary, backup] });
    expect(router.maxCostMicros).toBe(30);
    expect(await router.generate(request())).toEqual({ type: 'final', output: 'a', usage: { costMicros: 3 }, continuation: { router: 'router.main', route: 0 } });
    expect(backup.requests).toHaveLength(0);
  });

  it('fails over and charges a failed attempt its confirmed cost, or its full bound when the cost is unknown', async () => {
    const attempts: ModelRouterAttempt[] = [];
    const unknownCost = adapter('primary', 10, unavailable); const knownCost = adapter('second', 7, () => { throw new ModelInvocationError(4); });
    const backup = adapter('backup', 20, () => final('b', 2));
    const router = createModelRouter({ id: 'router.main', routes: [unknownCost, knownCost, backup], onAttempt: attempt => attempts.push(attempt) });
    const response = await router.generate(request());
    expect(response).toMatchObject({ output: 'b', usage: { costMicros: 10 + 4 + 2 }, continuation: { route: 2 } });
    expect(attempts.map(attempt => [attempt.modelId, attempt.outcome, attempt.costMicros])).toEqual([['primary', 'failed', null], ['second', 'failed', 4], ['backup', 'succeeded', 2]]);
  });

  it('treats an adapter timeout as a failover, but never fails over after the caller cancels', async () => {
    const attempts: ModelRouterAttempt[] = [];
    const slow = adapter('slow', 5, () => { throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.'); });
    const backup = adapter('backup', 5, () => final('b'));
    const router = createModelRouter({ id: 'router.main', routes: [slow, backup], onAttempt: attempt => attempts.push(attempt) });
    expect((await router.generate(request())).type).toBe('final');
    expect(attempts[0]).toMatchObject({ outcome: 'failed', reason: 'timeout' });

    const controller = new AbortController(); const first = adapter('first', 5, () => { controller.abort(); throw new MayuraError('CANCELLED', 'x'); });
    const second = adapter('second', 5, () => final('never'));
    await expect(createModelRouter({ id: 'router.cancel', routes: [first, second] }).generate(request({ signal: controller.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(second.requests).toHaveLength(0);
  });

  it('does not fail over after a configuration or authorization error, which every route would repeat', async () => {
    const misconfigured = adapter('primary', 5, () => { throw new MayuraError('INVALID_CONFIG', 'Every provider-exposed tool requires a schema.'); });
    const backup = adapter('backup', 5, () => final('b'));
    await expect(createModelRouter({ id: 'router.main', routes: [misconfigured, backup] }).generate(request())).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    expect(backup.requests).toHaveLength(0);
  });

  it('reports the total confirmed cost when every route fails with a known cost, and fails closed when any cost is unknown', async () => {
    const a = adapter('a', 5, () => { throw new ModelInvocationError(2); }); const b = adapter('b', 5, () => { throw new ModelInvocationError(3); });
    const error = await createModelRouter({ id: 'router.known', routes: [a, b] }).generate(request()).catch(value => value);
    expect(error).toBeInstanceOf(ModelInvocationError); expect(error.costMicros).toBe(5);
    await expect(createModelRouter({ id: 'router.unknown', routes: [adapter('c', 5, unavailable), adapter('d', 5, () => { throw new ModelInvocationError(1); })] })
      .generate(request())).rejects.not.toBeInstanceOf(ModelInvocationError);
  });

  it('opens a circuit after repeated failures, skips the route while it cools down, then tries it once', async () => {
    let clock = 0; let healthy = false;
    const flaky = adapter('flaky', 5, () => { if (!healthy) throw new MayuraError('MODEL_FAILED', 'down'); return final('flaky'); });
    const backup = adapter('backup', 5, () => final('backup'));
    const router = createModelRouter({ id: 'router.main', routes: [flaky, backup], circuit: { failureThreshold: 2, cooldownMs: 1_000 }, now: () => clock });
    await router.generate(request()); await router.generate(request());
    expect(router.status()[0]).toMatchObject({ state: 'open', consecutiveFailures: 2, openUntilMs: 1_000 });
    await router.generate(request()); expect(flaky.requests).toHaveLength(2); // skipped while open
    clock = 1_000; healthy = true;
    expect((await router.generate(request())).type === 'final' && (await router.generate(request()))).toBeTruthy();
    expect(router.status()[0]).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('keeps a run on the route holding its continuation, and moves only the portable history when that route fails', async () => {
    let backupUp = true;
    const primary = adapter('primary', 5, () => final('p'));
    const backup = adapter('backup', 5, () => { if (!backupUp) throw new MayuraError('MODEL_FAILED', 'down'); return { type: 'tool_calls', calls: [{ id: 'c1', toolId: 't', input: {} }], usage: { costMicros: 1 }, continuation: { secret: 'backup-state' } }; });
    const router = createModelRouter({ id: 'router.main', routes: [primary, backup] });
    const first = await createModelRouter({ id: 'router.main', routes: [adapter('down', 5, unavailable), backup] }).generate(request());
    expect(first.continuation).toEqual({ router: 'router.main', route: 1, inner: { secret: 'backup-state' } });
    await router.generate(request({ continuation: first.continuation! }));
    expect(backup.requests.at(-1)!.continuation).toEqual({ secret: 'backup-state' }); expect(primary.requests).toHaveLength(0);
    backupUp = false;
    expect(await router.generate(request({ continuation: first.continuation! }))).toMatchObject({ output: 'p', continuation: { route: 0 } });
    expect(primary.requests.at(-1)!).not.toHaveProperty('continuation');
    await expect(router.generate(request({ continuation: { router: 'other', route: 0 } }))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  });

  it('bounds its reservation by the routes it may try and validates its configuration', () => {
    const routes = [adapter('a', 10, unavailable), adapter('b', 30, unavailable), adapter('c', 20, unavailable)];
    expect(createModelRouter({ id: 'r', routes, maxAttempts: 2 }).maxCostMicros).toBe(50);
    expect(() => createModelRouter({ id: 'r', routes: [] })).toThrow(MayuraError);
    expect(() => createModelRouter({ id: 'r', routes, maxAttempts: 4 })).toThrow(MayuraError);
    expect(() => createModelRouter({ id: 'bad id', routes })).toThrow(MayuraError);
  });

  it('serves an agent through the runtime: granted as one model, charged the true total, tools still brokered', async () => {
    const lookup = defineTool({ id: 'lookup', version: '1', description: 'Look up.', input: any, output: any, effects: 'none', capabilities: [], costMicros: 0,
      inputJsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: () => ({ found: true }) });
    let calls = 0;
    const primary = adapter('primary', 10, unavailable);
    const backup = adapter('backup', 10, () => (calls++ === 0
      ? { type: 'tool_calls', calls: [{ id: 'l1', toolId: 'lookup', input: {} }], usage: { costMicros: 1 } } : final({ ok: true }, 1)));
    const model = createModelRouter({ id: 'router.agent', routes: [primary, backup], circuit: { failureThreshold: 1, cooldownMs: 60_000 } });
    const agent = defineAgent({ id: 'routed', version: '1', instructions: 'x', input: any, output: any, tools: [lookup], model });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:router.agent', 'tool:lookup'] }, limits: { maxCostMicros: 100 } });
    try {
      const run = runtime.submit(agent, { input: 'go' });
      expect(await run.result()).toMatchObject({ status: 'succeeded', output: { ok: true } });
      // First call: primary's unknown-cost failure (10) plus backup (1); second call: primary skipped (circuit open), backup (1).
      const observed: { metadata?: unknown }[] = []; for await (const event of run.observe()) observed.push(event);
      expect(observed.at(-1)?.metadata).toMatchObject({ spentMicros: 12, reservedMicros: 0 });
      expect(primary.requests).toHaveLength(1);
    } finally { await runtime.close(); }
    const denied = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:primary', 'model:backup', 'tool:lookup'] } });
    try { expect((await denied.submit(agent, { input: 'go' }).result()).status).not.toBe('succeeded'); } finally { await denied.close(); }
  });

  describe('streaming', () => {
    const streamer = (id: string, script: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>): ModelAdapter =>
      ({ id, maxCostMicros: 5, capabilities: { tools: true, structuredOutput: true }, async generate() { throw new Error('unused'); }, stream: script });
    const collect = async (source: AsyncIterable<ModelStreamEvent>) => { const events: ModelStreamEvent[] = []; for await (const event of source) events.push(event); return events; };

    it('fails over while nothing has been released, and serves the backup stream', async () => {
      const primary = streamer('primary', async function* () { throw new MayuraError('MODEL_FAILED', 'down'); });
      const backup = streamer('backup', async function* () { yield { type: 'output.delta', text: '{"r":' }; yield { type: 'response', response: final({ r: 1 }, 2) }; });
      const events = await collect(createModelRouter({ id: 'router.stream', routes: [primary, backup] }).stream!(request()));
      expect(events).toEqual([{ type: 'output.delta', text: '{"r":' }, { type: 'response', response: { type: 'final', output: { r: 1 }, usage: { costMicros: 5 + 2 }, continuation: { router: 'router.stream', route: 1 } } }]);
    });

    it('does not splice two answers: a failure after released text ends the call', async () => {
      const primary = streamer('primary', async function* () { yield { type: 'output.delta', text: 'partial' }; throw new MayuraError('MODEL_FAILED', 'lost'); });
      let backupCalled = false;
      const backup = streamer('backup', async function* () { backupCalled = true; yield { type: 'response', response: final('b') }; });
      await expect(collect(createModelRouter({ id: 'router.stream', routes: [primary, backup] }).stream!(request()))).rejects.toMatchObject({ code: 'MODEL_FAILED' });
      expect(backupCalled).toBe(false);
    });

    it('answers through generate on a route that cannot stream', async () => {
      const plain = adapter('plain', 5, () => final('p'));
      expect(await collect(createModelRouter({ id: 'router.stream', routes: [plain] }).stream!(request()))).toEqual([{ type: 'response', response: { type: 'final', output: 'p', usage: { costMicros: 1 }, continuation: { router: 'router.stream', route: 0 } } }]);
    });

    it('streams an agent reply through the runtime after a failover', async () => {
      const primary = streamer('primary', async function* () { throw new MayuraError('MODEL_FAILED', 'down'); });
      const text = JSON.stringify({ reply: 'Hello there, the router moved this answer to the backup.' });
      const backup = streamer('backup', async function* () { for (let index = 0; index < text.length; index += 6) yield { type: 'output.delta', text: text.slice(index, index + 6) };
        yield { type: 'response', response: final(JSON.parse(text), 1) }; });
      const agent = defineAgent({ id: 'routed', version: '1', instructions: 'x', input: any, output: any, tools: [],
        model: createModelRouter({ id: 'router.stream', routes: [primary, backup] }), stream: { field: ['reply'], guards: [], batch: { minChars: 8, maxChars: 16 } } });
      const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:router.stream'] }, limits: { maxCostMicros: 100 } });
      try {
        const handle = runtime.submit(agent, { input: 'hi' }); expect((await handle.result()).status).toBe('succeeded');
        const released: string[] = []; for await (const event of handle.observe()) if (event.type === 'output.delta') released.push(event.metadata['text'] as string);
        expect(released.join('')).toBe(JSON.parse(text).reply);
      } finally { await runtime.close(); }
    });
  });
});
