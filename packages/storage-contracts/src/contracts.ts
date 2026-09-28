import { MayuraError, type ErrorCode, type JsonObject } from '@mayura/core';

/** An append-only event whose sequence and time are assigned by the store. */
export interface StoredEventInput { readonly type: string; readonly data: JsonObject }
export interface StoredEvent extends StoredEventInput { readonly sequence: number; readonly createdAt: string }

/** Scoped aggregate snapshot. Version starts at one and increases on every update. */
export interface StoredRecord {
  readonly scope: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly definitionHash: string;
  readonly version: number;
  readonly state: JsonObject;
}

export interface CreateRecord {
  readonly scope: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly definitionHash: string;
  readonly state: JsonObject;
  readonly events: readonly StoredEventInput[];
}
export interface UpdateRecord {
  readonly scope: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly state: JsonObject;
  readonly events: readonly StoredEventInput[];
}

/**
 * Reviewed in-place definition migration: compare-and-set on both the version and the pinned definition digest, then
 * rewrite the digest, state and events atomically. Only workflow migration code may call it.
 */
export interface MigrateRecord extends UpdateRecord {
  readonly expectedDefinitionHash: string;
  readonly definitionHash: string;
}

/**
 * Trusted persistence building block, not an authorization or effect-dispatch engine.
 * Call initialize before access. Event reads return at most 1,000 ordered events;
 * continue from the last sequence until a short page is returned.
 */
export interface AggregateStore {
  initialize(): Promise<void>;
  create(command: CreateRecord): Promise<{ record: StoredRecord; created: boolean }>;
  read(scope: string, id: string): Promise<StoredRecord | undefined>;
  update(command: UpdateRecord): Promise<StoredRecord>;
  /** Optional: stores without it cannot migrate in-flight workflow runs (migration then fails with UNSUPPORTED). */
  migrate?(command: MigrateRecord): Promise<StoredRecord>;
  events(scope: string, id: string, after?: number): Promise<StoredEvent[]>;
  close(): Promise<void>;
}

/** The exact storage condition behind a `StorageError`; its `code` is the general `ErrorCode` this maps to. */
export type StorageErrorCode =
  | 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'STORAGE_UNAVAILABLE'
  | 'STORE_CLOSED' | 'STORE_NOT_INITIALIZED' | 'QUEUE_FULL' | 'STALE_CLAIM' | 'LIMIT_EXCEEDED'
  | 'SCHEDULED_WRITER_REQUIRED';

/**
 * The general code of each storage condition: a closed store is unavailable, a store used before `initialize()` is a
 * configuration error, a full queue is a limit, and a lost claim or a run owned by its scheduled writer is a conflict.
 */
const generalCodes: Readonly<Record<StorageErrorCode, ErrorCode>> = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT', CONFLICT: 'CONFLICT', NOT_FOUND: 'NOT_FOUND', STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  STORE_CLOSED: 'STORAGE_UNAVAILABLE', STORE_NOT_INITIALIZED: 'INVALID_CONFIG', QUEUE_FULL: 'LIMIT_EXCEEDED',
  STALE_CLAIM: 'CONFLICT', LIMIT_EXCEEDED: 'LIMIT_EXCEEDED', SCHEDULED_WRITER_REQUIRED: 'CONFLICT',
});

/**
 * A storage failure. It is a `MayuraError`, so one `catch` handles storage and workflow failures alike: `code` is the
 * general code every Mayura API uses (`CONFLICT`, `NOT_FOUND`, `LIMIT_EXCEEDED`, ...) and `storageCode` names the exact
 * storage condition (for example `STALE_CLAIM` behind `CONFLICT`). Messages never contain driver text, SQL or
 * connection credentials.
 */
export class StorageError extends MayuraError {
  readonly storageCode: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(Object.hasOwn(generalCodes, code) ? generalCodes[code] : 'STORAGE_UNAVAILABLE', message);
    this.storageCode = Object.hasOwn(generalCodes, code) ? code : 'STORAGE_UNAVAILABLE';
  }
}

/** Whether `error` is a storage failure with this exact storage condition. */
export function isStorageError(error: unknown, code: StorageErrorCode): error is StorageError {
  return error instanceof StorageError && error.storageCode === code;
}

export function storageError(error: unknown): StorageError {
  return error instanceof StorageError
    ? error
    : new StorageError('STORAGE_UNAVAILABLE', 'Storage operation failed. Check protected local diagnostics.');
}
