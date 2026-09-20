import { describe, expect, it, vi } from 'vitest';
import { readManagedGuardDefinition } from '@mayura/core/host';
import { validate, type ManagedGuardDefinition, type ModelAdapter, type ModelResponse } from '@mayura/core';
import { defineModerationGuard, type ManagedModerationOptions } from '../src/index.js';

function options(): ManagedModerationOptions {
  const model: ModelAdapter = { id: 'moderator', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 1,
    generate: vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 0 } })) };
  return { id: 'policy', version: '1', model, instructions: 'Apply the explicit policy.', egressGuards: [] };
}

describe('managed moderation authoring definition', () => {
  it('exposes an opaque metadata handle, explicit local screening, fixed schemas and bounded defaults', async () => {
    const config = options(); const handle: ManagedGuardDefinition = defineModerationGuard(config); const saved = readManagedGuardDefinition(handle)!;
    expect(handle).toEqual({ kind: 'mayura.managed-guard', id: 'policy', version: '1' });
    expect(handle).not.toHaveProperty('check'); expect(handle).not.toHaveProperty('evaluate'); expect(handle).not.toHaveProperty('model');
    expect(saved.limits).toEqual({ timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 65_536, maxOutputTokens: 1_024 });
    expect(saved.egressGuards).toEqual([]); expect(config.model.generate).not.toHaveBeenCalled();
    expect(await validate(saved.input, { nested: ['unchanged'] }, 'input')).toEqual({ nested: ['unchanged'] });
    expect(await validate(saved.output, { decision: 'allow', categories: [] }, 'output')).toEqual({ decision: 'allow', categories: [] });
  });

  it('requires an explicit egressGuards list and rejects malformed optional limits', () => {
    const config = options(); const { egressGuards: _omitted, ...missing } = config;
    for (const value of [missing, { ...config, egressGuards: undefined }, { ...config, egressGuards: null },
      { ...config, limits: undefined }, { ...config, limits: { timeoutMs: 0 } }, { ...config, limits: { extra: 1 } }]) {
      expect(() => defineModerationGuard(value as ManagedModerationOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it.each(['input', 'output', 'budget', 'permissions', 'scope', 'runtime', 'execute', 'credentials', 'gateway'])('rejects caller-supplied %s override', key => {
    expect(() => defineModerationGuard({ ...options(), [key]: {} } as ManagedModerationOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('snapshots overrides and screening arrays without mutation or executing callbacks', () => {
    const local = { id: 'local', check: vi.fn(() => ({ decision: 'allow' as const })) };
    const guards = [local]; const limits = { timeoutMs: 500, maxInputBytes: 1_024 };
    const config = { ...options(), egressGuards: guards, limits }; const saved = readManagedGuardDefinition(defineModerationGuard(config))!;
    guards.length = 0; limits.timeoutMs = 999;
    expect(saved.egressGuards).toHaveLength(1); expect(saved.limits.timeoutMs).toBe(500); expect(saved.limits.maxInputBytes).toBe(1_024);
    expect(saved.limits.maxOutputBytes).toBe(65_536); expect(local.check).not.toHaveBeenCalled();
    expect(Object.isFrozen(guards)).toBe(false); expect(Object.isFrozen(limits)).toBe(false);
  });

  it.each(['id', 'version', 'model', 'instructions', 'egressGuards', 'limits'])('rejects authoring accessor %s without reading it', key => {
    let reads = 0; const config = { ...options() };
    Object.defineProperty(config, key, { enumerable: true, get() { reads++; throw new Error('SECRET'); } });
    expect(() => defineModerationGuard(config)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' })); expect(reads).toBe(0);
  });

  it('rejects accessor indices and custom iterators without invoking them', () => {
    let reads = 0; const array: unknown[] = [];
    Object.defineProperty(array, '0', { enumerable: true, get() { reads++; return { id: 'local', check() {} }; } });
    const iterated = [{ id: 'local', check() { return { decision: 'allow' as const }; } }];
    Object.defineProperty(iterated, Symbol.iterator, { value: () => { reads++; throw new Error('SECRET'); } });
    for (const value of [array, iterated]) expect(() => defineModerationGuard({ ...options(), egressGuards: value } as ManagedModerationOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(reads).toBe(0);
  });

  it('rejects managed guards in local egress slots before any model invocation', () => {
    const config = options(); const handle = defineModerationGuard(config);
    for (const value of [handle, { ...handle }, new Proxy(handle, {}), { ...handle, check: vi.fn() }]) {
      expect(() => defineModerationGuard({ ...config, egressGuards: [value] } as unknown as ManagedModerationOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(config.model.generate).not.toHaveBeenCalled();
  });

  it.each([
    { decision: 'maybe', categories: [] }, { decision: 'allow' }, { decision: 'block', categories: [], reason: 'SECRET' },
    { decision: 'allow', categories: ['unsafe text'] }, { decision: 'allow', categories: ['UPPER'] },
    { decision: 'allow', categories: ['duplicate', 'duplicate'] }, { decision: 'allow', categories: ['a'.repeat(65)] },
    { decision: 'allow', categories: Array.from({ length: 33 }, (_, index) => `category-${index}`) },
    { decision: 'allow', categories: [1] }, { decision: 'allow', categories: 'category' },
  ])('rejects malformed moderation output %# without coercion or extra content', async value => {
    const saved = readManagedGuardDefinition(defineModerationGuard(options()))!;
    await expect(validate(saved.output, value, 'output')).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('accepts exact category boundaries and returns a deeply immutable verdict', async () => {
    const saved = readManagedGuardDefinition(defineModerationGuard(options()))!;
    const value = { decision: 'block', categories: ['a'.repeat(64), ...Array.from({ length: 31 }, (_, index) => `category-${index}`)] };
    const admitted = await validate(saved.output, value, 'output');
    expect(admitted).toEqual(value); expect(Object.isFrozen(admitted)).toBe(true); expect(Object.isFrozen(admitted.categories)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false); expect(Object.isFrozen(value.categories)).toBe(false);
  });

  it('uses the configured identity-input byte bound rather than an unrelated schema default', async () => {
    const saved = readManagedGuardDefinition(defineModerationGuard({ ...options(), limits: { maxInputBytes: 2_097_152 } }))!;
    const value = 'x'.repeat(1_048_577);
    expect(await validate(saved.input, value, 'input', { maxBytes: 2_097_152 })).toBe(value);
  });

  it('never invokes verdict getters and keeps schema issues free of original text', async () => {
    const saved = readManagedGuardDefinition(defineModerationGuard(options()))!; let reads = 0;
    const value = { get decision() { reads++; return 'allow'; }, categories: [] };
    await expect(validate(saved.output, value, 'output')).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    const result = await saved.output['~standard'].validate({ decision: 'SECRET', categories: [] });
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(reads).toBe(0);
  });
});
