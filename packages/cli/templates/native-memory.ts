import { createHash } from 'node:crypto';
import { createMemoryStore } from 'mayura/memory';
import { createSqliteStore } from 'mayura/storage-sqlite';

const storage = createSqliteStore({ filename: ':memory:' }); await storage.initialize();
const memory = createMemoryStore({ store: storage, scope: { principalId: 'local-developer', projectId: 'starter' },
  permissions: { allow: ['memory:write', 'memory:read', 'memory:delete', 'memory:export'] } });
try {
  const content = 'Mayura memory is explicitly scoped.'; const observedAt = new Date().toISOString();
  const added = await memory.add({ id: 'mayura-scope', content, category: 'fact', sensitivity: 'internal', provenance: {
    sourceId: 'starter-readme', reference: 'README.md', revision: '1', sha256: createHash('sha256').update(content).digest('hex'),
    author: 'local-developer', observedAt, origin: 'observed', confidence: 1 }, validity: { from: observedAt, until: null } });
  const found = await memory.search('Mayura scoped'); const tombstone = await memory.forget({ id: added.id, expectedVersion: added.version });
  console.log(JSON.stringify({ hits: found.hits.length, deleted: tombstone.status === 'deleted' }));
} finally { await storage.close(); }
