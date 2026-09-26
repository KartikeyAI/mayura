import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type MemoryHooks } from '../src/index.js';
import { memoryInput } from './conformance.js';
import { sqliteFixture } from './fixtures.js';

const scope = { principalId: 'owner', projectId: 'hooks' };
const permissions = { allow: ['memory:write', 'memory:delete', 'memory:read'] };

async function withMemory(hooks: MemoryHooks, body: (memory: ReturnType<typeof createMemoryStore>, plain: ReturnType<typeof createMemoryStore>) => Promise<void>): Promise<void> {
  const fixture = await sqliteFixture(); await fixture.store.initialize();
  try {
    await body(createMemoryStore({ store: fixture.store, scope, permissions, hooks }), createMemoryStore({ store: fixture.store, scope, permissions }));
  } finally { await fixture.store.close(); await fixture.cleanup(); }
}

describe('memory write lifecycle hooks', () => {
  it('runs before/after around add, correct and forget with validated views', async () => {
    const before = vi.fn((_event: unknown) => ({ decision: 'continue' as const }));
    const after = vi.fn((_event: unknown) => {});
    await withMemory({ beforeMemoryWrite: before, afterMemoryWrite: after }, async memory => {
      const added = await memory.add(memoryInput());
      const corrected = await memory.correct({ ...memoryInput({ content: 'Corrected content.' }), expectedVersion: added.version });
      await memory.forget({ id: corrected.id, expectedVersion: corrected.version });
    });
    expect(before.mock.calls.map(([event]) => (event as { operation: string }).operation)).toEqual(['add', 'correct', 'forget']);
    expect(before.mock.calls[0]![0]).toMatchObject({ operation: 'add', scope, id: 'memory-1', candidate: { content: 'The project uses TypeScript for reliable agents.', category: 'fact' } });
    expect(before.mock.calls[1]![0]).toMatchObject({ operation: 'correct', expectedVersion: 1, candidate: { content: 'Corrected content.' } });
    expect(before.mock.calls[2]![0]).toEqual({ operation: 'forget', scope, id: 'memory-1', expectedVersion: 2 });
    expect(after.mock.calls.map(([event]) => event)).toEqual([
      { operation: 'add', scope, id: 'memory-1', version: 1, status: 'active' },
      { operation: 'correct', scope, id: 'memory-1', version: 2, status: 'active' },
      { operation: 'forget', scope, id: 'memory-1', version: 3, status: 'deleted' },
    ]);
    expect(Object.isFrozen(before.mock.calls[0]![0])).toBe(true);
  });

  it('writes nothing when the before hook blocks, fails or times out', async () => {
    for (const [hooks, code] of [
      [{ beforeMemoryWrite: () => ({ decision: 'block' }) }, 'GUARD_BLOCKED'],
      [{ beforeMemoryWrite: () => { throw new Error('no'); } }, 'GUARD_UNAVAILABLE'],
      [{ beforeMemoryWrite: () => new Promise(() => {}), timeoutMs: 20 }, 'TIMEOUT'],
    ] as const) {
      await withMemory(hooks as MemoryHooks, async (memory, plain) => {
        await expect(memory.add(memoryInput())).rejects.toMatchObject({ code });
        expect(await plain.get('memory-1', { includeDeleted: true })).toBeUndefined();
        const added = await plain.add(memoryInput());
        await expect(memory.forget({ id: added.id, expectedVersion: 1 })).rejects.toMatchObject({ code });
        expect((await plain.get('memory-1'))?.status).toBe('active');
      });
    }
  });

  it('reports a committed write when the after hook fails', async () => {
    await withMemory({ afterMemoryWrite: () => { throw new Error('audit sink down'); } }, async (memory, plain) => {
      const failure = memory.add(memoryInput());
      await expect(failure).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
      await expect(failure).rejects.toThrow(/committed/);
      expect((await plain.get('memory-1'))?.status).toBe('active');
    });
  });

  it('checks permission before the hook and rejects malformed hook options', async () => {
    const before = vi.fn(() => ({ decision: 'continue' as const }));
    const fixture = await sqliteFixture(); await fixture.store.initialize();
    try {
      const reader = createMemoryStore({ store: fixture.store, scope, permissions: { allow: ['memory:read'] }, hooks: { beforeMemoryWrite: before } });
      await expect(reader.add(memoryInput())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(before).not.toHaveBeenCalled();
      expect(() => createMemoryStore({ store: fixture.store, scope, permissions, hooks: { beforeMemoryWrite: 'x' } as never })).toThrow(/Memory hooks/);
    } finally { await fixture.store.close(); await fixture.cleanup(); }
  });
});
