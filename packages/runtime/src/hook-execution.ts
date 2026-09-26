import { freezeJson, jsonValue, MayuraError, type JsonObject, type JsonValue, type Outcome } from '@mayura/core';
import type { AnyTool } from '@mayura/tools';
import type { HookContext, HookDescriptor, HookEvent } from './hooks.js';
import type { OperationPermits } from './permits.js';

type Failure = Exclude<Outcome<never>, { readonly status: 'succeeded' }>;
export type HookCompletion = 'continued' | 'blocked' | 'failed' | 'cancelled' | 'outcome_unknown';

/** All execution authority is supplied by the private owning-run closure, never by callback context. */
interface HookEvaluation {
  readonly descriptor: Readonly<HookDescriptor>;
  readonly event: HookEvent;
  readonly context: Omit<HookContext, 'signal'>;
  readonly signal: AbortSignal;
  readonly operations: OperationPermits;
  readonly assertActive: () => void;
  /** Recheck/increment all ancestor hook counters synchronously after acquiring the actual permit. */
  readonly onStarted: () => void;
  readonly onCompleted: (status: HookCompletion) => void;
  readonly preflight: (tool: AnyTool, input: JsonValue, signal: AbortSignal) => Promise<void>;
  readonly invoke: (tool: AnyTool, input: JsonValue, callId: string, signal: AbortSignal) => Promise<Outcome<JsonValue>>;
  readonly allocateCallId: (index: number) => string;
}

const errors = {
  CANCELLED: 'The required lifecycle hook was cancelled.',
  TIMEOUT: 'The required lifecycle hook exceeded its deadline.',
  BUDGET_EXCEEDED: 'The owning execution budget could not admit the hook action.',
  LIMIT_EXCEEDED: 'An owning execution limit prevented the required lifecycle hook.',
  PERMISSION_DENIED: 'A required hook action was not authorized.',
  GUARD_BLOCKED: 'A required lifecycle hook withheld this operation or output.',
  GUARD_UNAVAILABLE: 'A required lifecycle hook could not establish a valid decision.',
} as const;

/** Never invoke exception accessors/toJSON or disclose callback/schema-controlled text. */
function safeFailure(error: unknown): MayuraError {
  let code: keyof typeof errors = 'GUARD_UNAVAILABLE';
  try {
    const descriptor = error instanceof MayuraError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof value === 'string' && Object.hasOwn(errors, value)) code = value as keyof typeof errors;
  } catch { /* In-process exception proxies cannot control public diagnostics. */ }
  return new MayuraError(code, errors[code]);
}

/** A logical deadline; operation permits remain attached to the actual callback promise. */
class HookDeadline {
  readonly controller = new AbortController();
  readonly #end: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #relay: () => void;
  constructor(readonly parent: AbortSignal, timeoutMs: number) {
    this.#end = performance.now() + timeoutMs;
    this.#relay = () => {
      const reason = safeFailure(parent.reason);
      this.controller.abort(reason.code === 'TIMEOUT' ? reason : new MayuraError('CANCELLED', errors.CANCELLED));
    };
    parent.addEventListener('abort', this.#relay, { once: true });
    if (parent.aborted) this.#relay();
    this.#timer = setTimeout(() => this.controller.abort(new MayuraError('TIMEOUT', errors.TIMEOUT)), timeoutMs);
  }
  check(): void {
    if (!this.controller.signal.aborted && performance.now() >= this.#end) {
      this.controller.abort(new MayuraError('TIMEOUT', errors.TIMEOUT));
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
    this.controller.abort(new MayuraError('CANCELLED', errors.CANCELLED));
  }
}

function object(value: JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value;
}
function exact(record: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) throw new Error();
}

/** Whole-list identity/result admission precedes every schema callback and every action. */
function decisionFor(raw: unknown, descriptor: Readonly<HookDescriptor>): readonly { readonly tool: AnyTool; readonly input: JsonValue }[] {
  const value = object(freezeJson(jsonValue(raw, { maxBytes: descriptor.maxResultBytes })));
  if (value['decision'] === 'block') {
    exact(value, ['decision']);
    throw new MayuraError('GUARD_BLOCKED', errors.GUARD_BLOCKED);
  }
  exact(value, ['decision'], ['actions']);
  if (value['decision'] !== 'continue') throw new Error();
  const actions = value['actions'] ?? [];
  if (!Array.isArray(actions) || actions.length > descriptor.maxActions || (Object.hasOwn(value, 'actions') && value['actions'] === null)) throw new Error();
  const tools = new Map(descriptor.tools.map(tool => [tool.id, tool]));
  return actions.map(item => {
    const action = object(item); exact(action, ['toolId', 'input']);
    const toolId = action['toolId'];
    const tool = typeof toolId === 'string' ? tools.get(toolId) : undefined;
    if (!tool) throw new Error();
    return Object.freeze({ tool, input: action['input']! });
  });
}

/** Required control hooks return a truthful tool failure, including uncertain effects, without retry. */
export async function evaluateHook(options: HookEvaluation): Promise<Failure | undefined> {
  const deadline = new HookDeadline(options.signal, options.descriptor.timeoutMs);
  const signal = deadline.controller.signal;
  const active = (): void => { options.assertActive(); deadline.check(); };
  let started = false;
  let status: HookCompletion = 'failed';
  try {
    active();
    const context: HookContext = Object.freeze({ ...options.context, signal });
    const raw = await deadline.wait(() => options.operations.run(signal, async () => {
      active(); options.onStarted(); started = true;
      try { return await options.descriptor.handler(options.event, context); }
      catch { throw new MayuraError('GUARD_UNAVAILABLE', errors.GUARD_UNAVAILABLE); }
    }));
    active();
    const actions = decisionFor(raw, options.descriptor);
    for (const action of actions) {
      active(); await deadline.wait(() => options.preflight(action.tool, action.input, signal));
    }
    for (const [index, action] of actions.entries()) {
      active();
      // Do not race this against another generic timeout. The broker already observes this
      // signal and must be allowed to classify/preserve an uncertain dispatched action.
      const outcome = await options.invoke(action.tool, action.input, options.allocateCallId(index), signal);
      if (outcome.status !== 'succeeded') { status = outcome.status; return outcome; }
    }
    active(); status = 'continued'; return undefined;
  } catch (error) {
    const safe = safeFailure(error);
    status = safe.code === 'CANCELLED' ? 'cancelled'
      : ['GUARD_BLOCKED', 'GUARD_UNAVAILABLE', 'PERMISSION_DENIED', 'BUDGET_EXCEEDED'].includes(safe.code) ? 'blocked' : 'failed';
    return Object.freeze({ status, error: Object.freeze({ code: safe.code, message: safe.message }) });
  } finally {
    if (started) options.onCompleted(status);
    deadline.close();
  }
}

export type ObserverCompletion = 'continued' | 'failed' | 'cancelled';
interface ObserverEvaluation {
  readonly descriptor: Readonly<HookDescriptor>;
  readonly event: HookEvent;
  readonly context: Omit<HookContext, 'signal'>;
  readonly signal: AbortSignal;
  readonly operations: OperationPermits;
  /** Recheck/increment all ancestor hook counters synchronously after acquiring the actual permit. */
  readonly onStarted: () => void;
  readonly onCompleted: (status: ObserverCompletion) => void;
}

/** Observers take no actions; any thrown error, timeout or non-undefined result is a failure. Never throws. */
export async function evaluateObserver(options: ObserverEvaluation): Promise<ObserverCompletion> {
  const deadline = new HookDeadline(options.signal, options.descriptor.timeoutMs);
  const signal = deadline.controller.signal;
  let started = false;
  let status: ObserverCompletion = 'failed';
  try {
    deadline.check();
    const context: HookContext = Object.freeze({ ...options.context, signal });
    const raw = await deadline.wait(() => options.operations.run(signal, async () => {
      deadline.check(); options.onStarted(); started = true;
      try { return await options.descriptor.handler(options.event, context); }
      catch { throw new MayuraError('GUARD_UNAVAILABLE', errors.GUARD_UNAVAILABLE); }
    }));
    status = raw === undefined ? 'continued' : 'failed';
  } catch (error) {
    status = safeFailure(error).code === 'CANCELLED' ? 'cancelled' : 'failed';
  } finally {
    if (started) options.onCompleted(status);
    deadline.close();
  }
  return status;
}
