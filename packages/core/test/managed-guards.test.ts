import { describe, expect, it, vi } from 'vitest';
import type { Guard, GuardContext, JsonValue, ModelRequest, ModelResponse, Schema } from '../src/index.js';
import { registerManagedGuardDefinition, readManagedGuardDefinition, type ManagedGuardDescriptor } from '../src/host.js';

const verdict = { decision: 'allow' as const, categories: [] as string[] };
const input: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'review', validate: value => ({ value: value as JsonValue }) } };
const output: ManagedGuardDescriptor['output'] = { '~standard': { version: 1, vendor: 'review', validate: () => ({ value: verdict }) } };
function options(): ManagedGuardDescriptor {
  return { kind: 'moderation', id: 'policy', version: '1', instructions: 'Review explicitly configured policy.',
    model: { id: 'moderator', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 3,
      generate: vi.fn(async () => ({ type: 'final', output: verdict, usage: { costMicros: 2 } } as const)) },
    input, output, egressGuards: [], limits: { timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 65_536, maxOutputTokens: 1_024 } };
}
const request: ModelRequest = { instructions: '', messages: [], tools: [], maxOutputTokens: 1, signal: new AbortController().signal };
const context: GuardContext = { runId: 'run', callId: 'call', scope: { principalId: 'principal', projectId: 'project' }, signal: request.signal, boundary: 'input' };

describe('managed guard trusted-host registry', () => {
  it('registers metadata-only frozen handles without invoking any configured callback', () => {
    const config = options(); const handle = registerManagedGuardDefinition(config);
    expect(handle).toEqual({ kind: 'mayura.managed-guard', id: 'policy', version: '1' });
    expect(Object.isFrozen(handle)).toBe(true); expect(config.model.generate).not.toHaveBeenCalled();
    expect(Object.keys(handle).sort()).toEqual(['id', 'kind', 'version']);
    expect(readManagedGuardDefinition(handle)).toMatchObject({ kind: 'moderation', id: 'policy' });
    expect(readManagedGuardDefinition(handle)).toBe(readManagedGuardDefinition(handle));
    expect(Object.isFrozen(config)).toBe(false); expect(Object.isFrozen(config.model)).toBe(false);
  });

  it('looks up registrations only, without reading untrusted identity properties', () => {
    const handle = registerManagedGuardDefinition(options()); let reads = 0;
    const hostile = new Proxy({}, { get() { reads++; throw new Error('SECRET'); }, getOwnPropertyDescriptor() { reads++; throw new Error('SECRET'); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const candidate of [undefined, null, 1, 'policy', {}, { ...handle }, Object.create(handle), new Proxy(handle, {}), JSON.parse(JSON.stringify(handle)), hostile, revoked.proxy]) {
      expect(readManagedGuardDefinition(candidate)).toBeUndefined();
    }
    expect(reads).toBe(0);
  });

  it('captures nested metadata and original receiver-bound callbacks without freezing caller objects', async () => {
    const model = { id: 'original', capabilities: { tools: false, structuredOutput: true }, maxCostMicros: 3, marker: 'model',
      async generate(this: { marker: string }): Promise<ModelResponse> { return { type: 'final', output: this.marker, usage: { costMicros: 2 } }; } };
    const standard = { version: 1 as const, vendor: 'original', marker: 'schema', validate(this: { marker: string }, value: unknown) { return { value: value as JsonValue }; } };
    const local = { id: 'original-guard', marker: 'guard', check(this: { marker: string }) { return { decision: this.marker === 'guard' ? 'allow' as const : 'block' as const }; } };
    const guards = [local]; const limits = { ...options().limits }; const config = { ...options(), model, input: { '~standard': standard }, egressGuards: guards, limits };
    const saved = readManagedGuardDefinition(registerManagedGuardDefinition(config))!;
    model.id = 'mutated'; model.capabilities.structuredOutput = false; model.maxCostMicros = 999;
    model.generate = async () => ({ type: 'final', output: 'replaced', usage: { costMicros: 999 } });
    standard.vendor = 'mutated'; standard.validate = () => ({ value: 'replaced' });
    local.id = 'mutated'; local.check = () => ({ decision: 'block' }); guards.length = 0; limits.timeoutMs = 1;
    expect(saved.model).toMatchObject({ id: 'original', maxCostMicros: 3, capabilities: { tools: false, structuredOutput: true } });
    expect(await saved.model.generate(request)).toMatchObject({ output: 'model' });
    expect(await saved.input['~standard'].validate('original')).toEqual({ value: 'original' });
    expect(await saved.egressGuards[0]!.check(null, context)).toEqual({ decision: 'allow' });
    expect(saved.limits.timeoutMs).toBe(10_000);
    for (const value of [saved, saved.model, saved.model.capabilities, saved.input, saved.input['~standard'], saved.output, saved.output['~standard'], saved.egressGuards, saved.egressGuards[0]!, saved.limits]) expect(Object.isFrozen(value)).toBe(true);
    for (const value of [model, model.capabilities, standard, local, guards, limits]) expect(Object.isFrozen(value)).toBe(false);
  });

  it('supports ordinary class-based adapter and guard methods without invoking getters', async () => {
    class Adapter {
      readonly id = 'class-model'; readonly capabilities = { tools: false, structuredOutput: true }; readonly maxCostMicros = 0;
      async generate(): Promise<ModelResponse> { return { type: 'final', output: this.id, usage: { costMicros: 0 } }; }
    }
    class Local implements Guard { readonly id = 'class-guard'; check() { return { decision: this.id === 'class-guard' ? 'allow' as const : 'block' as const }; } }
    const saved = readManagedGuardDefinition(registerManagedGuardDefinition({ ...options(), model: new Adapter(), egressGuards: [new Local()] }))!;
    expect(await saved.model.generate(request)).toMatchObject({ output: 'class-model' });
    expect(await saved.egressGuards[0]!.check(null, context)).toEqual({ decision: 'allow' });
  });

  it.each(['kind', 'id', 'version', 'model', 'instructions', 'input', 'output', 'egressGuards', 'limits'])('rejects descriptor accessor %s without executing it', key => {
    let reads = 0; const candidate = { ...options() };
    Object.defineProperty(candidate, key, { enumerable: true, get() { reads++; throw new Error('SECRET'); } });
    expect(() => registerManagedGuardDefinition(candidate)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' })); expect(reads).toBe(0);
  });

  it.each(['budget', 'permissions', 'scope', 'execute', 'context', 'unknown'])('rejects extra descriptor authority field %s', key => {
    expect(() => registerManagedGuardDefinition({ ...options(), [key]: {} } as ManagedGuardDescriptor)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('rejects malformed metadata, limits, models, schemas and managed egress handles', () => {
    const config = options(); const managed = registerManagedGuardDefinition(config);
    const invalid: unknown[] = [null, { ...config, kind: 'arbitrary' }, { ...config, id: 'bad id' }, { ...config, instructions: '' },
      { ...config, version: 'a'.repeat(129) }, { ...config, instructions: 'x'.repeat(16_385) },
      { ...config, model: { ...config.model, capabilities: { tools: false, structuredOutput: false } } },
      { ...config, model: { ...config.model, maxCostMicros: -1 } }, { ...config, model: { ...config.model, generate: 1 } },
      { ...config, input: {} }, { ...config, output: { '~standard': { version: 2, vendor: 'x', validate() {} } } },
      { ...config, egressGuards: [managed] }, { ...config, egressGuards: [{ ...managed, check: () => ({ decision: 'allow' }) }] },
      { ...config, egressGuards: [Object.assign(Object.create(managed), { check: () => ({ decision: 'allow' }) })] },
      { ...config, egressGuards: [{ id: 'duplicate', check() {} }, { id: 'duplicate', check() {} }] },
      { ...config, egressGuards: Array.from({ length: 33 }, (_, index) => ({ id: `guard-${index}`, check() {} })) },
      { ...config, limits: { ...config.limits, timeoutMs: 2_147_483_648 } }, { ...config, limits: { ...config.limits, maxOutputTokens: NaN } },
      { ...config, limits: { timeoutMs: 1 } }, { ...config, limits: { ...config.limits, extra: 1 } }];
    for (const value of invalid) expect(() => registerManagedGuardDefinition(value as ManagedGuardDescriptor)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('rejects nested callback accessors and hostile descriptor errors with no raw text', () => {
    let reads = 0; const config = options();
    const values = [
      { ...config, model: { ...config.model, get generate() { reads++; throw new Error('SECRET'); } } },
      { ...config, model: { ...config.model, capabilities: { tools: false, get structuredOutput() { reads++; return true; } } } },
      { ...config, input: { get '~standard'() { reads++; return input['~standard']; } } },
      { ...config, egressGuards: [{ id: 'local', get check() { reads++; throw new Error('SECRET'); } }] },
      new Proxy(config, { ownKeys() { throw new Error('SECRET'); } }),
    ];
    for (const value of values) {
      let error: unknown; try { registerManagedGuardDefinition(value as ManagedGuardDescriptor); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(error)).not.toContain('SECRET');
    }
    expect(reads).toBe(0);
  });

  it('permits independent same-ID registrations but never returns one handle for another', () => {
    const left = registerManagedGuardDefinition(options()); const right = registerManagedGuardDefinition(options());
    expect(left).not.toBe(right); expect(readManagedGuardDefinition(left)).not.toBe(readManagedGuardDefinition(right));
  });
});
