import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import {
  executionCompletion, executionWaitCommand, executionWaitSnapshot, StorageError,
  type ExecutionRef, type ExecutionWaitMethod, type ExecutionWaitSnapshot, type ExecutionWaitStore,
} from '@mayura/storage-contracts';

const SINGLE_BYTES = 65_536;
const DRAIN_BYTES = 3 * 1_048_576;
const EVENT_BYTES = 1_048_576;
function invalidResponse(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Invalid execution-wait storage response.'); }
function record(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value;
}
function fields(value: JsonObject, expected: readonly string[]): void {
  const names = Object.keys(value);
  if (names.length !== expected.length || names.some(name => !expected.includes(name))) invalidResponse();
}
function sameReference(left: ExecutionRef, right: ExecutionRef): boolean {
  return left.kind === right.kind && left.runId === right.runId && left.definitionHash === right.definitionHash && left.policyHash === right.policyHash;
}
function wait(value: JsonValue, command: JsonObject, requireId: boolean): ExecutionWaitSnapshot {
  const result = executionWaitSnapshot(value);
  if ((requireId && result.id !== command['id']) || result.targets.some(target => target.policyHash !== command['policyHash'])) invalidResponse();
  return result;
}

/** Driver responses are untrusted transport data; never disclose malformed payloads or diagnostics. */
function response(method: ExecutionWaitMethod, command: JsonObject, value: unknown): unknown {
  try {
    if (method === 'initialize' || method === 'open') {
      if (value !== undefined) invalidResponse();
      return undefined;
    }
    if (value === undefined && (method === 'inspect' || method === 'materialize')) return undefined;
    const copy = jsonValue(value, { maxBytes: method === 'drainReady' ? DRAIN_BYTES : method === 'events' ? EVENT_BYTES : SINGLE_BYTES,
      maxDepth: 16, maxNodes: 100_000 });
    if (method === 'materialize') {
      const result = executionCompletion(copy);
      if (!sameReference(result.reference, command['reference'] as unknown as ExecutionRef)) invalidResponse();
      return result;
    }
    if (method === 'register' || method === 'inspect' || method === 'cancel') {
      const result = wait(copy, command, true);
      if (method === 'cancel' && result.status === 'waiting') invalidResponse();
      if (method === 'register') {
        const targets = command['targets'] as unknown as ExecutionRef[];
        if (targets.length !== result.targets.length || targets.some((target, index) => !sameReference(target, result.targets[index]!))) invalidResponse();
      }
      return result;
    }
    if (method === 'drainReady') {
      if (!Array.isArray(copy) || copy.length > (command['limit'] as number)) invalidResponse();
      const ids = new Set<string>();
      return Object.freeze(copy.map(item => {
        const result = wait(item, command, false);
        if (result.status !== 'resolved' || ids.has(result.id)) invalidResponse();
        ids.add(result.id); return result;
      }));
    }
    if (method === 'events') {
      if (!Array.isArray(copy) || copy.length > 1_000) invalidResponse();
      let previous = command['after'] as number;
      for (const item of copy) {
        const event = record(item); fields(event, ['type', 'data', 'sequence', 'createdAt']);
        const sequence = event['sequence'];
        // The bounded stream has one creation plus at most two entries per lifetime wait.
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 257 || sequence !== previous + 1) invalidResponse();
        previous = sequence;
        const time = event['createdAt'];
        if (typeof time !== 'string' || new Date(time).toISOString() !== time) invalidResponse();
        const data = record(event['data']);
        if (event['type'] === 'stream.created') {
          if (sequence !== 1) invalidResponse();
          fields(data, []);
        } else {
          if (sequence === 1 || !['wait.registered', 'wait.resolved', 'wait.cancelled'].includes(event['type'] as string)) invalidResponse();
          fields(data, ['waitId']);
          if (typeof data['waitId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(data['waitId'])) invalidResponse();
        }
      }
      return freezeJson(copy);
    }
    return invalidResponse();
  } catch { return invalidResponse(); }
}

/**
 * Snapshots commands before await/IPC and validates immutable, explicitly bounded replies.
 * SQL/public hosts additionally verify canonical definition digests and backend identity.
 */
export function executionWaitFacade(request: (method: ExecutionWaitMethod, input: JsonObject) => Promise<unknown>): ExecutionWaitStore {
  const call = async <T>(method: ExecutionWaitMethod, value: unknown): Promise<T> => {
    const command = executionWaitCommand(method, value);
    const result = await request(method, command);
    return response(method, command, result) as T;
  };
  return Object.freeze({
    initialize: () => call<void>('initialize', {}),
    open: value => call('open', value),
    materialize: value => call('materialize', value),
    register: value => call('register', value),
    inspect: value => call('inspect', value),
    cancel: value => call('cancel', value),
    drainReady: value => call('drainReady', value),
    events: value => call('events', value),
  } satisfies ExecutionWaitStore);
}
