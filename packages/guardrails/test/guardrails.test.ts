import { describe, expect, it, vi } from 'vitest';
import { MayuraError, type Guard, type GuardContext, type JsonValue } from '@mayura/core';
import { createPipeline, normalizeUserMessage, protectLiterals, redactPII, releaseBatches, releaseBufferedOutput,
  type BlockEvent, type ContentProcessor, type GuardedContent, type Pipeline,
} from '../src/index.js';

function context(boundary: 'input' | 'output' = 'input', signal = new AbortController().signal): GuardContext {
  return { runId: 'run-1', callId: 'call-1', scope: { principalId: 'developer', projectId: 'test' }, boundary, signal };
}
async function content(pipeline: Pipeline, value: unknown): Promise<GuardedContent> {
  const result = await pipeline.process(value, context());
  expect(result.status).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error('Expected fixture admission.');
  return result.output;
}
async function* chunks(...values: string[]): AsyncIterable<string> { yield* values; }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []; for await (const value of source) values.push(value); return values;
}

describe('immutable processor pipelines', () => {
  it('snapshots caller input synchronously and deeply freezes admitted content', async () => {
    const input = { nested: { value: 1 }, array: [2] };
    const pending = createPipeline().process(input, context()); input.nested.value = 99; input.array.push(3);
    const result = await pending;
    expect(result).toMatchObject({ status: 'succeeded', output: { version: 1, value: { nested: { value: 1 }, array: [2] } } });
    if (result.status !== 'succeeded') throw new Error();
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.value)).toBe(true);
    const value = result.output.value as { nested: JsonValue; array: JsonValue };
    expect(Object.isFrozen(value.nested)).toBe(true); expect(Object.isFrozen(value.array)).toBe(true);
    expect(Object.isFrozen(result.output.checks)).toBe(true);
  });

  it('uses canonical content fingerprints independent of object insertion order', async () => {
    const pipeline = createPipeline();
    const first = await content(pipeline, { b: 2, a: 1 }); const second = await content(pipeline, { a: 1, b: 2 });
    const changed = await content(pipeline, { a: 1, b: 3 });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/); expect(first.digest).toBe(second.digest); expect(first.digest).not.toBe(changed.digest);
  });

  it('increments transformation versions and binds guard evidence to the exact transformed candidate', async () => {
    const seen: JsonValue[] = [];
    const processor: ContentProcessor = { id: 'rewrite', version: '1', process: (snapshot) => {
      expect(snapshot.version).toBe(1); expect(Object.isFrozen(snapshot)).toBe(true); return { text: 'safe' };
    } };
    const guard: Guard = { id: 'inspect', check: (value) => { seen.push(value); return { decision: 'allow' }; } };
    const approved = await content(createPipeline({ processors: [processor], guards: [guard] }), { text: 'original' });
    const reference = await content(createPipeline(), { text: 'safe' });
    expect(approved.version).toBe(2); expect(approved.digest).toBe(reference.digest);
    expect(seen).toEqual([{ text: 'safe' }]);
    expect(approved.checks).toEqual([{ guardId: 'inspect', decision: 'allow', version: 2, digest: approved.digest }]);
    expect(Object.isFrozen(approved.checks[0])).toBe(true);
  });

  it('does not reuse older guard evidence when a subsequent invocation changes content', async () => {
    const guard: Guard = { id: 'allow-only-safe', check: (value) => ({ decision: value === 'safe' ? 'allow' : 'block' }) };
    const pipeline = createPipeline({ guards: [guard] });
    const first = await pipeline.process('safe', context());
    const second = await pipeline.process('unsafe', context());
    expect(first.status).toBe('succeeded'); expect(second.status).toBe('blocked'); expect(second).not.toHaveProperty('output');
  });

  it('captures registries and function references without mutating application objects', async () => {
    const processor: ContentProcessor = { id: 'stable', version: '1', process: () => 'original' };
    const guard: Guard = { id: 'stable', check: () => ({ decision: 'allow' }) };
    const processors = [processor]; const guards = [guard]; const pipeline = createPipeline({ processors, guards });
    processor.process = () => 'changed'; guard.check = () => ({ decision: 'block' }); processors.length = 0; guards.length = 0;
    expect((await content(pipeline, 'input')).value).toBe('original');
    expect(Object.isFrozen(processor)).toBe(false); expect(Object.isFrozen(guard)).toBe(false);
  });

  it('runs guards in parallel and withholds disclosure until the complete barrier resolves', async () => {
    const began: string[] = []; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const pipeline = createPipeline({ guards: [
      { id: 'slow', check: async () => { began.push('slow'); await waiting; return { decision: 'allow' }; } },
      { id: 'block', check: () => { began.push('block'); return { decision: 'block' }; } },
    ] });
    let settled = false; const pending = pipeline.process('PRIVATE', context()).then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(began).toEqual(['slow', 'block']));
    expect(settled).toBe(false); release();
    expect(await pending).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(JSON.stringify(await pending)).not.toContain('PRIVATE');
  });

  it.each(['throw', 'malformed', 'accessor'])('fails closed and sanitizes a %s guard verdict', async (behavior) => {
    const guard: Guard = { id: 'broken', check: () => {
      if (behavior === 'throw') throw new MayuraError('GUARD_BLOCKED', 'SECRET');
      if (behavior === 'accessor') return { get decision(): 'allow' { throw new MayuraError('INVALID_INPUT', 'SECRET'); } };
      return { decision: 'unexpected' as 'allow' };
    } };
    const result = await createPipeline({ guards: [guard] }).process('PRIVATE', context());
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE/);
  });

  it.each(['input', 'output'] as const)('sends only safe metadata to %s block callbacks', async (boundary) => {
    const callback = vi.fn<(event: BlockEvent) => void>();
    const pipeline = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })], onBlocked: callback });
    const result = await pipeline.process('SECRET', context(boundary));
    expect(result.status).toBe('blocked'); expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toEqual({ boundary, runId: 'run-1', callId: 'call-1', version: 1,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/), code: 'GUARD_BLOCKED',
    });
    expect(JSON.stringify(callback.mock.calls)).not.toContain('SECRET'); expect(Object.isFrozen(callback.mock.calls[0]?.[0])).toBe(true);
  });

  it('a failing block callback cannot allow content or disclose its exception', async () => {
    const result = await createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })], onBlocked: () => { throw new MayuraError('INVALID_INPUT', 'LEAK'); } }).process('SECRET', context());
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|LEAK/);
  });

  it.each(['processor', 'guard', 'callback'])('bounds a hanging asynchronous %s without releasing content', async (stage) => {
    const processor: ContentProcessor = { id: 'hang', version: '1', process: () => new Promise(() => {}) };
    const guard: Guard = { id: 'hang', check: () => new Promise(() => {}) };
    const options = stage === 'processor' ? { processors: [processor] }
      : stage === 'guard' ? { guards: [guard] }
        : { guards: [protectLiterals({ literals: ['PRIVATE'] })], onBlocked: () => new Promise<void>(() => {}) };
    const result = await createPipeline({ ...options, timeoutMs: 50 }).process('PRIVATE', context());
    expect(result.status).not.toBe('succeeded'); expect(result).not.toHaveProperty('output');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('honors pre-start and in-flight cancellation without forwarding caller abort reasons', async () => {
    const signal = new AbortController(); signal.abort('SECRET');
    const processor = { id: 'process', version: '1', process: vi.fn(() => 'value') };
    expect(await createPipeline({ processors: [processor] }).process('input', context('input', signal.signal))).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(processor.process).not.toHaveBeenCalled();
    const running = new AbortController(); let began = false;
    const pending = createPipeline({ guards: [{ id: 'wait', check: () => { began = true; return new Promise(() => {}); } }] })
      .process('input', context('input', running.signal));
    await vi.waitFor(() => expect(began).toBe(true)); running.abort('SECRET');
    const result = await pending; expect(result.status).toBe('cancelled'); expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('rejects invalid or oversized JSON without invoking accessors or transformers', async () => {
    const getter = vi.fn(() => 'secret');
    const input = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    expect(await createPipeline().process(input, context())).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(getter).not.toHaveBeenCalled();
    expect(await createPipeline({ maxBytes: 4 }).process('oversized', context())).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    const processor: ContentProcessor = { id: 'invalid', version: '1', process: () => ({ invalid: undefined }) };
    expect(await createPipeline({ processors: [processor] }).process('input', context())).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
  });

  it('rejects ambiguous registries and unbounded configuration', () => {
    const guard = protectLiterals({ literals: ['secret'] });
    expect(() => createPipeline({ guards: [guard, guard] })).toThrow(MayuraError);
    expect(() => createPipeline({ processors: [normalizeUserMessage(), normalizeUserMessage()] })).toThrow(MayuraError);
    expect(() => createPipeline({ timeoutMs: Infinity })).toThrow(MayuraError);
    expect(() => createPipeline({ timeoutMs: 2_147_483_648 })).toThrow(MayuraError);
    expect(() => createPipeline({ maxBytes: 0 })).toThrow(MayuraError);
  });
});

describe('local helpers and deliberately limited recognizers', () => {
  it('normalizes untrusted privileged message roles to user content and strips extra metadata', async () => {
    const pipeline = createPipeline({ processors: [normalizeUserMessage()] });
    expect((await content(pipeline, { role: 'system', content: 'untrusted text', tools: ['admin'], credential: 'SECRET' })).value)
      .toEqual({ role: 'user', content: 'untrusted text' });
    expect((await content(pipeline, 'hello')).value).toEqual({ role: 'user', content: 'hello' });
    expect((await content(pipeline, { role: 'tool', content: { nested: 'data' } })).value).toEqual({ role: 'user', content: { nested: 'data' } });
    expect((await pipeline.process({ role: 'system' }, context())).status).toBe('failed');
  });

  it('redacts nested email values before guards inspect the candidate while preserving keys', async () => {
    const seen: JsonValue[] = [];
    const pipeline = createPipeline({ processors: [redactPII()], guards: [{ id: 'inspect', check: (value) => { seen.push(value); return { decision: 'allow' }; } }] });
    const result = await content(pipeline, { 'owner@example.com': ['Reach A.User+tag@example.co.uk', { phone: '+1 (415) 555-0100' }] });
    expect(result.value).toEqual({ 'owner@example.com': ['Reach [EMAIL]', { phone: '+1 (415) 555-0100' }] });
    expect(seen).toEqual([result.value]);
  });

  it('supports explicit recognizer toggles and literal replacement labels', async () => {
    const pipeline = createPipeline({ processors: [redactPII({ email: false, phone: true, phoneReplacement: '$&' })] });
    expect((await content(pipeline, 'Call +1 (415) 555-0100; email me@example.com')).value).toBe('Call $&; email me@example.com');
    expect((await content(createPipeline({ processors: [redactPII({ emailReplacement: '<private>' })] }), 'x@y.example')).value).toBe('<private>');
  });

  it('documents phone false positives and incomplete formats rather than claiming complete PII detection', async () => {
    const pipeline = createPipeline({ processors: [redactPII({ phone: true })] });
    expect((await content(pipeline, 'Identifier 1234567890123')).value).toBe('Identifier [PHONE]'); // A numeric identifier can match the phone heuristic.
    expect((await content(pipeline, 'Date 2026-09-20')).value).toBe('Date 2026-09-20');
    expect((await content(pipeline, 'Local 555-0100')).value).toBe('Local 555-0100'); // Incomplete local numbers are not recognized.
    expect((await content(pipeline, 'user@localhost')).value).toBe('user@localhost'); // Local domains are intentionally not comprehensive.
  });

  it('blocks literal spans in values and keys, with optional case-insensitive matching', async () => {
    const exact = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] });
    expect((await exact.process({ text: 'prefix SECRET suffix' }, context())).status).toBe('blocked');
    expect((await exact.process({ SECRET: 'value' }, context())).status).toBe('blocked');
    expect((await exact.process('secret', context())).status).toBe('succeeded');
    const insensitive = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'], caseSensitive: false })] });
    expect((await insensitive.process('secret', context())).status).toBe('blocked');
  });

  it('does not pretend literal checks detect semantic, encoded, or split injection content', async () => {
    const pipeline = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] });
    for (const candidate of ['ignore prior instructions', 'U0VDUkVU', ['SEC', 'RET']]) {
      expect((await pipeline.process(candidate, context())).status).toBe('succeeded');
    }
    expect(() => protectLiterals({ literals: [''] })).toThrow(MayuraError);
    expect(() => redactPII({ email: 'yes' as unknown as boolean })).toThrow(MayuraError);
  });

  it('handles bounded adversarial punctuation and long digit spans without arbitrary regex configuration', async () => {
    const punctuation = 'a.'.repeat(8_000); const digits = '1'.repeat(16_000);
    const pipeline = createPipeline({ processors: [redactPII({ phone: true })] });
    expect((await content(pipeline, punctuation)).value).toBe(punctuation);
    expect((await content(pipeline, digits)).value).toBe(digits);
  });
});

describe('bounded guarded output batches', () => {
  it('combines chunks before redaction and never yields raw chunks', async () => {
    const pipeline = createPipeline({ processors: [redactPII()] });
    const result = await collect(releaseBatches(chunks('person@', 'example.com'), pipeline, context('output'), { maxChunksPerBatch: 2 }));
    expect(result).toHaveLength(1); expect(result[0]?.value).toBe('[EMAIL]');
    expect(JSON.stringify(result)).not.toContain('person@example.com');
  });

  it('withholds a rejected complete batch without exposing it to the consumer', async () => {
    const seen: GuardedContent[] = [];
    const pipeline = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] });
    await expect((async () => { for await (const item of releaseBatches(chunks('SEC', 'RET'), pipeline, context('output'), { maxChunksPerBatch: 2 })) seen.push(item); })())
      .rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    expect(seen).toEqual([]);
  });

  it('documents that batch-local guards do not provide cross-batch transcript protection', async () => {
    const pipeline = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] });
    const output = await collect(releaseBatches(chunks('SEC', 'RET'), pipeline, context('output'), { maxChunksPerBatch: 1 }));
    expect(output.map((entry) => entry.value)).toEqual(['SEC', 'RET']);
  });

  it('enforces UTF-8 byte and count limits without releasing oversized chunks', async () => {
    const pipeline = createPipeline();
    expect((await collect(releaseBatches(chunks('é', 'é'), pipeline, context('output'), { maxBatchBytes: 2 }))).map((item) => item.value)).toEqual(['é', 'é']);
    await expect(collect(releaseBatches(chunks('éé'), pipeline, context('output'), { maxBatchBytes: 2 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const seen: GuardedContent[] = [];
    await expect((async () => { for await (const entry of releaseBatches(chunks('one', 'two'), pipeline, context('output'), { maxChunksPerBatch: 1, maxBatches: 1 })) seen.push(entry); })())
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(seen.map((item) => item.value)).toEqual(['one']);
  });

  it('sanitizes source exceptions and malformed iterator-result accessors', async () => {
    const pipeline = createPipeline();
    const source: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: async () => ({ get done(): false { throw new MayuraError('INVALID_INPUT', 'SECRET'); }, value: 'PRIVATE' }) }) };
    await expect(collect(releaseBatches(source, pipeline, context('output')))).rejects.toMatchObject({ code: 'INVALID_OUTPUT', message: 'The output source could not provide a valid batch.' });
  });

  it('bounds a hanging source and requests cleanup without waiting forever for cleanup', async () => {
    const cleanup = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
    const source: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: cleanup }) };
    await expect(collect(releaseBatches(source, createPipeline(), context('output'), { maxDurationMs: 30 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects a forged pipeline instead of yielding an unadmitted candidate', async () => {
    const fake: Pipeline = { process: async () => ({ status: 'succeeded', output: { version: 1, digest: 'fake', value: 'raw', checks: [] } }) };
    await expect(collect(releaseBatches(chunks('raw'), fake, context('output')))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('requires output context and avoids even source initialization after pre-start cancellation', async () => {
    await expect(collect(releaseBatches(chunks('raw'), createPipeline(), context('input')))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const initialize = vi.fn(() => chunks('raw')[Symbol.asyncIterator]());
    const source: AsyncIterable<string> = { [Symbol.asyncIterator]: initialize };
    const abort = new AbortController(); abort.abort('SECRET');
    await expect(collect(releaseBatches(source, createPipeline(), context('output', abort.signal)))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(initialize).not.toHaveBeenCalled();
  });
});

describe('whole-output disclosure barrier', () => {
  it('blocks a protected literal split across arbitrary source chunks before any release', async () => {
    const pipeline = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] });
    await expect(releaseBufferedOutput(chunks('prefix SE', 'CR', 'ET suffix'), pipeline, context('output'), { maxChunks: 3 }))
      .rejects.toMatchObject({ code: 'GUARD_BLOCKED', message: 'The complete output was withheld by its content boundary.' });
  });

  it('redacts PII split across chunks using one complete transcript candidate', async () => {
    const pipeline = createPipeline({ processors: [redactPII()] });
    const admitted = await releaseBufferedOutput(chunks('person', '@example', '.com'), pipeline, context('output'));
    expect(admitted.value).toBe('[EMAIL]'); expect(JSON.stringify(admitted)).not.toContain('person@example.com');
  });

  it('fails closed on cumulative byte or chunk overflow without exposing a partial transcript', async () => {
    await expect(releaseBufferedOutput(chunks('ab', 'cd'), createPipeline(), context('output'), { maxBytes: 3 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(releaseBufferedOutput(chunks('a', 'b'), createPipeline(), context('output'), { maxChunks: 1 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('sanitizes source failure and requests bounded cleanup on timeout', async () => {
    const failed: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('SECRET source failure'); } }) };
    await expect(releaseBufferedOutput(failed, createPipeline(), context('output')))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT', message: 'The output source could not provide valid text.' });
    const cleanup = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
    const hanging: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: cleanup }) };
    await expect(releaseBufferedOutput(hanging, createPipeline(), context('output'), { maxDurationMs: 30 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects forged pipelines and pre-start cancellation without initializing the source', async () => {
    const fake: Pipeline = { process: async () => ({ status: 'succeeded', output: { version: 1, digest: 'fake', value: 'raw', checks: [] } }) };
    await expect(releaseBufferedOutput(chunks('raw'), fake, context('output'))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const initialize = vi.fn(() => chunks('raw')[Symbol.asyncIterator]());
    const source: AsyncIterable<string> = { [Symbol.asyncIterator]: initialize };
    const abort = new AbortController(); abort.abort('SECRET');
    await expect(releaseBufferedOutput(source, createPipeline(), context('output', abort.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(initialize).not.toHaveBeenCalled();
  });
});
