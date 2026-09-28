# mayura/memory

Experimental native canonical records for an explicitly scoped principal/project. Optional infrastructure package; it is not required by the basic Mayura SDK. No model, embedding provider, account or hosted service is used.

```ts
import { createMemoryStore } from 'mayura/memory';

// `store` is your already-initialized SQLite/PostgreSQL AggregateStore.
const memory = createMemoryStore({
  store,
  scope: { principalId: authenticatedUser.id, projectId: authorizedProject.id },
  permissions: { allow: ['memory:read', 'memory:write', 'memory:delete', 'memory:export'] },
});

const record = await memory.add({
  id: 'decision-storage',
  category: 'decision',
  content: 'Use PostgreSQL for the shared execution service.',
  provenance: {
    sourceId: 'architecture-review', reference: 'local:docs/architecture.md',
    revision: reviewedRevision, sha256: verifiedSourceSha256,
    author: authenticatedUser.id, observedAt: new Date().toISOString(),
    origin: 'observed', confidence: 1,
  },
});

const matches = await memory.search('PostgreSQL execution'); // mode: 'lexical'
await memory.forget({ id: record.id, expectedVersion: record.version });
```

Scopes and capabilities must come from trusted application authorization, never model-generated arguments. The default permitted sensitivity is public/internal; confidential/restricted records require an explicitly configured profile. Memory evidence does not grant execution permissions or become system instructions.

`correct` replaces a complete record body with required provenance and an expected version. `get`, `list`, `search` and `exportSnapshot` read current storage; there is no stale derived cache. A forgotten record becomes a permanent minimal tombstone; its current content/metadata/provenance disappear from retrieval and export, but physical database/WAL/backup erasure is not claimed.

This first slice has hard limits of 128 lifetime record IDs per scope and 768 KiB total JSON. IDs retained by tombstones count toward capacity. It is an intentionally bounded correctness implementation, not repository-scale semantic memory. Search is case-insensitive token matching, not vector/meaning-based retrieval. The separate optional `mayura/memory-remote` package can use this store as canonical authority for external semantic indexes. Scalable native indexes, replacement-state import, graph memory and consolidation remain future work.

See [Memory and context](../../docs/guides/memory-and-context.md). The caller owns and closes the underlying storage adapter.
