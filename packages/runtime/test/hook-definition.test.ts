import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { MayuraError, type JsonValue, type ModelAdapter, type ModelRequest } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import { z } from 'zod';
import { defineHook, readHookDefinition, type HookContext, type HookDecision, type HookDefinition, type HookEvent, type HookMessageMedia, type HookOptions } from '../src/hooks.js';
import { agentAsTool, defineAgent } from '../src/index.js';
import * as publicRuntime from '../src/index.js';

const schema = z.string();
const model: ModelAdapter = { id: 'test-model', maxCostMicros: 0, capabilities: { tools: true, structuredOutput: true },
  generate: async () => ({ type: 'final', output: 'value', usage: { costMicros: 0 } }) };
const context: HookContext = { runId: 'run', rootId: 'run', agentId: 'agent', scope: { principalId: 'principal', projectId: 'project' },
  invocationId: 'invocation', hookId: 'policy', hookVersion: '1', step: null, attempt: 1, signal: new AbortController().signal };
function options(): HookOptions<'beforeExecution'> {
  return { id: 'policy', version: '1', stage: 'beforeExecution', tools: [], handler: () => ({ decision: 'continue' }) };
}
function tool(id = 'local-read', effects: 'none' | 'read' | 'write' | 'host' = 'read'): AnyTool {
  return defineTool({ id, version: '1', description: 'Test tool.', input: schema, output: schema,
    effects, capabilities: [], execute: value => value });
}
function agent(hooks?: readonly HookDefinition[]) {
  return defineAgent({ id: 'agent', version: '1', instructions: 'Test fixture.', model, input: schema, output: schema, tools: [],
    ...(hooks === undefined ? {} : { hooks }) });
}
function invalid(value: unknown): void {
  expect(() => defineHook(value as HookOptions<'beforeExecution'>)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
}

describe('opaque control hook definitions', () => {
  it('exports authoring, never private descriptor access, and installs no executor on the handle', () => {
    const handler = vi.fn<HookOptions<'beforeExecution'>['handler']>(() => ({ decision: 'continue' }));
    const original = { ...options(), handler }; const handle = defineHook(original); const captured = readHookDefinition(handle)!;
    expect(publicRuntime.defineHook).toBe(defineHook); expect('readHookDefinition' in publicRuntime).toBe(false);
    expect(handle).toEqual({ kind: 'mayura.control-hook', id: 'policy', version: '1', stage: 'beforeExecution' });
    expect(Object.isFrozen(handle)).toBe(true); expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.tools)).toBe(true); expect(Object.isFrozen(original)).toBe(false);
    expect(captured).toMatchObject({ timeoutMs: 5_000, maxActions: 4, maxResultBytes: 65_536 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('infers stage-specific event and context types', () => {
    const before = defineHook({ ...options(), handler: (event, ctx) => {
      expectTypeOf(event).toEqualTypeOf<HookEvent<'beforeExecution'>>(); expectTypeOf(event.input).toEqualTypeOf<JsonValue>();
      expectTypeOf(ctx).toEqualTypeOf<HookContext>(); return { decision: 'continue' };
    } });
    const call = defineHook({ ...options(), stage: 'beforeToolCall', handler: event => {
      expectTypeOf(event.phase).toEqualTypeOf<'proposal'>();
      return { decision: 'continue', actions: [{ toolId: 'local-read', input: event.proposal.input }] };
    } });
    const release = defineHook({ ...options(), stage: 'beforeOutputRelease', handler: event => {
      expectTypeOf(event.source).toEqualTypeOf<'agent' | 'tool'>(); return { decision: 'block' };
    } });
    expectTypeOf(before).toEqualTypeOf<HookDefinition<'beforeExecution'>>();
    expectTypeOf(call).toEqualTypeOf<HookDefinition<'beforeToolCall'>>();
    expectTypeOf(release).toEqualTypeOf<HookDefinition<'beforeOutputRelease'>>();
  });

  it('captures primary-model hooks with only the exact readonly request projection type', () => {
    const handle = defineHook({ ...options(), stage: 'beforeModelCall', handler: (event, ctx) => {
      expectTypeOf(event).toEqualTypeOf<HookEvent<'beforeModelCall'>>();
      expectTypeOf(event.purpose).toEqualTypeOf<'primary'>();
      expectTypeOf(event.modelId).toEqualTypeOf<string>();
      expectTypeOf(event.request).toEqualTypeOf<Readonly<Pick<ModelRequest, 'messages' | 'tools' | 'maxOutputTokens'>> & { readonly media?: readonly HookMessageMedia[] }>();
      expectTypeOf(ctx.step).toEqualTypeOf<number | null>();
      return { decision: 'continue' };
    } });
    expectTypeOf(handle).toEqualTypeOf<HookDefinition<'beforeModelCall'>>();
    expect(handle.stage).toBe('beforeModelCall'); expect(agent([handle]).hooks[0]).toBe(handle);
    expect(readHookDefinition(handle)?.stage).toBe('beforeModelCall');
  });

  it('captures callback and tool references without freezing or retaining mutable registries', async () => {
    const one = tool(); const registry = [one];
    const original = { ...options(), tools: registry, handler: vi.fn<HookOptions<'beforeExecution'>['handler']>(() => ({ decision: 'continue' })) };
    const selected = original.handler; const captured = readHookDefinition(defineHook(original))!;
    original.id = 'changed'; original.handler = vi.fn(() => ({ decision: 'block' })); registry.splice(0);
    expect(captured.id).toBe('policy'); expect(captured.tools).toEqual([one]); expect(captured.tools[0]).toBe(one);
    expect(Object.isFrozen(registry)).toBe(false);
    expect(await captured.handler({ stage: 'beforeExecution', input: 'value' }, context)).toEqual({ decision: 'continue' });
    expect(selected).toHaveBeenCalledOnce(); expect(original.handler).not.toHaveBeenCalled();
  });

  it('captures ordinary method functions without reading callback-owned bind metadata', async () => {
    class Policy {
      handler(this: { id: string }, _event: HookEvent<'beforeExecution'>, _context: HookContext): HookDecision {
        return this.id === 'policy' ? { decision: 'continue' } : { decision: 'block' };
      }
    }
    const callback = Policy.prototype.handler; const bind = vi.fn(() => { throw new Error('SECRET'); });
    Object.defineProperty(callback, 'bind', { get: bind });
    const captured = readHookDefinition(defineHook({ ...options(), handler: callback }))!;
    expect(await captured.handler({ stage: 'beforeExecution', input: null }, context)).toEqual({ decision: 'continue' });
    expect(bind).not.toHaveBeenCalled();
  });

  it('looks up identity without reflecting on fake or proxied handles', () => {
    const handle = defineHook(options()); const copied = { ...handle };
    const read = vi.fn(() => { throw new Error('SECRET'); }); const proxy = new Proxy(handle, { get: read, getOwnPropertyDescriptor: read });
    for (const value of [null, 1, copied, Object.create(handle), proxy]) expect(readHookDefinition(value)).toBeUndefined();
    expect(read).not.toHaveBeenCalled(); expect(readHookDefinition(handle)).toBeDefined();
  });

  it.each(['id', 'version', 'stage', 'tools', 'handler', 'timeoutMs', 'maxActions', 'maxResultBytes'])('rejects accessor %s without invoking it', name => {
    const supplied = options(); const read = vi.fn(() => { throw new Error('SECRET'); });
    Object.defineProperty(supplied, name, { enumerable: true, get: read }); invalid(supplied); expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { id: '' }, { id: 'bad id' }, { id: 'x'.repeat(129) }, { version: '' }, { stage: 'beforeUnknownCall' },
    { handler: null }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { maxActions: 0 }, { maxActions: 9 },
    { maxResultBytes: 0 }, { maxResultBytes: 1_048_577 }, { permissions: { allow: [] } }, { budget: {} }, { tools: undefined },
  ])('rejects invalid or unsupported options %j', change => { invalid({ ...options(), ...change }); });

  it('rejects nonplain and unknown/symbol/nonenumerable own configuration fields safely', () => {
    invalid(null); invalid(Object.assign(Object.create({}), options()));
    invalid({ ...options(), [Symbol('hidden')]: 1 });
    const hidden = options(); Object.defineProperty(hidden, 'secret', { value: 1 }); invalid(hidden);
    const proxy = new Proxy(options(), { ownKeys() { throw new MayuraError('INVALID_CONFIG', 'SECRET'); } });
    let failure: unknown; try { defineHook(proxy); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(failure)).not.toContain('SECRET');
  });

  it('accepts explicit maximum bounds and none/read effects', () => {
    const captured = readHookDefinition(defineHook({ ...options(), tools: [tool('pure', 'none'), tool()],
      timeoutMs: 30_000, maxActions: 8, maxResultBytes: 1_048_576 }))!;
    expect(captured.tools).toHaveLength(2); expect(captured.timeoutMs).toBe(30_000);
  });

  it.each(['write', 'host'] as const)('rejects %s effect tools at definition time', effects => { invalid({ ...options(), tools: [tool('unsafe', effects)] }); });
  it('rejects forged, proxied, duplicate and composition tools', () => {
    const registered = tool(); const composed = agentAsTool(agent(), { id: 'delegate', description: 'Test child.', permissions: { allow: [] } });
    for (const tools of [[{ ...registered }], [new Proxy(registered, {})], [registered, registered], [registered, tool()], [composed]]) invalid({ ...options(), tools });
  });

  it.each(['sparse', 'accessor', 'map', 'iterator', 'hidden-index'] as const)('rejects %s tool arrays without running custom access', mutation => {
    const tools: AnyTool[] = [tool()]; const callback = vi.fn(() => { throw new Error('SECRET'); });
    if (mutation === 'sparse') delete tools[0];
    if (mutation === 'accessor') Object.defineProperty(tools, '0', { get: callback });
    if (mutation === 'map') Object.defineProperty(tools, 'map', { value: callback });
    if (mutation === 'iterator') Object.defineProperty(tools, Symbol.iterator, { value: callback });
    if (mutation === 'hidden-index') Object.defineProperty(tools, '0', { enumerable: false });
    invalid({ ...options(), tools }); expect(callback).not.toHaveBeenCalled();
  });

  it('bounds registries to exactly 32 tools', () => {
    const tools = Array.from({ length: 32 }, (_, index) => tool(`tool-${index}`));
    expect(readHookDefinition(defineHook({ ...options(), tools }))!.tools).toHaveLength(32);
    invalid({ ...options(), tools: [...tools, tool('tool-32')] });
  });
});

describe('agent hook registration', () => {
  it('defaults to immutable empty hooks and preserves exact handles in registration order', () => {
    expect(agent().hooks).toEqual([]); expect(Object.isFrozen(agent().hooks)).toBe(true);
    const first = defineHook(options()); const second = defineHook({ ...options(), id: 'second', stage: 'beforeToolCall', handler: () => ({ decision: 'continue' }) });
    const supplied = [first, second]; const definition = agent(supplied); supplied.reverse();
    expect(definition.hooks).toEqual([first, second]); expect(definition.hooks[0]).toBe(first); expect(Object.isFrozen(definition.hooks)).toBe(true);
    expect(definition.tools).toEqual([]);
  });

  it('rejects duplicate identities and duplicate IDs across stages', () => {
    const first = defineHook(options()); const second = defineHook({ ...options(), stage: 'beforeToolCall', handler: () => ({ decision: 'continue' }) });
    for (const supplied of [[first, first], [first, second]]) expect(() => agent(supplied)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('rejects copied, proxied and reconstructed handles', () => {
    const first = defineHook(options());
    for (const fake of [{ ...first }, new Proxy(first, {}), Object.create(first) as HookDefinition]) {
      expect(() => agent([fake])).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it.each(['sparse', 'accessor', 'map', 'iterator'] as const)('rejects %s hook arrays without custom evaluation', mutation => {
    const hooks: HookDefinition[] = [defineHook(options())]; const callback = vi.fn(() => { throw new Error('SECRET'); });
    if (mutation === 'sparse') delete hooks[0];
    if (mutation === 'accessor') Object.defineProperty(hooks, '0', { get: callback });
    if (mutation === 'map') Object.defineProperty(hooks, 'map', { value: callback });
    if (mutation === 'iterator') Object.defineProperty(hooks, Symbol.iterator, { value: callback });
    expect(() => agent(hooks)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' })); expect(callback).not.toHaveBeenCalled();
  });

  it('caps an agent at 16 hooks', () => {
    const hooks = Array.from({ length: 17 }, (_, index) => defineHook({ ...options(), id: `hook-${index}` }));
    expect(agent(hooks.slice(0, 16)).hooks).toHaveLength(16);
    expect(() => agent(hooks)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('rejects an agent hooks accessor without executing it', () => {
    const configuration = { id: 'agent', version: '1', instructions: 'Test fixture.', model, input: schema, output: schema, tools: [] };
    const read = vi.fn(() => { throw new MayuraError('INVALID_CONFIG', 'SECRET'); });
    Object.defineProperty(configuration, 'hooks', { enumerable: true, get: read });
    expect(() => defineAgent(configuration)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(read).not.toHaveBeenCalled();
  });

  it('does not silently ignore inherited hook configuration', () => {
    const configuration = Object.assign(Object.create({ hooks: [defineHook(options())] }) as object,
      { id: 'agent', version: '1', instructions: 'Test fixture.', model, input: schema, output: schema, tools: [] });
    expect(() => defineAgent(configuration)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
