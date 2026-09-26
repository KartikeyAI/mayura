import { describe, expect, it, vi } from 'vitest';
import type { Scope } from '@mayura/core';
import type { MemoryRecord, MemoryStore, MemoryTombstone } from '@mayura/memory';
import { createRemoteMemoryBridge, type RemoteMemoryAdapter } from '../src/index.js';

const scope: Scope = { principalId: 'owner-private', projectId: 'project-private' };
const record: MemoryRecord = {
  id: 'decision-1', version: 1, status: 'active', scope, category: 'decision', content: 'Use strict TypeScript.', contentSha256: 'a'.repeat(64),
  metadata: {}, sensitivity: 'internal', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
  provenance: { sourceId: 'source', reference: 'source://one', revision: 'r1', sha256: 'b'.repeat(64), author: 'owner', observedAt: '2026-09-24T00:00:00.000Z', origin: 'observed', confidence: 1 },
  validity: { from: '2026-09-24T00:00:00.000Z', until: null },
};
const tombstone: MemoryTombstone = { id: 'decision-2', version: 2, status: 'deleted', scope, sensitivity: 'internal',
  createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z', deletedAt: '2026-09-24T01:00:00.000Z' };
const canonical = { get: async (id: string) => [record, tombstone].find(entry => entry.id === id) } as unknown as MemoryStore;
const reference = { provider: 'fixture', kind: 'entry' as const, id: 'remote-1' };

function adapter() {
  const publish = vi.fn<RemoteMemoryAdapter['publish']>().mockResolvedValue({ status: 'applied', reference });
  const remove = vi.fn<RemoteMemoryAdapter['remove']>().mockResolvedValue();
  return { publish, remove, value: { id: 'fixture', publish, remove, search: vi.fn() } as RemoteMemoryAdapter };
}

describe('remote memory write hooks', () => {
  it('gates publish and remove with before/after hooks', async () => {
    const { publish, remove, value } = adapter();
    const before = vi.fn((_event: unknown) => ({ decision: 'continue' as const })); const after = vi.fn((_event: unknown) => {});
    const bridge = createRemoteMemoryBridge({ canonical, adapter: value, scope, hooks: { beforeMemoryWrite: before, afterMemoryWrite: after } });
    await bridge.publish(record); await bridge.remove(tombstone, reference);
    expect(publish).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
    expect(before.mock.calls[0]![0]).toMatchObject({ operation: 'publish', id: 'decision-1', expectedVersion: 1, candidate: { content: 'Use strict TypeScript.' } });
    expect(before.mock.calls[1]![0]).toEqual({ operation: 'remove', scope, id: 'decision-2', expectedVersion: 2 });
    expect(after.mock.calls.map(([event]) => event)).toEqual([
      { operation: 'publish', scope, id: 'decision-1', version: 1, status: 'active' },
      { operation: 'remove', scope, id: 'decision-2', version: 2, status: 'deleted' },
    ]);
  });

  it('sends nothing when the before hook blocks, and reports a sent write when the after hook fails', async () => {
    const blocked = adapter();
    const bridge = createRemoteMemoryBridge({ canonical, adapter: blocked.value, scope, hooks: { beforeMemoryWrite: () => ({ decision: 'block' }) } });
    await expect(bridge.publish(record)).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    await expect(bridge.remove(tombstone, reference)).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    expect(blocked.publish).not.toHaveBeenCalled(); expect(blocked.remove).not.toHaveBeenCalled();
    const audited = adapter();
    const failing = createRemoteMemoryBridge({ canonical, adapter: audited.value, scope, hooks: { afterMemoryWrite: () => { throw new Error('x'); } } });
    await expect(failing.publish(record)).rejects.toThrow(/was sent/);
    expect(audited.publish).toHaveBeenCalledTimes(1);
  });
});
