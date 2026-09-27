# Remote memory and context adapters

Status: implemented optional adapter profile with deterministic HTTP and packed-consumer qualification. Requirements F11 and F13; extends V13 without changing its native canonical-state claim.

## Authority model

`mayura/memory-remote` treats Mem0, Supermemory and OpenViking as untrusted semantic indexes, never canonical stores. `createRemoteMemoryBridge()` derives a domain-separated SHA-256 namespace from the verified Mayura principal/project scope. Raw scope identifiers, provenance, sensitivity labels and native metadata are not sent. The provider receives bounded record content plus only the namespace, canonical ID, version, content hash and adapter format marker.

Publishing first proves the supplied active record is the exact current native record. Removing first proves the supplied deletion is the exact current permanent tombstone. Remote search results contain only candidates. The bridge re-reads each candidate from native memory and returns current canonical content/provenance only when namespace, ID, active version and content hash all match. Wrong-scope, stale, deleted and duplicate hits are counted without exposing their content. A provider retaining deleted or old data therefore cannot resurrect it into Mayura context.

The bridge does not wrap a native write and a remote request in a fictitious distributed transaction. Native state wins after every partial failure. Applications persist the returned provider reference and explicitly reconcile again. Search stays safe while the index is late or unavailable, but recall can be incomplete until reconciliation succeeds.

## Provider profiles

- `mem0Memory()` uses fixed `https://api.mem0.ai` destinations and explicit `Authorization: Token` credentials. V3 additions are asynchronous and return an operation reference; deletion requires an entry reference later obtained from search. An exact prior entry can be updated through the documented v1 entry endpoint. Mayura never treats a queued event as proof of an indexed or deletable memory.
- `supermemory()` uses fixed `https://api.supermemory.ai` destinations, explicit Bearer credentials, a scope container tag and deterministic custom document ID. Replacing a known prior document is delete-then-add and can leave a temporary retrieval gap; native memory remains available and canonical. V4 search hits are accepted only through the native rehydration barrier.
- `openViking()` accepts an explicit HTTPS base URL or plain HTTP only on exact loopback hosts. Non-loopback endpoints require explicit X-API-Key or Bearer authentication. Each record has a deterministic current-user `viking://~/memories/mayura/<opaque-scope>/<hashed-id>.json` path. Writes use the content API, search is pinned to that directory with content reads, and deletion is one exact non-recursive filesystem URI. It never exposes recursive deletion.

The OpenViking integration is an HTTP client only; Mayura neither embeds nor redistributes OpenViking. Deployers must independently review the selected OpenViking version, AGPL obligations, authentication, model dependencies and tenant configuration. Hosted/OSS feature equivalence is not assumed for any provider.

## Network and failure boundary

Constructors never perform I/O or inspect environment credentials. Request and response bytes, timeouts, result counts, identifiers and JSON are bounded. Redirects and credential-bearing URLs are rejected; credentials are headers only. Provider bodies, arbitrary transport messages and stale remote content never enter public errors. There are no automatic retries because write/delete retry safety is provider- and reference-dependent.

Deterministic tests cover exact destinations and headers, opaque scope metadata, version/hash mapping, asynchronous references, replacement/deletion, unsafe endpoint rejection, canonical rehydration, cross-scope exclusion, stale correction, permanent tombstones, duplicate hits and sanitized failures. The isolated four-package consumer executes the public bridge and constructs all three adapters without workspace fallback. These fixtures make no external request. Live credentials, provider editions, service availability, semantic quality, data residency, deletion SLAs and cross-platform behavior remain unqualified.

Official contracts used for this profile: [Mem0 Platform API](https://github.com/mem0ai/mem0/blob/main/integrations/mem0-plugin/skills/mem0/references/api-reference.md), [Supermemory API](https://github.com/supermemoryai/supermemory/blob/main/skills/supermemory/references/api-reference.md), OpenViking [retrieval](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/06-retrieval.md), [filesystem](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/03-filesystem.md), and [URI scoping](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/04-viking-uri.md).
