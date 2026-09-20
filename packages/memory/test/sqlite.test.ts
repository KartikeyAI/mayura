import { memoryConformance } from './conformance.js';
import { sqliteFixture } from './fixtures.js';
import { expect, it } from 'vitest';
import { createMemoryStore } from '../src/index.js';
import { memoryInput } from './conformance.js';

memoryConformance('SQLite', sqliteFixture);

it('enforces permanent identity capacity even after deletion', async () => {
  const fixture = await sqliteFixture(); await fixture.store.initialize();
  const memory = createMemoryStore({ store: fixture.store, scope: { principalId: 'owner', projectId: 'capacity' }, permissions: { allow: ['memory:write', 'memory:delete', 'memory:read'] } });
  try {
    for (let index = 0; index < 128; index++) await memory.add(memoryInput({ id: `record-${index}`, content: 'small record', metadata: {} }));
    await memory.forget({ id: 'record-0', expectedVersion: 1 });
    await expect(memory.add(memoryInput({ id: 'overflow' }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await memory.get('record-0', { includeDeleted: true }))?.status).toBe('deleted');
  } finally { await fixture.store.close(); await fixture.cleanup(); }
}, 30_000);
