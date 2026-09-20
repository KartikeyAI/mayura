import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, MayuraError, ModelInvocationError, type GuardContext, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type Schema } from '@mayura/core';
import { createAuxiliaryCheck, createModerationGuard, createPipeline, detectAndTranslate, type AuxiliaryOptions, type ContentSnapshot, type LanguageDocument, type LanguageResult } from '../src/index.js';

const textSchema = z.string();
function context(signal = new AbortController().signal): GuardContext {
  return { runId: 'auxiliary-run', callId: 'auxiliary-call', scope: { principalId: 'person', projectId: 'project' }, boundary: 'input', signal };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject };
}
function final(output: JsonValue = 'safe', costMicros = 1): ModelResponse { return { type: 'final', output, usage: { costMicros } }; }
function model(generate: ModelAdapter['generate'] = async () => final(), maxCostMicros = 3, id = 'auxiliary'): ModelAdapter {
  return { id, maxCostMicros, capabilities: { tools: false, structuredOutput: true }, generate };
}
function options(overrides: Partial<AuxiliaryOptions<typeof textSchema, typeof textSchema>> = {}): AuxiliaryOptions<typeof textSchema, typeof textSchema> {
  return { id: 'check', version: '1', model: model(), instructions: 'Return a string.', input: textSchema, output: textSchema,
    budget: new Budget(20, 20), permissions: { allow: ['model:auxiliary'] }, ...overrides,
  };
}
function snapshot(value: unknown): ContentSnapshot { return { version: 1, digest: 'caller-digest-not-authority', value: value as JsonValue }; }

describe('metered auxiliary checks', () => {
  it('retains original/schema-transformed input, typed output and immutable scoped evidence', async () => {
    const generate = vi.fn(async (request: ModelRequest) => { expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]); return final({ result: 'yes' }, 2); });
    const check = createAuxiliaryCheck({ ...options(), model: model(generate), input: z.string().transform(value => value.toLowerCase()), output: z.object({ result: z.string().transform(value => value.toUpperCase()) }) });
    const outcome = await check.evaluate('HELLO', context());
    if (outcome.status !== 'succeeded') throw new Error('Expected success');
    expectTypeOf(outcome.output.output).toEqualTypeOf<{ result: string }>();
    expect(outcome.output).toMatchObject({ original: 'HELLO', input: 'hello', output: { result: 'YES' }, evidence: { checkId: 'check', checkVersion: '1', modelId: 'auxiliary', costMicros: 2, scope: context().scope } });
    expect(outcome.output.evidence.originalDigest).not.toBe(outcome.output.evidence.inputDigest);
    expect(outcome.output.evidence.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    for (const value of [check, outcome, outcome.output, outcome.output.output, outcome.output.evidence, outcome.output.evidence.scope]) expect(Object.isFrozen(value)).toBe(true);
    const request = generate.mock.calls[0]![0]; expect(request.tools).toEqual([]); expect(request.maxOutputTokens).toBe(1_024);
    expect(request).not.toHaveProperty('continuation'); expect(Object.isFrozen(request.messages)).toBe(true); expect(Object.isFrozen(request)).toBe(true);
  });

  it('snapshots input, model dispatch function, grants and limits before asynchronous work', async () => {
    const input = { nested: { text: 'original' } }; const grants = ['model:auxiliary']; const limits = { maxOutputTokens: 17 };
    const generate = vi.fn(async (request: ModelRequest) => { expect(request.messages[0]).toEqual({ role: 'user', content: { nested: { text: 'original' } } }); expect(request.maxOutputTokens).toBe(17); return final(); });
    const adapter = model(generate); const check = createAuxiliaryCheck({ ...options(), model: adapter, input: z.object({ nested: z.object({ text: z.string() }) }), permissions: { allow: grants }, limits });
    grants.length = 0; limits.maxOutputTokens = 999; Object.assign(adapter, { generate: () => { throw new Error('SECRET'); } });
    const pending = check.evaluate(input, context()); input.nested.text = 'mutated';
    expect((await pending).status).toBe('succeeded'); expect(generate).toHaveBeenCalledTimes(1);
  });

  it('requires genuine budgets and exact destination grants without default credit', async () => {
    const generate = vi.fn(async () => final()); const budget = new Budget(10, 10);
    const denied = createAuxiliaryCheck(options({ model: model(generate), budget, permissions: { allow: ['model:*'] } }));
    expect(await denied.evaluate('input', context())).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(generate).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
    const fake = Object.create(Budget.prototype) as Budget;
    expect(() => createAuxiliaryCheck(options({ budget: fake }))).toThrow(MayuraError);
    expect(() => createAuxiliaryCheck(options({ model: model(generate, NaN) }))).toThrow(MayuraError);
    expect(() => createAuxiliaryCheck(options({ limits: { timeoutMs: Infinity } }))).toThrow(MayuraError);
    expect(() => createAuxiliaryCheck(options({ limits: 1 as never }))).toThrow(MayuraError);
    expect(() => createAuxiliaryCheck(options({ limits: { maxOutputTokens: 0 } }))).toThrow(MayuraError);
  });

  it('charges a supplied child account and every ancestor exactly once', async () => {
    const root = new Budget(10, 10); const child = root.fork({ id: 'moderation', maxCostMicros: 3, maxCalls: 2 });
    expect((await createAuxiliaryCheck(options({ budget: child })).evaluate('input', context())).status).toBe('succeeded');
    for (const budget of [root, child]) expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('enforces shared parallel reservations and never starts the unaffordable check', async () => {
    const entered = deferred<void>(); const completion = deferred<ModelResponse>(); const generate = vi.fn(() => { entered.resolve(); return completion.promise; });
    const budget = new Budget(3, 10); const check = createAuxiliaryCheck(options({ model: model(generate), budget }));
    const first = check.evaluate('one', context()); await entered.promise;
    expect(await check.evaluate('two', context())).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(generate).toHaveBeenCalledTimes(1); expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
    completion.resolve(final('safe', 2)); expect((await first).status).toBe('succeeded');
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
  });

  it.each(['block', 'throw', 'changing-getter'] as const)('fails closed before paid egress on local guard %s', async mode => {
    const generate = vi.fn(async () => final()); const budget = new Budget(10, 10); let reads = 0;
    const check = createAuxiliaryCheck(options({ model: model(generate), budget, egressGuards: [{ id: 'local', check: () => {
      if (mode === 'throw') throw new MayuraError('GUARD_UNAVAILABLE', 'SECRET-GUARD');
      if (mode === 'changing-getter') return { get decision() { return ++reads === 1 ? 'block' as const : 'allow' as const; } };
      return { decision: 'block' };
    } }] }));
    const outcome = await check.evaluate('private-input', context()); expect(outcome.status).toBe('blocked');
    expect(JSON.stringify(outcome)).not.toContain('SECRET'); expect(generate).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
    if (mode === 'changing-getter') expect(reads).toBe(1);
  });

  it.each(['tools', 'continuation', 'extra', 'output-getter', 'oversize'] as const)('settles known cost before rejecting %s response content', async kind => {
    let getterCalls = 0;
    const raw: unknown = kind === 'tools' ? { type: 'tool_calls', calls: [{ id: 'call', toolId: 'private', input: {} }], usage: { costMicros: 2 } }
      : kind === 'continuation' ? { ...final('safe', 2), continuation: 'SECRET' }
      : kind === 'extra' ? { ...final('safe', 2), privateTrace: 'SECRET' }
      : kind === 'oversize' ? final('SECRET'.repeat(100), 2)
      : { type: 'final', usage: { costMicros: 2 }, get output() { getterCalls++; throw new Error('SECRET'); } };
    const budget = new Budget(10, 10);
    const outcome = await createAuxiliaryCheck(options({ budget, model: model(async () => raw as ModelResponse), limits: { maxOutputBytes: 256 } })).evaluate('input', context());
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 }); expect(getterCalls).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it('retains the whole reservation for invalid usage and untrusted provider exceptions', async () => {
    for (const response of [async () => ({ type: 'final', output: 'safe', usage: { costMicros: -1 } }) as ModelResponse,
      async () => { throw new MayuraError('PERMISSION_DENIED', 'SECRET-PROVIDER'); }]) {
      const budget = new Budget(10, 10); const outcome = await createAuxiliaryCheck(options({ budget, model: model(response) })).evaluate('input', context());
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
      expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 }); expect(JSON.stringify(outcome)).not.toContain('SECRET');
    }
  });

  it('accounts ModelInvocationError known cost while withholding its failed result', async () => {
    const budget = new Budget(10, 10);
    const outcome = await createAuxiliaryCheck(options({ budget, model: model(async () => { throw new ModelInvocationError(2); }) })).evaluate('input', context());
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
  });

  it('records full known overrun before malformed content and closes ledger admission', async () => {
    const budget = new Budget(10, 10);
    const check = createAuxiliaryCheck(options({ budget, model: model(async () => ({ ...final('SECRET', 4), extra: true }) as unknown as ModelResponse) }));
    expect(await check.evaluate('input', context())).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(budget.snapshot()).toEqual({ spentMicros: 4, reservedMicros: 0, calls: 1 });
    expect(() => budget.reserve(0)).toThrow(MayuraError);
  });

  it('preserves exact known aggregate overruns beyond the safe integer range', async () => {
    const budget = new Budget(0, 2); const both = deferred<void>(); const completion = deferred<ModelResponse>(); let entered = 0;
    const check = createAuxiliaryCheck(options({ budget, model: model(() => { if (++entered === 2) both.resolve(); return completion.promise; }, 0) }));
    const first = check.evaluate('one', context()); const second = check.evaluate('two', context());
    await both.promise; completion.resolve(final('safe', Number.MAX_SAFE_INTEGER));
    expect((await Promise.all([first, second])).map(outcome => outcome.status)).toEqual(['blocked', 'blocked']);
    expect(budget.snapshot()).toEqual({ spentMicros: '18014398509481982', reservedMicros: 0, calls: 2 });
  });

  it('rejects usage accessors without executing them or treating missing accounting as free', async () => {
    let reads = 0; const budget = new Budget(10, 10);
    const raw = { type: 'final' as const, output: 'safe', get usage(): { costMicros: number } { reads++; throw new MayuraError('MODEL_FAILED', 'SECRET-USAGE'); } };
    const outcome = await createAuxiliaryCheck(options({ budget, model: model(async () => raw) })).evaluate('input', context());
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } }); expect(reads).toBe(0);
    expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 }); expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it('validates schema output after accounting without exposing validator reasons', async () => {
    const budget = new Budget(10, 10);
    const outcome = await createAuxiliaryCheck({ ...options({ budget }), output: z.number('SECRET-VALIDATOR') }).evaluate('input', context());
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(budget.snapshot().spentMicros).toBe(1); expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });

  it('bounds complete requests before reservation, not just the submitted text', async () => {
    const budget = new Budget(10, 10); const generate = vi.fn(async () => final());
    const check = createAuxiliaryCheck(options({ budget, model: model(generate), instructions: 'x'.repeat(200), limits: { maxInputBytes: 256 } }));
    expect(await check.evaluate('input', context())).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(generate).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(0);
  });

  it('rejects cancellation before dispatch and bounds a hanging input validator without reserving', async () => {
    const budget = new Budget(10, 10); const generate = vi.fn(async () => final()); const controller = new AbortController(); controller.abort('SECRET');
    expect(await createAuxiliaryCheck(options({ budget, model: model(generate) })).evaluate('input', context(controller.signal))).toMatchObject({ status: 'cancelled' });
    const never: Schema<string> = { '~standard': { version: 1, vendor: 'test', validate: () => new Promise(() => {}) } };
    expect(await createAuxiliaryCheck({ ...options({ budget, model: model(generate), limits: { timeoutMs: 10 } }), input: never }).evaluate('input', context())).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
    expect(budget.snapshot().calls).toBe(0); expect(generate).not.toHaveBeenCalled();
  });

  it('bounds a hanging output validator after known cost settlement', async () => {
    const budget = new Budget(10, 10); const never: Schema<string> = { '~standard': { version: 1, vendor: 'test', validate: () => new Promise(() => {}) } };
    const outcome = await createAuxiliaryCheck({ ...options({ budget, limits: { timeoutMs: 15 } }), output: never }).evaluate('input', context());
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } }); expect(budget.snapshot().spentMicros).toBe(1);
  });

  it.each(['cancel', 'timeout', 'late-error'] as const)('accounts late known usage after %s without reopening disclosure', async interruption => {
    const entered = deferred<void>(); const completion = deferred<ModelResponse>(); const controller = new AbortController(); const budget = new Budget(10, 10);
    const validateOutput = vi.fn((value: unknown) => ({ value: value as string })); const output: Schema<string> = { '~standard': { version: 1, vendor: 'test', validate: validateOutput } };
    const check = createAuxiliaryCheck({ ...options({ budget, model: model(() => { entered.resolve(); return completion.promise; }), limits: { timeoutMs: interruption === 'timeout' ? 15 : 5_000 } }), output });
    const pending = check.evaluate('private-input', context(controller.signal)); await entered.promise;
    if (interruption !== 'timeout') controller.abort('SECRET');
    const outcome = await pending; const before = JSON.stringify(outcome);
    expect(outcome.status).toBe(interruption === 'timeout' ? 'failed' : 'cancelled'); expect(budget.snapshot().reservedMicros).toBe(3);
    if (interruption === 'late-error') completion.reject(new ModelInvocationError(2)); else completion.resolve(final('SECRET-LATE', 2));
    await nextTurn();
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 }); expect(validateOutput).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).toBe(before); expect(before).not.toContain('SECRET');
  });
});

describe('focused language and moderation helpers', () => {
  const document: LanguageDocument = { segments: [{ id: 'prose', kind: 'prose', text: 'Bonjour' }, { id: 'exact', kind: 'protected', text: 'SECRET const customerId = 7;' }] };
  function languageOptions(overrides: Partial<Parameters<typeof detectAndTranslate>[0]> = {}) {
    return { id: 'language', version: '1', budget: new Budget(10, 10), permissions: { allow: ['model:detect', 'model:translate'] }, targetLanguage: 'en',
      detectionModel: model(async () => final({ language: 'fr', confidence: 0.95 }), 1, 'detect'),
      translationModel: model(async () => final({ segments: [{ id: 'prose', text: 'Hello' }] }), 1, 'translate'), ...overrides,
    };
  }

  it('uses separate metered calls, excludes protected spans from both, and preserves a source map', async () => {
    const requests: ModelRequest[] = []; const budget = new Budget(10, 10);
    const processor = detectAndTranslate(languageOptions({ budget,
      detectionModel: model(async request => { requests.push(request); return final({ language: 'fr', confidence: 0.95 }); }, 1, 'detect'),
      translationModel: model(async request => { requests.push(request); return final({ segments: [{ id: 'prose', text: 'Hello' }] }); }, 1, 'translate'),
    }));
    const result = await processor.process(snapshot(document), context()) as LanguageResult;
    expect(result).toMatchObject({ status: 'translated', targetLanguage: 'en', original: document, segments: [
      { id: 'prose', originalText: 'Bonjour', text: 'Hello', translated: true }, { id: 'exact', text: 'SECRET const customerId = 7;', translated: false },
    ] });
    expect(result.evidence.map(item => item.modelId)).toEqual(['detect', 'translate']); expect(JSON.stringify(requests)).not.toContain('SECRET');
    expect(requests).toHaveLength(2); expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 2 });
    expect(Object.isFrozen(result.original)).toBe(true); expect(Object.isFrozen(result.segments)).toBe(true);
  });

  it('preserves low-confidence language without paying for a translation or inventing certainty', async () => {
    const translate = vi.fn(async () => final({ segments: [{ id: 'prose', text: 'not used' }] })); const budget = new Budget(10, 10);
    const processor = detectAndTranslate(languageOptions({ budget, detectionModel: model(async () => final({ language: 'und', confidence: 0.2 }), 1, 'detect'), translationModel: model(translate, 1, 'translate') }));
    const result = await processor.process(snapshot(document), context()) as LanguageResult;
    expect(result).toMatchObject({ status: 'preserved', reason: 'low_confidence', original: document });
    expect(result.segments.map(item => item.text)).toEqual(document.segments.map(item => item.text)); expect(result.evidence).toHaveLength(1);
    expect(translate).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(1);
  });

  it('does not implicitly classify strings, and keeps protected-only documents entirely local', async () => {
    const budget = new Budget(10, 10); const processor = detectAndTranslate(languageOptions({ budget }));
    await expect(processor.process(snapshot('unclassified text'), context())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const result = await processor.process(snapshot({ segments: [document.segments[1]!] }), context()) as LanguageResult;
    expect(result).toMatchObject({ status: 'preserved', reason: 'no_prose', evidence: [] }); expect(budget.snapshot().calls).toBe(0);
  });

  it('honors cancellation even when the language document would need no model call', async () => {
    const controller = new AbortController(); controller.abort('SECRET'); const budget = new Budget(10, 10);
    const processor = detectAndTranslate(languageOptions({ budget }));
    await expect(processor.process(snapshot({ segments: [document.segments[1]] }), context(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(budget.snapshot().calls).toBe(0);
  });

  it.each(['missing', 'extra', 'duplicate', 'reordered'] as const)('rejects %s translation segment maps after accounting', async kind => {
    const segments = kind === 'missing' ? [] : kind === 'extra' ? [{ id: 'prose', text: 'Hi' }, { id: 'second', text: 'Hi' }, { id: 'invented', text: 'Hi' }]
      : kind === 'duplicate' ? [{ id: 'prose', text: 'Hi' }, { id: 'prose', text: 'Hi' }] : [{ id: 'second', text: 'Hi' }, { id: 'prose', text: 'Hi' }];
    const budget = new Budget(10, 10); const processor = detectAndTranslate(languageOptions({ budget, translationModel: model(async () => final({ segments }), 1, 'translate') }));
    await expect(processor.process(snapshot({ segments: [document.segments[0], { id: 'second', kind: 'prose', text: 'Salut' }] }), context())).rejects.toBeInstanceOf(MayuraError);
    expect(budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 2 });
  });

  it('requires explicit permission for the translation destination and does not hide a fallback', async () => {
    const budget = new Budget(10, 10); const translate = vi.fn(async () => final());
    const processor = detectAndTranslate(languageOptions({ budget, permissions: { allow: ['model:detect'] }, translationModel: model(translate, 1, 'translate') }));
    await expect(processor.process(snapshot(document), context())).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    expect(translate).not.toHaveBeenCalled(); expect(budget.snapshot().calls).toBe(1);
  });

  it('provides typed moderation evidence but check returns only an immutable verdict', async () => {
    const budget = new Budget(10, 10); const guard = createModerationGuard({ ...options({ budget }), model: model(async () => final({ decision: 'block', categories: ['policy.test'] })) });
    const result = await guard.evaluate({ text: 'original' }, context()); expect(result).toMatchObject({ status: 'succeeded', output: { output: { decision: 'block', categories: ['policy.test'] } } });
    expect(await guard.check('original', context())).toEqual({ decision: 'block' }); expect(budget.snapshot().calls).toBe(2);
    expect((await createPipeline({ guards: [guard] }).process('original', context())).status).toBe('blocked');
  });

  it('never converts malformed/unavailable moderation into allow', async () => {
    for (const generate of [async () => final({ decision: 'yes', categories: [] }), async () => { throw new Error('SECRET-MODERATOR'); }]) {
      const guard = createModerationGuard({ ...options(), model: model(generate) });
      const result = await createPipeline({ guards: [guard] }).process('private-input', context());
      expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } }); expect(JSON.stringify(result)).not.toContain('SECRET');
    }
  });

  it('charges parallel moderation guards to the same hard cap', async () => {
    const budget = new Budget(1, 10); const generate = vi.fn(async () => final({ decision: 'allow', categories: [] }));
    const guards = ['first', 'second'].map(id => createModerationGuard({ ...options({ budget }), id, model: model(generate, 1) }));
    const result = await createPipeline({ guards }).process('private-input', context());
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(generate).toHaveBeenCalledTimes(1); expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });
});
