import {
  freezeJson, jsonValue, MayuraError, validate,
  type GuardContext, type JsonObject, type JsonValue, type ModelRequest, type Reservation,
} from '@mayura/core';
import type { ManagedGuardDescriptor } from '@mayura/core/host';
import { OperationPermits } from './permits.js';
import { modelCost, modelFailureCost } from './response.js';

interface ManagedGuardEvaluation {
  readonly descriptor: Readonly<ManagedGuardDescriptor>;
  readonly candidate: JsonValue;
  readonly context: GuardContext;
  readonly limits: {
    readonly maxInputBytes: number; readonly maxOutputBytes: number;
    readonly maxContextBytes: number; readonly maxOutputTokens: number;
  };
  readonly operations: OperationPermits;
  /** Private owning-run checks and exact model ticket; never derived from public context fields. */
  readonly assertActive: () => void;
  readonly start: () => Reservation;
  readonly onStarted: () => void;
  readonly onCompleted: (decision: 'allow' | 'block') => void;
}

const messages = {
  CANCELLED: 'The managed guard evaluation was cancelled.',
  TIMEOUT: 'The managed guard evaluation exceeded its deadline.',
  BUDGET_EXCEEDED: 'The owning execution budget could not admit or settle the managed check.',
  PERMISSION_DENIED: 'The managed guard model destination was not authorized.',
  GUARD_BLOCKED: 'A required managed guard withheld this content.',
  GUARD_UNAVAILABLE: 'A required managed guard could not establish a valid verdict.',
} as const;

/** Adapter/schema exceptions may imitate framework errors, but never supply public messages. */
function safeFailure(error: unknown): MayuraError {
  let code: keyof typeof messages = 'GUARD_UNAVAILABLE';
  try {
    const descriptor = error instanceof MayuraError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof value === 'string' && Object.hasOwn(messages, value)) code = value as keyof typeof messages;
  } catch { /* Exception getters/proxies do not control public diagnostics. */ }
  return new MayuraError(code, messages[code]);
}

/** Logical deadline only: actual callback promises retain their separately acquired permits. */
class GuardDeadline {
  readonly controller = new AbortController();
  readonly #end: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #relay: () => void;
  constructor(readonly parent: AbortSignal, timeoutMs: number) {
    this.#end = performance.now() + timeoutMs;
    this.#relay = () => {
      const reason = safeFailure(parent.reason);
      this.controller.abort(reason.code === 'TIMEOUT' ? reason : new MayuraError('CANCELLED', messages.CANCELLED));
    };
    parent.addEventListener('abort', this.#relay, { once: true });
    if (parent.aborted) this.#relay();
    this.#timer = setTimeout(() => this.controller.abort(new MayuraError('TIMEOUT', messages.TIMEOUT)), timeoutMs);
  }
  check(): void {
    if (!this.controller.signal.aborted && performance.now() >= this.#end) {
      this.controller.abort(new MayuraError('TIMEOUT', messages.TIMEOUT));
    }
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }
  async wait<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    const signal = this.controller.signal;
    return await new Promise<T>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', abort);
      const abort = (): void => { cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { this.check(); return operation(); })
        .then(value => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  }
  close(): void {
    clearTimeout(this.#timer); this.parent.removeEventListener('abort', this.#relay);
    this.controller.abort(new MayuraError('CANCELLED', messages.CANCELLED));
  }
}

/** Canonical equality permits key reordering, never content/schema transformations. */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

function object(value: JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value;
}
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error();
}
function verdict(value: JsonValue): 'allow' | 'block' {
  const record = object(value); exact(record, ['decision', 'categories']);
  const decision = record['decision']; const categories = record['categories'];
  if ((decision !== 'allow' && decision !== 'block') || !Array.isArray(categories) || categories.length > 32
    || categories.some(category => typeof category !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(category))
    || new Set(categories).size !== categories.length) throw new Error();
  return decision;
}
function localDecision(value: unknown): 'allow' | 'block' {
  if (!value || typeof value !== 'object') throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'decision');
  if (!descriptor || !('value' in descriptor) || (descriptor.value !== 'allow' && descriptor.value !== 'block')) throw new Error();
  return descriptor.value as 'allow' | 'block';
}

/**
 * Runtime-private, non-recursive moderation. The caller owns registration, grants, kind counters
 * and exact single-use ticket binding. This module never mints an account or exports a gateway.
 */
export async function evaluateManagedGuard(options: ManagedGuardEvaluation): Promise<void> {
  const { descriptor, operations } = options;
  const deadline = new GuardDeadline(options.context.signal, descriptor.limits.timeoutMs);
  const signal = deadline.controller.signal;
  const active = (): void => { options.assertActive(); deadline.check(); };
  const maxInputBytes = Math.min(descriptor.limits.maxInputBytes, options.limits.maxInputBytes, options.limits.maxContextBytes);
  const maxOutputBytes = Math.min(descriptor.limits.maxOutputBytes, options.limits.maxOutputBytes);
  const context: GuardContext = Object.freeze({ runId: options.context.runId, callId: options.context.callId,
    scope: Object.freeze({ principalId: options.context.scope.principalId, projectId: options.context.scope.projectId }),
    boundary: options.context.boundary, signal,
  });
  // Each trusted callback acquires independently. No guard/schema permit is held while
  // acquiring a model permit, including a one-permit parent/child operation ledger.
  const local = <T>(callback: () => T | PromiseLike<T>): Promise<T> => deadline.wait(() => operations.run(signal, async () => {
    active(); return await callback();
  }));
  try {
    active();
    const candidate = freezeJson(jsonValue(options.candidate, { maxBytes: maxInputBytes }));
    const identity = canonical(candidate);
    const input = freezeJson(jsonValue(await local(() => validate(descriptor.input, candidate, 'input', { maxBytes: maxInputBytes })), { maxBytes: maxInputBytes }));
    if (canonical(input) !== identity) throw new Error();
    const screened = await Promise.all(descriptor.egressGuards.map(check => local(async () => localDecision(await check.check(input, context)))));
    if (screened.includes('block')) throw new MayuraError('GUARD_BLOCKED', messages.GUARD_BLOCKED);
    active();
    const data = freezeJson(jsonValue({ instructions: descriptor.instructions, messages: [{ role: 'user', content: input }],
      tools: [], maxOutputTokens: Math.min(descriptor.limits.maxOutputTokens, options.limits.maxOutputTokens),
    }, { maxBytes: maxInputBytes }));
    const request: ModelRequest = Object.freeze({ ...data as unknown as Omit<ModelRequest, 'signal'>, signal });
    const response = await deadline.wait(() => operations.run(signal, async () => {
      active();
      const reservation = options.start();
      options.onStarted();
      let raw: unknown;
      try { raw = await descriptor.model.generate(request); }
      catch (error) {
        const cost = modelFailureCost(error);
        if (cost !== undefined) reservation.settle(cost);
        throw new MayuraError('GUARD_UNAVAILABLE', messages.GUARD_UNAVAILABLE);
      }
      const cost = modelCost(raw);
      // Accounting survives logical timeout/cancellation and even another call's overrun.
      // Do not put an active-authority check before this independently known settlement.
      reservation.settle(cost);
      return { raw, cost };
    }));
    active();
    const envelope = object(jsonValue(response.raw, { maxBytes: maxOutputBytes }));
    exact(envelope, ['type', 'output', 'usage']);
    if (envelope['type'] !== 'final' || modelCost(envelope) !== response.cost) throw new Error();
    const rawOutput = freezeJson(envelope['output']!);
    const decision = verdict(rawOutput);
    const output = freezeJson(jsonValue(await local(() => validate(descriptor.output, rawOutput, 'output', { maxBytes: maxOutputBytes })), { maxBytes: maxOutputBytes }));
    if (verdict(output) !== decision || canonical(output) !== canonical(rawOutput)) throw new Error();
    active(); options.onCompleted(decision);
    if (decision === 'block') throw new MayuraError('GUARD_BLOCKED', messages.GUARD_BLOCKED);
  } catch (error) { throw safeFailure(error); }
  finally { deadline.close(); }
}
