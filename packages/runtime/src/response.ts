import { isModelFailureReason, jsonValue, MayuraError, ModelInvocationError, modelFailureMessage, ModelProviderError, type JsonObject, type JsonValue, type ModelResponse } from '@mayura/core';
import { isIdentifier } from './agent.js';

const invalid = (): never => { throw new MayuraError('MODEL_FAILED', 'The model returned an invalid response envelope.'); };

/** Read only independently known failure usage; exception accessors/proxies cannot supply public text. */
export function modelFailureCost(error: unknown): number | undefined {
  try {
    const descriptor = error instanceof ModelInvocationError || error instanceof ModelProviderError ? Object.getOwnPropertyDescriptor(error, 'costMicros') : undefined;
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch { return undefined; }
}

const own = (error: object, key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(error, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; };
/**
 * The public error for a failed model call. A `ModelProviderError` names a reason, and the message is Mayura's own for
 * that reason; an adapter's own time limit reads as a timeout; anything else stays generic, since adapter text is not
 * trusted. `cancelled` says the run itself was cancelled, which is reported as such elsewhere.
 */
export function modelFailure(error: unknown, cancelled: boolean): MayuraError {
  try {
    if (error instanceof ModelProviderError) {
      const reason = own(error, 'reason'); const status = own(error, 'httpStatus');
      if (isModelFailureReason(reason) && (status === undefined || (typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599))) {
        return new MayuraError(reason === 'configuration' ? 'INVALID_CONFIG' : 'MODEL_FAILED', modelFailureMessage(reason, status as number | undefined));
      }
    } else if (!cancelled && error instanceof MayuraError && own(error, 'code') === 'CANCELLED') return new MayuraError('MODEL_FAILED', modelFailureMessage('timeout'));
  } catch { /* Hostile exception objects cannot control diagnostics. */ }
  return new MayuraError('MODEL_FAILED', 'The model adapter failed to produce a response.');
}

function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value;
}

function exactKeys(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}

/** Read known usage without traversing malformed output or invoking an adapter-owned getter. */
export function modelCost(value: unknown): number {
  try {
    if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'usage');
    if (!descriptor || !('value' in descriptor)) return invalid();
    const usage = object(jsonValue(descriptor.value, { maxBytes: 512, maxDepth: 2 }));
    exactKeys(usage, ['costMicros']);
    const amount = usage['costMicros'];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return invalid();
    return amount;
  } catch { return invalid(); }
}

/** Validate the complete envelope before disclosing output or dispatching any tool. */
export function modelResponse(value: unknown, maxBytes: number, maxCalls: number): ModelResponse {
  let response: JsonObject;
  try { response = object(jsonValue(value, { maxBytes })); } catch { return invalid(); }
  const usage = object(response['usage']);
  exactKeys(usage, ['costMicros']);
  if (!Number.isSafeInteger(usage['costMicros']) || typeof usage['costMicros'] !== 'number' || usage['costMicros'] < 0) invalid();
  const continuation = Object.hasOwn(response, 'continuation') ? { continuation: response['continuation']! } : {};
  const continuationKeys = Object.hasOwn(response, 'continuation') ? ['continuation'] : [];
  if (response['type'] === 'final') {
    exactKeys(response, ['type', 'output', 'usage', ...continuationKeys]);
    return { type: 'final', output: response['output']!, usage: { costMicros: usage['costMicros'] as number }, ...continuation };
  }
  if (response['type'] !== 'tool_calls') return invalid();
  exactKeys(response, ['type', 'calls', 'usage', ...continuationKeys]);
  const calls = response['calls'];
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > maxCalls) return invalid();
  const seen = new Set<string>();
  return {
    type: 'tool_calls',
    ...continuation,
    usage: { costMicros: usage['costMicros'] as number },
    calls: calls.map((entry) => {
      const call = object(entry);
      exactKeys(call, ['id', 'toolId', 'input']);
      if (!isIdentifier(call['id']) || !isIdentifier(call['toolId']) || seen.has(call['id'])) return invalid();
      seen.add(call['id']);
      return { id: call['id'], toolId: call['toolId'], input: call['input']! };
    }),
  };
}
