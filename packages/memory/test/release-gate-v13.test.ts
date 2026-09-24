import { afterEach, describe, expect, it } from 'vitest';
import { assembleContext, type ContextCandidate, type SourceState } from '@mayura/context';
import { createSqliteStore } from '@mayura/storage';
import { createMemoryStore, type MemoryRecord } from '../src/index.js';
import { memoryInput } from './conformance.js';

const scope = { principalId: 'owner', projectId: 'v13-project' } as const;
const stores: ReturnType<typeof createSqliteStore>[] = [];

function derivative(record: MemoryRecord): ContextCandidate {
  return {
    id: `derived:${record.id}:${record.version}`, scope,
    source: { id: record.id, revision: String(record.version), kind: 'memory' },
    provenance: {
      reference: `memory://${record.id}/${record.version}`, observedAt: record.updatedAt,
      origin: 'inferred', confidence: record.provenance.confidence,
      upstream: { sourceId: record.provenance.sourceId, revision: record.provenance.revision, sha256: record.provenance.sha256 },
    },
    trust: 'reviewed', sensitivity: record.sensitivity, kind: 'evidence', content: { summary: record.content },
  };
}
const source = (record: MemoryRecord): SourceState => ({ scope, id: record.id, revision: String(record.version), status: 'active' });
const assemble = (candidate: ContextCandidate, state: SourceState) => assembleContext({
  scope, policyVersion: 'v13-policy', asOf: '2026-09-24T00:00:00.000Z', candidates: [candidate], sources: [state],
  allowedSensitivities: ['internal'], budget: { maxBytes: 64_000, maxEstimatedTokens: 64_000 },
});

afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

describe('V13 memory/context isolation', () => {
  it('invalidates derivatives on correction/deletion and preserves provenance through export migration', async () => {
    const store = createSqliteStore({ filename: ':memory:' }); stores.push(store); await store.initialize();
    const memory = createMemoryStore({ store, scope, permissions: { allow: ['memory:read', 'memory:write', 'memory:delete', 'memory:export'] } });
    const first = await memory.add(memoryInput({ id: 'source-record', content: 'original evidence' }));
    const oldDerivative = derivative(first);
    expect((await assemble(oldDerivative, source(first))).selected).toHaveLength(1);

    const corrected = await memory.correct({ ...memoryInput({ id: first.id, content: 'corrected evidence', provenance: { ...first.provenance, revision: 'v2', sha256: 'b'.repeat(64) } }), expectedVersion: first.version });
    expect((await assemble(oldDerivative, source(corrected))).selected).toEqual([]);
    const currentDerivative = derivative(corrected);
    expect((await assemble(currentDerivative, source(corrected))).selected[0]?.provenance.upstream).toEqual({
      sourceId: corrected.provenance.sourceId, revision: corrected.provenance.revision, sha256: corrected.provenance.sha256,
    });

    const migrated = JSON.parse(JSON.stringify(await memory.exportSnapshot())) as { records: MemoryRecord[] };
    const migratedRecord = migrated.records.find(record => record.id === corrected.id)!;
    expect(derivative(migratedRecord).provenance.upstream).toEqual(currentDerivative.provenance.upstream);

    const deleted = await memory.forget({ id: corrected.id, expectedVersion: corrected.version });
    expect((await assembleContext({
      scope, policyVersion: 'v13-policy', asOf: '2026-09-24T00:00:00.000Z', candidates: [currentDerivative],
      sources: [{ scope, id: deleted.id, revision: String(deleted.version), status: 'deleted' }],
      allowedSensitivities: ['internal'], budget: { maxBytes: 64_000, maxEstimatedTokens: 64_000 },
    })).selected).toEqual([]);
    await expect(memory.add(memoryInput({ id: deleted.id }))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(memory.correct({ ...memoryInput({ id: deleted.id }), expectedVersion: corrected.version })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
