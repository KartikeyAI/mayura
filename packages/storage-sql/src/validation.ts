import { createHash } from 'node:crypto';
import { jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type CreateRecord, type MigrateRecord, type StoredEventInput, type UpdateRecord } from './contracts.js';

export const EVENT_PAGE_SIZE = 1_000;
const MAX_STATE_BYTES = 1_048_576;
const MAX_EVENT_BYTES = 65_536;

export function identifier(value: unknown, label: string): string {
  // In Unicode mode valid pairs are one code point; only unpaired units match.
  // Reject before UTF-8 encoding can replace malformed identities with U+FFFD.
  if (typeof value !== 'string' || value.length === 0 || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value) > 256 || value.includes('\0')) {
    throw new StorageError('INVALID_INPUT', `${label} must be a nonempty well-formed Unicode string of at most 256 UTF-8 bytes without null characters.`);
  }
  return value;
}

function object(value: unknown, maxBytes: number): JsonObject {
  try {
    const result = jsonValue(value, { maxBytes, maxDepth: 32, maxNodes: 100_000 });
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new StorageError('INVALID_INPUT', 'State and event data must be bounded plain JSON objects.');
  }
}

function eventInputs(events: readonly StoredEventInput[]): StoredEventInput[] {
  if (!Array.isArray(events) || events.length > EVENT_PAGE_SIZE) {
    throw new StorageError('INVALID_INPUT', 'A transaction accepts at most 1,000 events.');
  }
  const result = events.map((event) => {
    if (event === null || typeof event !== 'object') throw new StorageError('INVALID_INPUT', 'Invalid event envelope.');
    return { type: identifier(event.type, 'Event type'), data: object(event.data, MAX_EVENT_BYTES) };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_STATE_BYTES) {
    throw new StorageError('INVALID_INPUT', 'Combined event payload exceeds one MiB.');
  }
  return result;
}

export function createCommand(input: CreateRecord): CreateRecord {
  if (input === null || typeof input !== 'object') throw new StorageError('INVALID_INPUT', 'Invalid create command.');
  return {
    scope: identifier(input.scope, 'Scope'), id: identifier(input.id, 'Record ID'),
    idempotencyKey: identifier(input.idempotencyKey, 'Idempotency key'),
    definitionHash: identifier(input.definitionHash, 'Definition hash'),
    state: object(input.state, MAX_STATE_BYTES), events: eventInputs(input.events),
  };
}

export function migrateCommand(input: MigrateRecord): MigrateRecord {
  const base = updateCommand(input);
  if (input.expectedDefinitionHash === input.definitionHash) throw new StorageError('INVALID_INPUT', 'A migration must change the definition hash.');
  return { ...base, expectedDefinitionHash: identifier(input.expectedDefinitionHash, 'Expected definition hash'), definitionHash: identifier(input.definitionHash, 'Definition hash') };
}

export function updateCommand(input: UpdateRecord): UpdateRecord {
  if (input === null || typeof input !== 'object') throw new StorageError('INVALID_INPUT', 'Invalid update command.');
  positiveInteger(input.expectedVersion, 'Expected version');
  return {
    scope: identifier(input.scope, 'Scope'), id: identifier(input.id, 'Record ID'),
    expectedVersion: input.expectedVersion, state: object(input.state, MAX_STATE_BYTES), events: eventInputs(input.events),
  };
}

export function positiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new StorageError('INVALID_INPUT', `${label} must be a positive safe integer.`);
  }
}

export function cursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError('INVALID_INPUT', 'Event cursor must be a nonnegative safe integer.');
  return value;
}

/** Mayura JSON canonical encoding v1: sorted UTF-16 keys, JSON string/number encoding. */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

/** Includes original events, but never mutable current state or store timestamps. */
export function submissionDigest(command: CreateRecord): string {
  const value: JsonObject = {
    scope: command.scope, id: command.id, idempotencyKey: command.idempotencyKey,
    definitionHash: command.definitionHash, state: command.state,
    events: command.events.map((event) => ({ type: event.type, data: event.data })),
  };
  return createHash('sha256').update('mayura:aggregate-submission:v1\n').update(canonical(value)).digest('hex');
}

export function nextCounter(current: number, increment: number): number {
  const next = current + increment;
  if (!Number.isSafeInteger(next) || next < current) throw new StorageError('CONFLICT', 'Stored counter exhausted.');
  return next;
}

export function storedObject(value: unknown): JsonObject {
  try { return object(value, MAX_STATE_BYTES); }
  catch { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored JSON failed integrity validation.'); }
}
