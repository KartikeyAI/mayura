import { MayuraError, assertPositiveInteger, type LifecycleControl } from '@mayura/core';
import { evaluateLifecycleControl, lifecycleHookTimeout } from '@mayura/core/host';

const MAX_TIMEOUT_MS = 86_400_000;

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'An AbortSignal is required.');
}

function cancelled(): MayuraError {
  return new MayuraError('CANCELLED', 'The operation was cancelled.');
}

/** A child signal with an explicit deadline and a mandatory cleanup handle. */
export interface DeadlineSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function deadlineSignal(parent: AbortSignal, timeoutMs: number): DeadlineSignal {
  assertSignal(parent);
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > MAX_TIMEOUT_MS) throw new MayuraError('INVALID_CONFIG', 'timeoutMs exceeds the helper limit.');
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let disposed = false;
  return Object.freeze({
    signal: controller.signal,
    dispose(): void {
      if (disposed) return;
      disposed = true; clearTimeout(timer); parent.removeEventListener('abort', abort);
    },
  });
}

/** Withholds late output after cancellation or a logical deadline; cooperative work receives the child signal. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  assertSignal(parent);
  if (parent.aborted) throw cancelled();
  const deadline = deadlineSignal(parent, timeoutMs);
  let abort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = (): void => { reject(parent.aborted ? cancelled() : new MayuraError('TIMEOUT', 'The operation deadline expired.')); };
      deadline.signal.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([Promise.resolve().then(() => operation(deadline.signal)), interrupted]);
  } finally {
    if (abort !== undefined) deadline.signal.removeEventListener('abort', abort);
    deadline.dispose();
  }
}

/** Cancellation-aware delay. No timer or listener survives settlement. */
export async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  assertSignal(signal);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMEOUT_MS) {
    throw new MayuraError('INVALID_CONFIG', 'Delay must be a bounded non-negative integer.');
  }
  if (signal.aborted) throw cancelled();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export interface RetryOptions {
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs?: number;
  readonly backoffFactor?: number;
  /** More than one attempt is rejected unless the caller makes this effect guarantee. */
  readonly safety: 'single-attempt' | 'idempotent' | 'read-only';
  readonly retryable?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  /**
   * Fail-closed lifecycle hook after a retryable failure and before the backoff delay. `continue` permits the next
   * attempt; `block` stops and rethrows the original error; a failed or timed-out hook stops with GUARD_UNAVAILABLE.
   */
  readonly onRetry?: LifecycleControl<RetryEvent, 'onRetry'>;
  /** Deadline for `onRetry` in milliseconds (default 5000, maximum 30000). */
  readonly onRetryTimeoutMs?: number;
}
/** Metadata-only retry view. The error is reduced to a stable code. */
export interface RetryEvent {
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly delayMs: number;
  readonly error: { readonly code: string };
}

/** Bounded retry that requires an explicit no-duplicate-effect guarantee. */
export async function retry<T>(operation: (attempt: number, signal: AbortSignal) => T | Promise<T>, options: RetryOptions): Promise<T> {
  assertSignal(options.signal); assertPositiveInteger(options.maxAttempts, 'maxAttempts');
  if (options.maxAttempts > 10) throw new MayuraError('LIMIT_EXCEEDED', 'Retry attempt limit was exceeded.');
  if (options.maxAttempts > 1 && options.safety === 'single-attempt') {
    throw new MayuraError('PERMISSION_DENIED', 'Retries require an idempotent or read-only operation guarantee.');
  }
  const initial = options.initialDelayMs; const maximum = options.maxDelayMs ?? initial;
  const factor = options.backoffFactor ?? 2;
  if (!Number.isSafeInteger(initial) || initial < 0 || !Number.isSafeInteger(maximum) || maximum < initial
    || maximum > 300_000 || !Number.isFinite(factor) || factor < 1 || factor > 10) {
    throw new MayuraError('INVALID_CONFIG', 'Retry delays and backoff must satisfy bounded limits.');
  }
  const onRetry = options.onRetry;
  if (onRetry !== undefined && typeof onRetry !== 'function') throw new MayuraError('INVALID_CONFIG', 'onRetry must be a function.');
  const hookTimeout = lifecycleHookTimeout(options.onRetryTimeoutMs);
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (options.signal.aborted) throw cancelled();
    try { return await operation(attempt, options.signal); }
    catch (error) {
      if (options.signal.aborted) throw cancelled();
      const allowed = attempt < options.maxAttempts && (options.retryable === undefined || await options.retryable(error, attempt));
      if (!allowed) throw error;
      const wait = Math.min(maximum, Math.floor(initial * factor ** (attempt - 1)));
      if (onRetry) {
        let code = 'UNKNOWN';
        try { if (error instanceof MayuraError) { const field = Object.getOwnPropertyDescriptor(error, 'code'); if (field && 'value' in field && typeof field.value === 'string') code = field.value; } }
        catch { /* Exception proxies cannot shape the hook view. */ }
        try { await evaluateLifecycleControl({ stage: 'onRetry', handler: onRetry, timeoutMs: hookTimeout, signal: options.signal,
          event: { attempt, nextAttempt: attempt + 1, delayMs: wait, error: { code } } }); }
        catch (hookError) {
          if (options.signal.aborted) throw cancelled();
          if (hookError instanceof MayuraError && hookError.code === 'GUARD_BLOCKED') throw error;
          throw new MayuraError('GUARD_UNAVAILABLE', 'The retry hook could not complete; no further attempt was made.');
        }
      }
      await delay(wait, options.signal);
    }
  }
  throw new MayuraError('TOOL_FAILED', 'Retry control reached an invalid state.');
}

/** Runs cleanup exactly once. A cleanup failure never conceals an earlier operation failure. */
export async function withCleanup<R, T>(
  acquire: () => R | Promise<R>,
  use: (resource: R) => T | Promise<T>,
  release: (resource: R) => void | Promise<void>,
): Promise<T> {
  const resource = await acquire();
  let failed = false;
  try { return await use(resource); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await release(resource); }
    catch (cleanupError) {
      if (!failed) throw cleanupError;
    }
  }
}

export interface PollOptions {
  readonly signal: AbortSignal;
  readonly maxAttempts: number;
  readonly intervalMs: number;
}

/** Converts bounded polling into a cancellation-aware value wait. */
export async function pollUntil<T>(
  read: (attempt: number, signal: AbortSignal) => T | Promise<T>,
  accept: (value: T) => boolean | Promise<boolean>,
  options: PollOptions,
): Promise<T> {
  assertSignal(options.signal); assertPositiveInteger(options.maxAttempts, 'maxAttempts');
  if (options.maxAttempts > 10_000) throw new MayuraError('LIMIT_EXCEEDED', 'Polling attempt limit was exceeded.');
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0 || options.intervalMs > 300_000) {
    throw new MayuraError('INVALID_CONFIG', 'Polling interval must satisfy bounded limits.');
  }
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (options.signal.aborted) throw cancelled();
    const value = await read(attempt, options.signal);
    if (await accept(value)) return value;
    if (attempt < options.maxAttempts) await delay(options.intervalMs, options.signal);
  }
  throw new MayuraError('TIMEOUT', 'Polling completed without observing the required state.');
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface PaginationOptions {
  readonly signal: AbortSignal;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly initialCursor?: string;
}

const CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~:/+=-]{0,1023}$/u;

/** Collects finite cursor pagination while rejecting cursor cycles and oversized results. */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Page<T> | Promise<Page<T>>,
  options: PaginationOptions,
): Promise<readonly T[]> {
  assertSignal(options.signal); assertPositiveInteger(options.maxPages, 'maxPages'); assertPositiveInteger(options.maxItems, 'maxItems');
  if (options.maxPages > 10_000 || options.maxItems > 1_000_000) throw new MayuraError('LIMIT_EXCEEDED', 'Pagination limits were exceeded.');
  if (options.initialCursor !== undefined && !CURSOR.test(options.initialCursor)) throw new MayuraError('INVALID_CONFIG', 'Pagination cursor is invalid.');
  let cursor = options.initialCursor; const seen = new Set<string>(); const result: T[] = [];
  for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber++) {
    if (options.signal.aborted) throw cancelled();
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new MayuraError('CONFLICT', 'Pagination cursor cycle was detected.');
      seen.add(cursor);
    }
    const page = await fetchPage(cursor, options.signal); let items: readonly T[]; let nextCursor: unknown;
    try {
      if (!page || typeof page !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(page))) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(page); const keys = Reflect.ownKeys(fields);
      if (keys.some(key => key !== 'items' && key !== 'nextCursor') || !fields['items'] || !('value' in fields['items'])
        || (fields['nextCursor'] !== undefined && !('value' in fields['nextCursor']))) throw new Error();
      items = fields['items'].value as readonly T[]; nextCursor = fields['nextCursor']?.value;
    } catch { throw new MayuraError('INVALID_OUTPUT', 'Pagination returned an invalid page.'); }
    if (!Array.isArray(items) || items.length > options.maxItems - result.length) {
      throw new MayuraError('LIMIT_EXCEEDED', 'Pagination result exceeded its item limit.');
    }
    result.push(...items);
    if (nextCursor === undefined) return Object.freeze(result);
    if (typeof nextCursor !== 'string' || !CURSOR.test(nextCursor)) throw new MayuraError('INVALID_OUTPUT', 'Pagination returned an invalid cursor.');
    cursor = nextCursor;
  }
  throw new MayuraError('LIMIT_EXCEEDED', 'Pagination exceeded its page limit.');
}
