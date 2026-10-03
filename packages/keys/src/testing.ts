import { MayuraError, type JsonObject } from '@mayura/core';
import { StorageError, type AggregateStore, type CreateRecord, type StoredEvent, type StoredRecord, type UpdateRecord } from '@mayura/storage-contracts';

/**
 * A Mayura store in memory, for tests and trying keys out: records, compare-and-set updates and events behave as in
 * the durable stores, and everything is gone when the process ends. Never use it in production.
 */
export function memoryAggregateStore(): AggregateStore & { readonly size: number } {
  const records = new Map<string, StoredRecord>(); const events = new Map<string, StoredEvent[]>();
  let open = true; let initialized = false;
  const key = (scope: string, id: string) => `${scope}\u0000${id}`;
  const ready = () => {
    if (!open) throw new StorageError('STORE_CLOSED', 'The store is closed.');
    if (!initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize the store first.');
  };
  const copy = (state: JsonObject): JsonObject => JSON.parse(JSON.stringify(state)) as JsonObject;
  const append = (at: string, inputs: readonly { readonly type: string; readonly data: JsonObject }[]) => {
    const list = events.get(at) ?? [];
    for (const input of inputs) list.push(Object.freeze({ type: input.type, data: copy(input.data), sequence: list.length + 1, createdAt: new Date().toISOString() }));
    events.set(at, list);
  };
  return {
    get size() { return records.size; },
    initialize: async () => { if (!open) throw new StorageError('STORE_CLOSED', 'The store is closed.'); initialized = true; },
    create: async (command: CreateRecord) => {
      ready();
      const at = key(command.scope, command.id); const existing = records.get(at);
      if (existing) {
        if (existing.idempotencyKey !== command.idempotencyKey) throw new StorageError('CONFLICT', 'A record with this id exists.');
        return { record: existing, created: false };
      }
      const record: StoredRecord = Object.freeze({ scope: command.scope, id: command.id, idempotencyKey: command.idempotencyKey, definitionHash: command.definitionHash, version: 1, state: copy(command.state) });
      records.set(at, record); append(at, command.events);
      return { record, created: true };
    },
    read: async (scope: string, id: string) => { ready(); return records.get(key(scope, id)); },
    update: async (command: UpdateRecord) => {
      ready();
      const at = key(command.scope, command.id); const existing = records.get(at);
      if (!existing) throw new StorageError('NOT_FOUND', 'No such record.');
      if (existing.version !== command.expectedVersion) throw new StorageError('CONFLICT', 'The record changed.');
      const record: StoredRecord = Object.freeze({ ...existing, version: existing.version + 1, state: copy(command.state) });
      records.set(at, record); append(at, command.events);
      return record;
    },
    events: async (scope: string, id: string, after = 0) => {
      ready();
      if (!Number.isSafeInteger(after) || after < 0) throw new MayuraError('INVALID_INPUT', 'after is an event sequence.');
      return (events.get(key(scope, id)) ?? []).filter(event => event.sequence > after).slice(0, 1_000);
    },
    close: async () => { open = false; },
  };
}

export { keyManagerConformance } from './conformance.js';
export type { KeyManagerConformanceCase } from './conformance.js';
