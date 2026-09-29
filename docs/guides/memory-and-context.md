---
title: "Memory and context"
description: "Give agents scoped long-term memory with lexical, semantic and hybrid search, and assemble prompt context within a budget."
---

Memory is what an agent keeps between conversations: a customer's preferences, a decision the team made, a fact it
was told to remember. Mayura's native memory (`mayura/memory`) stores these records in your own SQLite or PostgreSQL
store, partitioned by user and project, with the source of every record attached. Context assembly (`mayura/context`)
is the other half: choosing which records, documents and open tasks go into a model's prompt without exceeding a size
budget or dropping anything that must stay.

```ts
import { createHash } from 'node:crypto';
import { createNativeMemory } from 'mayura/memory';
import { createSqliteStore } from 'mayura/storage-sqlite';

const store = createSqliteStore({ filename: ':memory:' });
await store.initialize();
await store.memory.initialize();

const memory = createNativeMemory({
  store,
  scope: { principalId: 'customer-42', projectId: 'support' },
  permissions: { allow: ['memory:read', 'memory:write', 'memory:delete'] },
});

const content = 'Prefers deliveries on weekends.';
const observedAt = new Date().toISOString();
const saved = await memory.add({
  id: 'delivery-preference',
  content,
  category: 'preference',
  provenance: {
    sourceId: 'support-chat', reference: 'conversation/1842', revision: '1',
    sha256: createHash('sha256').update(content).digest('hex'),
    author: 'customer-42', observedAt, origin: 'observed', confidence: 1,
  },
});

const { hits } = await memory.search('weekend deliveries');
console.log(hits.map(hit => hit.record.content));

await memory.forget({ id: saved.id, expectedVersion: saved.version });
await store.close();
```

## Records

Every record has an application-chosen `id` (letters, digits and `._:/-`, up to 128 characters), its `content` (up to
4 KiB of text) and a `provenance` block describing where it came from. Provenance is required: it is your statement of
the source, and Mayura keeps it with the record so you can show or audit it later. Mayura does not fetch or verify the
source itself.

| Field | Default | Meaning |
| --- | --- | --- |
| `category` | `fact` | `fact`, `preference`, `decision`, `procedure` or `episode` |
| `sensitivity` | `internal` | `public`, `internal`, `confidential` or `restricted` |
| `validity` | from `observedAt`, no end | `{ from, until }` as ISO timestamps; search ignores records outside the window |
| `metadata` | `{}` | Small JSON object (up to 2 KiB) for your own fields |

Records are versioned. `add` creates version 1 and fails with `CONFLICT` if the id already exists, which makes a
content-derived id a simple way to avoid duplicates. Changes name the version they expect, so two writers cannot
silently overwrite each other:

- `correct({ id, expectedVersion, content, provenance })` replaces a record in place with new fields.
- `supersede({ id, expectedVersion, replacement })` keeps the old record as history (`status: 'superseded'`) and adds
  a new one. Search never returns superseded records.
- `forget({ id, expectedVersion })` deletes a record. It leaves a tombstone with no content or provenance, and the id
  cannot be reused.
- `get(id)` and `list({ limit, cursor })` read records; pass `includeDeleted: true` to see tombstones and history.

## Scopes and permissions

A memory instance is bound to one scope, a `principalId` and a `projectId`. Records from another scope are not
filtered out after the fact; they are never read. Derive the scope from the verified identity of the caller, never
from model output. In a tool, use the run's scope, `context.scope`.

Each operation needs a permission in `permissions.allow`:

| Permission | Allows |
| --- | --- |
| `memory:read` | `get`, `list`, `search`, `semanticSearch`, `hybridSearch`, `neighbors`, `traverse`, `changes` |
| `memory:write` | `add`, `correct`, `supersede`, `relate` |
| `memory:delete` | `forget`, `forgetEdge` |
| `memory:index` | `index`, and sending records to a hosted embedder |
| `memory:export` | `exportSnapshot`, `exportPage` (with `memory:read`) |
| `memory:import` | `importSnapshot` (with `memory:write`) |

`allowedSensitivities` (default `public` and `internal`) limits which records the instance can see or write. A
`confidential` record is invisible to an instance that does not allow it.

## Search

| Method | How it ranks | Needs |
| --- | --- | --- |
| `search(query)` | BM25 over the record text | nothing extra |
| `semanticSearch(query)` | Cosine similarity over embeddings | an `embedder` and `index()` |
| `hybridSearch(query)` | BM25 and semantic results merged by reciprocal rank fusion | an `embedder` and `index()` |

All three return at most 50 hits (default 20) and only active records valid right now. Semantic search scans every
vector exactly until a scope holds 2,048 vectors for an embedder, then trains an inverted-file index and probes it
(`nprobe`). Each result reports its `mode`. Without an embedder, `semanticSearch` and `hybridSearch` fall back to BM25
and say so with `limitation: 'semantic_unavailable'`.

Embeddings are computed by `index()`, which embeds records that are new or changed since the last call. Run it after
writes, or on a timer:

```ts
import { createNativeMemory, hashingEmbedder } from 'mayura/memory';

const memory = createNativeMemory({
  store,
  scope: { principalId: 'team-7', projectId: 'ops' },
  permissions: { allow: ['memory:read', 'memory:write', 'memory:index'] },
  embedder: hashingEmbedder(),
});

await memory.index();
const result = await memory.hybridSearch('where are orders stored');
```

`hashingEmbedder()` is local and deterministic, and good for tests and offline development. It captures word overlap,
not meaning. For real semantic search use a hosted embedder such as `openAIEmbeddings` from
`mayura/provider-openai`:

```ts
import { openAIEmbeddings } from 'mayura/provider-openai';

const embedder = openAIEmbeddings({ apiKey: process.env.OPENAI_API_KEY ?? '', model: 'text-embedding-3-small', dimensions: 512 });
```

A hosted embedder only ever receives records whose sensitivity is in `embedSensitivities` (default `public` and
`internal`), and only when the instance holds `memory:index`. The embedder id includes the model and dimensions, so
switching models re-indexes instead of mixing vectors. You can also write your own embedder: an object with `id`,
`dimensions`, `maxBatch`, `location` (`'local'` or `'hosted'`) and `embed(texts, signal)`.

## Relationships, export and changes

- `relate({ id, from, to, relation, confidence, provenance })` links two records, for example `depends_on`.
  `neighbors(id)` and `traverse(id, { maxDepth, maxNodes })` return the connected subgraph within the same scope.
- `exportPage({ cursor })` streams records, tombstones and edges. `importSnapshot(page, { mode: 'merge' })` never
  resurrects a deleted record and never replaces a newer version.
- `changes({ after })` is a content-free feed of what changed, for cache invalidation and incremental export.

## Memory in an agent

Give the agent tools that read and write memory in the caller's own scope. A trimmed version of the support-agent
starter:

```ts
import { createHash } from 'node:crypto';
import { defineTool, z } from 'mayura';
import { createNativeMemory } from 'mayura/memory';

const recall = defineTool({
  id: 'memory.recall', version: '1', effects: 'read', capabilities: ['memory:read'],
  description: 'Look up what you remembered about the signed-in customer.',
  input: z.object({ query: z.string().min(1).max(200) }),
  output: z.object({ notes: z.array(z.string()) }),
  execute: async ({ query }, context) => {
    const memory = createNativeMemory({ store, scope: context.scope, permissions: { allow: ['memory:read'] } });
    const { hits } = await memory.search(query, { limit: 10 });
    return { notes: hits.map(hit => hit.record.content) };
  },
});

const remember = defineTool({
  id: 'memory.remember', version: '1', effects: 'write', capabilities: ['memory:write'],
  description: 'Remember one lasting fact or preference the customer asked you to remember.',
  input: z.object({ fact: z.string().min(3).max(500) }),
  output: z.object({ noteId: z.string() }),
  execute: async ({ fact }, context) => {
    const sha256 = createHash('sha256').update(fact).digest('hex');
    const noteId = `note-${sha256.slice(0, 24)}`;
    const memory = createNativeMemory({ store, scope: context.scope, permissions: { allow: ['memory:write'] } });
    await memory.add({ id: noteId, content: fact, category: 'preference', provenance: {
      sourceId: 'support-chat', reference: `run/${context.runId}`, revision: '1', sha256,
      author: context.scope.principalId, observedAt: new Date().toISOString(), origin: 'observed', confidence: 1 } });
    return { noteId };
  },
});
```

Because neither tool takes a user id as input, a model cannot read or write another user's memory. The full starter
also redacts personal data before a note is stored; see [guardrails](guardrails.md). To block or audit writes centrally,
pass `hooks: { beforeMemoryWrite, afterMemoryWrite }`; see [lifecycle hooks](lifecycle-hooks.md).

### The compact memory store

`createMemoryStore({ store, scope, permissions })` keeps up to 128 records per scope in a single stored document. It
works with any store that implements the basic `AggregateStore` contract, needs no `store.memory.initialize()`, and
offers `add`, `correct`, `forget`, `get`, `list`, simple lexical `search` and `exportSnapshot`. Use native memory for
anything larger; its `importSnapshot` accepts a compact export as-is.

## Remote memory services

`mayura/memory-remote` lets you use a hosted semantic index (Mem0, Supermemory or OpenViking) while your native store
stays the source of truth. You publish canonical records to the service; its search results are checked against the
canonical store before you see them.

```ts
import { createRemoteMemoryBridge, mem0Memory } from 'mayura/memory-remote';

const scope = { principalId: 'customer-42', projectId: 'support' };
const bridge = createRemoteMemoryBridge({
  canonical: memory,
  adapter: mem0Memory({ apiKey: process.env.MEM0_API_KEY ?? '' }),
  scope,
});

const receipt = await bridge.publish(record);
const result = await bridge.search('delivery preferences', { limit: 10 });
// result.hits hold current canonical records; result.excluded counts what was dropped.
```

Each scope maps to its own opaque namespace at the provider. A remote hit is returned only if it belongs to this
namespace and matches the current canonical version and content; stale, deleted, superseded and duplicate hits are
dropped and counted in `excluded`. `publish` needs the record's current version, and `remove(tombstone, reference)`
deletes the remote copy after you `forget` a record. Keep the returned `reference` so you can update or remove it later.

The adapters are `mem0Memory({ apiKey })`, `supermemory({ apiKey })` and `openViking({ endpoint, auth })`. OpenViking
needs HTTPS, or plain HTTP on a loopback address. Each adapter bounds request and response sizes and has a 30 second
default timeout. Records you publish leave your infrastructure, so publish only what the provider may hold.

## Context assembly

`assembleContext` picks what goes into a prompt. You pass candidates (each with a scope, source, provenance, trust,
sensitivity, kind and JSON content), the current state of every source, the sensitivities the caller may see and a
budget. You get back the selected items, a list of exclusions with reasons, and `serialized`: the exact JSON payload
that was measured against the budget.

```ts
import { assembleContext } from 'mayura/context';

const scope = { principalId: 'customer-42', projectId: 'support' };
const candidates = records.map(record => ({
  id: record.id,
  scope,
  source: { id: record.id, revision: String(record.version), kind: 'memory' as const },
  provenance: { reference: record.provenance.reference, observedAt: record.provenance.observedAt,
    origin: record.provenance.origin, confidence: record.provenance.confidence },
  trust: 'untrusted' as const,
  sensitivity: record.sensitivity,
  kind: 'evidence' as const,
  validity: record.validity,
  content: record.content,
}));

const assembly = await assembleContext({
  scope,
  policyVersion: 'context-1',
  candidates,
  sources: records.map(record => ({ scope, id: record.id, revision: String(record.version), status: 'active' as const })),
  allowedSensitivities: ['public', 'internal'],
  budget: { maxBytes: 16_000, maxEstimatedTokens: 4_000, reservedTokens: 1_000 },
});
// Put assembly.serialized into your agent's input.
```

Selection is deterministic:

- **Required items come first and are never dropped.** An item is required if it is `pinned`, or its `kind` is
  `hard_constraint`, `pending_approval`, `unresolved_blocker` or `outstanding_task`. If a required item is stale,
  deleted, out of its validity window, denied or does not fit, assembly fails instead of returning a partial result.
- **Optional items** (`evidence`, `instruction`) follow by `priority`, then most recent `observedAt`, then id. An item
  that does not fit is skipped and a smaller one after it may still fit.
- **Exclusions** say why: `stale_revision`, `source_deleted`, `expired`, `byte_budget`, `token_budget` and so on.
  Items from another scope or a denied sensitivity are reported by position only, never by id or content.

The default token estimate counts one token per UTF-8 byte, which is simple and usually conservative. Pass your own
`estimator` (`{ id, estimate(text) }`) for a closer count, and reserve room for instructions and the answer with
`reservedBytes` and `reservedTokens`. `trust` travels with every item; assembly never turns retrieved content into
trusted instructions.

For repeated assemblies, `createContextCache({ ttlMs })` returns an object with the same `assemble` method. A cached
result is reused only when every input matches, and `cache.follow(memory)` drops entries whose memory records changed.
Call `invalidate({ scope })` or `invalidate({ sourceIds })` when permissions change or content is revoked.

## Good to know

- Memory never calls the network unless you configure a hosted embedder or a remote memory adapter.
- Native memory needs `await store.memory.initialize()` once per store; otherwise calls fail with `INVALID_CONFIG`.
- A deleted record's content is gone from native memory, but copies you exported, published to a remote service or put
  into a prompt are yours to clean up.
- Context assembly works only on what you pass it. It does not retrieve, summarize or check source permissions for you.

## Related

- [Storage](storage.md)
- [Guardrails](guardrails.md)
- [Lifecycle hooks](lifecycle-hooks.md)
- [Tools](../concepts/tools.md)
- [Model providers](model-providers.md)
