import { MayuraError } from './errors.js';

/** The named lifecycle points of the framework plan (§8.2). Each is served where that lifecycle actually happens. */
export type LifecycleStage =
  | 'beforeExecution' | 'afterExecution' | 'beforeStep' | 'afterStep'
  | 'beforeModelCall' | 'afterModelCall' | 'beforeToolCall' | 'afterToolCall'
  | 'beforeDelegate' | 'afterDelegate' | 'beforeContextBuild' | 'afterContextBuild'
  | 'beforeMemoryWrite' | 'afterMemoryWrite' | 'beforeOutputRelease'
  | 'onWait' | 'onResume' | 'onApprovalRequested' | 'onApprovalResolved'
  | 'onViolation' | 'onBlocked' | 'onRetry' | 'onError' | 'onCancel' | 'onFinally';

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = Object.freeze([
  'beforeExecution', 'afterExecution', 'beforeStep', 'afterStep', 'beforeModelCall', 'afterModelCall',
  'beforeToolCall', 'afterToolCall', 'beforeDelegate', 'afterDelegate', 'beforeContextBuild', 'afterContextBuild',
  'beforeMemoryWrite', 'afterMemoryWrite', 'beforeOutputRelease', 'onWait', 'onResume', 'onApprovalRequested',
  'onApprovalResolved', 'onViolation', 'onBlocked', 'onRetry', 'onError', 'onCancel', 'onFinally',
] as const);

/** A control callback's complete result. Anything else fails closed. */
export type LifecycleDecision = { readonly decision: 'continue' } | { readonly decision: 'block' };

/** Correlation only: the stage and a deadline signal, never authority or storage access. */
export interface LifecycleHookContext<S extends LifecycleStage = LifecycleStage> {
  readonly stage: S;
  readonly signal: AbortSignal;
}

export type LifecycleControl<E, S extends LifecycleStage = LifecycleStage> =
  (event: E, context: LifecycleHookContext<S>) => LifecycleDecision | Promise<LifecycleDecision>;
export type LifecycleObserver<E, S extends LifecycleStage = LifecycleStage> =
  (event: E, context: LifecycleHookContext<S>) => void | Promise<void>;

const messages = {
  GUARD_BLOCKED: 'A lifecycle hook withheld this operation.',
  GUARD_UNAVAILABLE: 'A required lifecycle hook could not complete.',
  TIMEOUT: 'A lifecycle hook exceeded its deadline.',
  CANCELLED: 'The lifecycle hook was cancelled.',
} as const;

/** Bounded per-hook deadline in milliseconds (default 5,000; maximum 30,000). */
export function lifecycleHookTimeout(value: unknown, fallback = 5_000): number {
  const timeout = value === undefined ? fallback : value;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new MayuraError('INVALID_CONFIG', 'Lifecycle hook timeouts must be integers from 1 to 30000 milliseconds.');
  }
  return timeout;
}

/** Recursively freeze a plain view the evaluator constructed itself; caller objects are never passed through. */
export function frozenView<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) frozenView((value as Record<string, unknown>)[key]);
  }
  return value;
}

async function evaluate(stage: LifecycleStage, handler: (event: unknown, context: LifecycleHookContext) => unknown, event: unknown,
  timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
  if (signal?.aborted) throw new MayuraError('CANCELLED', messages.CANCELLED);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let relay: (() => void) | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new MayuraError('TIMEOUT', messages.TIMEOUT)); }, timeoutMs);
      relay = () => { controller.abort(); reject(new MayuraError('CANCELLED', messages.CANCELLED)); };
      signal?.addEventListener('abort', relay, { once: true });
      const context: LifecycleHookContext = Object.freeze({ stage, signal: controller.signal });
      Promise.resolve().then(() => handler(event, context))
        .then(resolve, () => reject(new MayuraError('GUARD_UNAVAILABLE', messages.GUARD_UNAVAILABLE)));
    });
  } finally {
    clearTimeout(timer);
    if (relay) signal?.removeEventListener('abort', relay);
    // A settled or abandoned callback keeps no live deadline signal.
    controller.abort();
  }
}

/** Only an own data property with an exact value counts; accessors and extra fields fail closed. */
function decisionOf(value: unknown): 'continue' | 'block' {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    const field = fields['decision'];
    if (keys.length !== 1 || !field || !('value' in field)) throw new Error();
    if (field.value === 'continue' || field.value === 'block') return field.value;
  } catch { /* Result proxies cannot shape diagnostics. */ }
  throw new MayuraError('GUARD_UNAVAILABLE', messages.GUARD_UNAVAILABLE);
}

/** Await a fail-closed control callback. Resolves only on an exact `continue`; `block` throws `GUARD_BLOCKED`. */
export async function evaluateLifecycleControl<E, S extends LifecycleStage>(options: {
  readonly stage: S; readonly handler: LifecycleControl<E, S>; readonly event: E; readonly timeoutMs: number; readonly signal?: AbortSignal;
}): Promise<void> {
  const raw = await evaluate(options.stage, options.handler as (event: unknown, context: LifecycleHookContext) => unknown,
    frozenView(options.event), options.timeoutMs, options.signal);
  if (decisionOf(raw) === 'block') throw new MayuraError('GUARD_BLOCKED', messages.GUARD_BLOCKED);
}

/** Await an observer callback. Any thrown error, timeout or non-`undefined` result rejects with a safe code. */
export async function evaluateLifecycleObserver<E, S extends LifecycleStage>(options: {
  readonly stage: S; readonly handler: LifecycleObserver<E, S>; readonly event: E; readonly timeoutMs: number; readonly signal?: AbortSignal;
}): Promise<void> {
  const raw = await evaluate(options.stage, options.handler as (event: unknown, context: LifecycleHookContext) => unknown,
    frozenView(options.event), options.timeoutMs, options.signal);
  if (raw !== undefined) throw new MayuraError('GUARD_UNAVAILABLE', messages.GUARD_UNAVAILABLE);
}

/**
 * Snapshot a plain hook-options object once: own data properties only, each named handler callable when present,
 * and a bounded `timeoutMs`. Accessors, extra keys and exotic prototypes fail with `INVALID_CONFIG`.
 */
export function snapshotHookOptions<K extends string>(value: unknown, names: readonly K[], message: string):
  { readonly handlers: Partial<Record<K, (...args: never[]) => unknown>>; readonly timeoutMs: number } {
  if (value === undefined) return { handlers: {}, timeoutMs: 5_000 };
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !([...names, 'timeoutMs'] as string[]).includes(key))) throw new Error();
    const read = (key: string): unknown => { const field = fields[key]; if (!field) return undefined; if (!('value' in field)) throw new Error(); return field.value; };
    const handlers: Partial<Record<K, (...args: never[]) => unknown>> = {};
    for (const name of names) {
      const handler = read(name);
      if (handler === undefined) continue;
      if (typeof handler !== 'function') throw new Error();
      handlers[name] = handler as (...args: never[]) => unknown;
    }
    return { handlers: Object.freeze(handlers), timeoutMs: lifecycleHookTimeout(read('timeoutMs')) };
  } catch { throw new MayuraError('INVALID_CONFIG', message); }
}
