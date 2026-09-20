/** Stable public errors deliberately exclude raw adapter exceptions and rejected values. */
export type ErrorCode =
  | 'INVALID_CONFIG' | 'INVALID_INPUT' | 'INVALID_OUTPUT' | 'INVALID_JSON'
  | 'PERMISSION_DENIED' | 'BUDGET_EXCEEDED' | 'LIMIT_EXCEEDED'
  | 'CANCELLED' | 'TIMEOUT' | 'TOOL_FAILED' | 'MODEL_FAILED'
  | 'GUARD_BLOCKED' | 'GUARD_UNAVAILABLE' | 'OUTCOME_UNKNOWN'
  | 'UNSUPPORTED_PROFILE' | 'NOT_FOUND' | 'CONFLICT' | 'STORAGE_UNAVAILABLE';

export interface PublicError {
  readonly code: ErrorCode;
  readonly message: string;
}

/** A safe, stable boundary error. Never populate message with secrets or raw provider output. */
export class MayuraError extends Error {
  override readonly name = 'MayuraError';
  constructor(readonly code: ErrorCode, message: string) { super(message); }
  toJSON(): PublicError { return { code: this.code, message: this.message }; }
}

/** Adapter exceptions are untrusted: replace unknown messages rather than reflecting them. */
export function publicError(error: unknown, fallback: ErrorCode = 'TOOL_FAILED'): PublicError {
  return error instanceof MayuraError
    ? error.toJSON()
    : { code: fallback, message: 'The operation failed. Inspect authorized local diagnostics.' };
}

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MayuraError('INVALID_CONFIG', `${name} must be a positive safe integer.`);
  }
}
