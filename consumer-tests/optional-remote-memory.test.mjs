import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteMemoryBridge, mem0Memory, openViking, supermemory } from '@mayura/memory-remote';

const root = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/storage-contracts', '@mayura/memory', '@mayura/memory-remote']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Runtime import escaped the packed consumer installation.');
}
const scope = { principalId: 'private-principal', projectId: 'private-project' };
const active = { id: 'decision-1', version: 1, status: 'active', scope, category: 'decision', content: 'canonical content',
  contentSha256: 'a'.repeat(64), metadata: {}, sensitivity: 'internal', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
  provenance: { sourceId: 'source', reference: 'source://one', revision: 'r1', sha256: 'b'.repeat(64), author: 'owner',
    observedAt: '2026-09-24T00:00:00.000Z', origin: 'observed', confidence: 1 }, validity: { from: '2026-09-24T00:00:00.000Z', until: null } };
const deleted = { id: 'deleted-1', version: 2, status: 'deleted', scope, sensitivity: 'internal', createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z', deletedAt: '2026-09-24T01:00:00.000Z' };
const values = new Map([[active.id, active], [deleted.id, deleted]]);
const canonical = { get: async id => values.get(id) };
let namespace;
const adapter = { id: 'packed-fixture', publish: async () => ({ status: 'applied', reference: { provider: 'packed-fixture', kind: 'entry', id: 'remote-1' } }),
  remove: async () => undefined, search: async () => [
    { namespace, canonicalId: active.id, canonicalVersion: 1, contentSha256: active.contentSha256, score: 0.9, reference: { provider: 'packed-fixture', kind: 'entry', id: 'remote-1' } },
    { namespace, canonicalId: deleted.id, canonicalVersion: 2, contentSha256: 'c'.repeat(64), score: 0.8, reference: { provider: 'packed-fixture', kind: 'entry', id: 'remote-2' } },
    { namespace, canonicalId: active.id, canonicalVersion: 2, contentSha256: active.contentSha256, score: 0.7, reference: { provider: 'packed-fixture', kind: 'entry', id: 'remote-stale' } },
  ] };
const bridge = createRemoteMemoryBridge({ canonical, adapter, scope }); namespace = bridge.namespace;
const result = await bridge.search('decision');
assert.equal(result.hits.length, 1); assert.equal(result.hits[0].record.content, 'canonical content'); assert.equal(result.excluded.deleted, 1);
assert.equal(result.excluded.duplicate, 1); assert(!namespace.includes('private-principal')); assert.match(namespace, /^m_[a-f0-9]{64}$/);
const inertFetch = async () => { throw new Error('must not run during construction'); };
assert.equal(mem0Memory({ apiKey: 'explicit', fetch: inertFetch }).id, 'mem0');
assert.equal(supermemory({ apiKey: 'explicit', fetch: inertFetch }).id, 'supermemory');
assert.equal(openViking({ endpoint: 'http://127.0.0.1:1933', fetch: inertFetch }).id, 'openviking');
console.log(JSON.stringify({ status: 'passed', canonicalRehydration: true, noResurrection: true, opaqueNamespace: true, threeAdapters: true }));
