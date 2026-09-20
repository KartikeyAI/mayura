import { assertPositiveInteger, freezeJson, jsonValue, MayuraError, type Guard, type GuardContext, type JsonValue, type Outcome, type PublicError } from '@mayura/core';

export interface ContentSnapshot { readonly version: number; readonly digest: string; readonly value: JsonValue }
export interface GuardEvidence { readonly guardId: string; readonly version: number; readonly digest: string; readonly decision: 'allow' }
export interface GuardedContent extends ContentSnapshot { readonly checks: readonly GuardEvidence[] }
export interface ContentProcessor {
  readonly id: string;
  readonly version: string;
  process(snapshot: ContentSnapshot, context: GuardContext): unknown | Promise<unknown>;
}
export interface BlockEvent {
  readonly boundary: 'input' | 'output';
  readonly runId: string;
  readonly callId: string;
  readonly version: number;
  readonly digest: string;
  readonly code: 'GUARD_BLOCKED' | 'GUARD_UNAVAILABLE';
}
export interface PipelineOptions {
  readonly processors?: readonly ContentProcessor[];
  readonly guards?: readonly Guard[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly onBlocked?: (event: BlockEvent) => void | Promise<void>;
}
export interface Pipeline { process(value: unknown, context: GuardContext): Promise<Outcome<GuardedContent>> }
const pipelines = new WeakSet<object>();

export function assertPipeline(pipeline: Pipeline): void {
  if (!pipelines.has(pipeline)) throw new MayuraError('INVALID_CONFIG', 'Use createPipeline to construct the required content boundary.');
}

export function boundedText(value: unknown, name: string, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new MayuraError('INVALID_CONFIG', `${name} must be a bounded nonempty string.`);
}

/** Cooperative async deadline; it is not an operating-system execution boundary. */
export class Deadline {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly relay: () => void;
  private failure = new MayuraError('CANCELLED', 'The content operation was cancelled.');
  constructor(private readonly external: AbortSignal, timeoutMs: number) {
    this.relay = () => this.controller.abort();
    external.addEventListener('abort', this.relay, { once: true });
    if (external.aborted) this.relay();
    this.timer = setTimeout(() => {
      if (!this.controller.signal.aborted) {
        this.failure = new MayuraError('TIMEOUT', 'The content operation exceeded its deadline.');
        this.controller.abort();
        this.external.removeEventListener('abort', this.relay);
      }
    }, timeoutMs);
  }
  async run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted) throw this.failure;
    return await new Promise<T>((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener('abort', abort); };
      const abort = (): void => { cleanup(); reject(this.failure); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { if (signal.aborted) throw this.failure; return operation(); })
        .then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  }
  close(): void {
    clearTimeout(this.timer);
    this.external.removeEventListener('abort', this.relay);
    this.controller.abort();
  }
}

export function snapshotContext(context: GuardContext, signal: AbortSignal = context.signal): GuardContext {
  if (!(context.signal instanceof AbortSignal) || !['input', 'output'].includes(context.boundary)) throw new MayuraError('INVALID_CONFIG', 'A valid boundary and cancellation signal are required.');
  boundedText(context.runId, 'runId'); boundedText(context.callId, 'callId');
  boundedText(context.scope?.principalId, 'principalId'); boundedText(context.scope?.projectId, 'projectId');
  return Object.freeze({ runId: context.runId, callId: context.callId, boundary: context.boundary,
    scope: Object.freeze({ principalId: context.scope.principalId, projectId: context.scope.projectId }), signal,
  });
}

/** A deterministic JSON representation independent of application object insertion order. */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

async function snapshot(value: unknown, version: number, maxBytes: number): Promise<ContentSnapshot> {
  let copy: JsonValue;
  try { copy = freezeJson(jsonValue(value, { maxBytes })); }
  catch { throw new MayuraError('INVALID_INPUT', 'Content must satisfy the plain-JSON and size limits.'); }
  const bytes = new TextEncoder().encode(`mayura:guarded-content:v1\0${canonical(copy)}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ version, digest, value: copy });
}

function failed(error: unknown): Outcome<never> {
  const safe: PublicError = error instanceof MayuraError ? error.toJSON()
    : { code: 'GUARD_UNAVAILABLE', message: 'The content boundary could not establish a safe result.' };
  const status = safe.code === 'CANCELLED' ? 'cancelled' : safe.code === 'GUARD_BLOCKED' || safe.code === 'GUARD_UNAVAILABLE' ? 'blocked' : 'failed';
  return Object.freeze({ status, error: Object.freeze(safe) });
}

/** Ordered transforms followed by a required parallel guard barrier over one immutable candidate. */
export function createPipeline(options: PipelineOptions = {}): Pipeline {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  assertPositiveInteger(timeoutMs, 'timeoutMs'); assertPositiveInteger(maxBytes, 'maxBytes');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'The deadline exceeds the supported timer range.');
  if (!Array.isArray(options.processors ?? []) || !Array.isArray(options.guards ?? []) || (options.processors?.length ?? 0) > 32 || (options.guards?.length ?? 0) > 32) {
    throw new MayuraError('INVALID_CONFIG', 'A pipeline supports at most 32 processors and 32 guards.');
  }
  const processorIds = new Set<string>();
  const processors = Object.freeze((options.processors ?? []).map((processor) => {
    boundedText(processor.id, 'processor.id', 128); boundedText(processor.version, 'processor.version', 128);
    if (processorIds.has(processor.id) || typeof processor.process !== 'function') throw new MayuraError('INVALID_CONFIG', 'Processor identifiers must be unique and processors callable.');
    processorIds.add(processor.id);
    return Object.freeze({ id: processor.id, version: processor.version, process: processor.process.bind(processor) });
  }));
  const guardIds = new Set<string>();
  const guards = Object.freeze((options.guards ?? []).map((guard) => {
    boundedText(guard.id, 'guard.id', 128);
    if (guardIds.has(guard.id) || typeof guard.check !== 'function') throw new MayuraError('INVALID_CONFIG', 'Guard identifiers must be unique and guards callable.');
    guardIds.add(guard.id); return Object.freeze({ id: guard.id, check: guard.check.bind(guard) });
  }));
  const onBlocked = options.onBlocked;
  if (onBlocked !== undefined && typeof onBlocked !== 'function') throw new MayuraError('INVALID_CONFIG', 'onBlocked must be a function.');

  const pipeline: Pipeline = Object.freeze({
    async process(value: unknown, supplied: GuardContext): Promise<Outcome<GuardedContent>> {
      let deadline: Deadline | undefined;
      let candidate: ContentSnapshot | undefined;
      let context: GuardContext | undefined;
      try {
        context = snapshotContext(supplied);
        deadline = new Deadline(context.signal, timeoutMs);
        context = snapshotContext(context, deadline.controller.signal);
        let initial: JsonValue;
        try { initial = freezeJson(jsonValue(value, { maxBytes })); }
        catch { throw new MayuraError('INVALID_INPUT', 'Content must satisfy the plain-JSON and size limits.'); }
        let currentCandidate: ContentSnapshot = await deadline.run(() => snapshot(initial, 1, maxBytes));
        candidate = currentCandidate;
        for (const processor of processors) {
          const current: ContentSnapshot = currentCandidate;
          const transformed: unknown = await deadline.run(async (): Promise<unknown> => {
            try { return await processor.process(current, context!); }
            catch { throw new MayuraError('INVALID_INPUT', 'A content processor could not produce a valid candidate.'); }
          });
          let copy: JsonValue;
          try { copy = freezeJson(jsonValue(transformed, { maxBytes })); }
          catch { throw new MayuraError('INVALID_INPUT', 'Processed content must satisfy the plain-JSON and size limits.'); }
          currentCandidate = await deadline.run(() => snapshot(copy, current.version + 1, maxBytes));
          candidate = currentCandidate;
        }
        const admitted = currentCandidate;
        const decisions = await deadline.run(() => Promise.all(guards.map(async (guard) => {
          try {
            const verdict = await guard.check(admitted.value, context!);
            const decision = verdict?.decision;
            if (decision !== 'allow' && decision !== 'block') throw new Error();
            return decision;
          } catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A required content guard could not establish a verdict.'); }
        })));
        if (decisions.some((decision) => decision === 'block')) throw new MayuraError('GUARD_BLOCKED', 'A required content guard withheld this candidate.');
        const checks = Object.freeze(guards.map((guard): GuardEvidence => Object.freeze({ guardId: guard.id, version: admitted.version, digest: admitted.digest, decision: 'allow' })));
        return Object.freeze({ status: 'succeeded' as const, output: Object.freeze({ ...admitted, checks }) });
      } catch (error) {
        if (onBlocked && context && candidate && error instanceof MayuraError && (error.code === 'GUARD_BLOCKED' || error.code === 'GUARD_UNAVAILABLE')) {
          const event: BlockEvent = Object.freeze({ runId: context.runId, callId: context.callId, boundary: context.boundary,
            version: candidate.version, digest: candidate.digest, code: error.code,
          });
          try { await deadline!.run(() => onBlocked(event)); }
          catch { return failed(new MayuraError('GUARD_UNAVAILABLE', 'The blocked-content callback did not complete; content remains withheld.')); }
        }
        return failed(error);
      } finally { deadline?.close(); }
    },
  });
  pipelines.add(pipeline);
  return pipeline;
}
