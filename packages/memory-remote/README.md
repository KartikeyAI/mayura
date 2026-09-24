# @mayura/memory-remote

Optional Mem0, Supermemory, and OpenViking semantic-index adapters for Mayura native memory.

Native Mayura records and permanent tombstones remain canonical. Remote systems receive an opaque scope namespace plus bounded record content and continuity metadata. Search results are never returned directly: the bridge re-reads the current canonical record and accepts only an exact active version and content hash. Stale, deleted, cross-scope, duplicate, or malformed remote entries cannot resurrect memory.

Credentials, endpoints, timeouts, limits, and transports are explicit. Importing or constructing an adapter performs no network request. The adapters do not retry, follow redirects, discover ambient credentials, ingest arbitrary URLs, expose provider error bodies, or claim transactional synchronization. Applications must persist returned remote references and retry explicit reconciliation after partial failures.

Wire contracts follow the current official [Mem0 API reference](https://github.com/mem0ai/mem0/blob/main/integrations/mem0-plugin/skills/mem0/references/api-reference.md), [Supermemory API reference](https://github.com/supermemoryai/supermemory/blob/main/skills/supermemory/references/api-reference.md), and OpenViking [retrieval](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/06-retrieval.md) and [filesystem](https://github.com/volcengine/OpenViking/blob/main/docs/en/api/03-filesystem.md) documentation.
