import { MayuraError, type JsonObject, type Scope } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import type { AggregateStore } from '@mayura/storage-contracts';
import type { RagCatalog, RagRevision } from './contracts.js';
import { cancelled, id, revision, scopeKey } from './validation.js';
/** Scope-isolated catalog over any AggregateStore; no new database schema or driver dependency. */
export function aggregateRagCatalog(store: AggregateStore): RagCatalog {
  const key = (scope: Scope) => sha256Hex(scopeKey(scope,'rag.catalog.v1'));
  return Object.freeze({
    async read(scope: Scope, documentId: string, signal: AbortSignal) {
      cancelled(signal); const record = await store.read(key(scope),id(documentId)); cancelled(signal);
      return record ? revision(record.state as unknown as RagRevision) : undefined;
    },
    async publish(scope: Scope, documentId: string, expected: string | null, next: RagRevision, signal: AbortSignal) {
      cancelled(signal); const checked = revision(next); const namespace = key(scope); const name = id(documentId); const current = await store.read(namespace,name); cancelled(signal);
      // An exact repeated publication is harmless, including acknowledgement loss.
      if (current && JSON.stringify(revision(current.state as unknown as RagRevision)) === JSON.stringify(checked)) return;
      if ((current?.state['revision'] ?? null) !== expected) throw new MayuraError('CONFLICT','RAG publication revision changed.');
      const state = checked as unknown as JsonObject; const events = [{ type: 'rag.published', data: { revision: checked.revision, deleted: checked.deleted } }];
      if (current) await store.update({ scope: namespace, id: name, expectedVersion: current.version, state, events });
      else {
        const result = await store.create({ scope: namespace, id: name, idempotencyKey: name, definitionHash: 'mayura-rag-catalog-v1', state, events });
        if (!result.created && JSON.stringify(revision(result.record.state as unknown as RagRevision)) !== JSON.stringify(checked)) throw new MayuraError('CONFLICT','RAG publication revision changed.');
      }
      cancelled(signal);
    },
  });
}
