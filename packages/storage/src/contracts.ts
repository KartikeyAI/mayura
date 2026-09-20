import type { JsonObject } from '@mayura/core';

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
 * Trusted persistence building block, not an authorization or effect-dispatch engine.
 * Call initialize before access. Event reads return at most 1,000 ordered events;
 * continue from the last sequence until a short page is returned.
 */
export interface AggregateStore {
  initialize(): Promise<void>;
  create(command: CreateRecord): Promise<{ record: StoredRecord; created: boolean }>;
  read(scope: string, id: string): Promise<StoredRecord | undefined>;
  update(command: UpdateRecord): Promise<StoredRecord>;
  events(scope: string, id: string, after?: number): Promise<StoredEvent[]>;
  close(): Promise<void>;
}

export type StorageErrorCode =
  | 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'STORAGE_UNAVAILABLE'
  | 'STORE_CLOSED' | 'STORE_NOT_INITIALIZED' | 'QUEUE_FULL';

/** Stable errors intentionally omit driver messages, SQL and connection credentials. */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(readonly code: StorageErrorCode, message: string) { super(message); }
}

export function storageError(error: unknown): StorageError {
  return error instanceof StorageError
    ? error
    : new StorageError('STORAGE_UNAVAILABLE', 'Storage operation failed. Check protected local diagnostics.');
}
