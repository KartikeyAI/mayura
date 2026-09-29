import { jsonValue, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import type { AggregateStore, StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';

/**
 * Where a host's sweep stands, kept in storage, so that a new process (a restarted worker, or the next run of a one-shot
 * worker) continues the sweep instead of starting it over. Without it, a sweep that never finishes within one process
 * would keep revisiting the same runs and never reach the rest.
 *
 * Best effort: a position that cannot be read or written only costs a restart from the beginning, never correctness,
 * because every run transition is decided on the run's own record.
 */
export interface SweepPosition<C> {
  /** The stored position, once per process (the first call only); `null` when there is none or it cannot be read. */
  load(): Promise<C | null>;
  /** Store the position if it changed. Failures are ignored. */
  save(position: C | null): Promise<void>;
}

export function createSweepPosition<C>(store: AggregateStore, options: {
  readonly kind: 'lifecycle' | 'composite'; readonly scope: Scope; readonly catalog: readonly string[];
}): SweepPosition<C> {
  const scope = digest('mayura:scope:v1', { principalId: options.scope.principalId, projectId: options.scope.projectId });
  const id = digest('mayura:workflow-sweep-position:v1', { scope, kind: options.kind, catalog: [...options.catalog].sort() });
  const definitionHash = digest('mayura:workflow-sweep-position-format:v1', {});
  let loaded = false; let record: StoredRecord | undefined; let stored: string | undefined;
  const state = (position: C | null): JsonObject => jsonValue({ format: 1, position: position as unknown as JsonValue }) as JsonObject;
  return Object.freeze<SweepPosition<C>>({
    async load() {
      if (loaded) return null; loaded = true;
      try {
        record = await store.read(scope, id);
        const value = record?.state['format'] === 1 ? record.state['position'] : null;
        stored = JSON.stringify(value ?? null);
        return (value ?? null) as C | null;
      } catch { record = undefined; return null; }
    },
    async save(position) {
      const text = JSON.stringify(position);
      if (text === stored) return;
      try {
        record ??= await store.read(scope, id);
        record = record ? await store.update({ scope, id, expectedVersion: record.version, state: state(position), events: [] })
          : (await store.create({ scope, id, idempotencyKey: id, definitionHash, state: state(position), events: [] })).record;
        stored = text;
      } catch {
        // Another host wrote it first, or storage failed: forget the version and read it again on the next save.
        record = undefined; stored = undefined;
      }
    },
  });
}
