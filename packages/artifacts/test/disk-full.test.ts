import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ write: false, partialWrite: false, rename: false, link: false, read: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const enospc = (): NodeJS.ErrnoException => Object.assign(new Error('private filesystem path and device details'), { code: 'ENOSPC' });
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.write) {
        faults.write = false;
        if (faults.partialWrite) { faults.partialWrite = false; await (actual.writeFile as (...values: unknown[]) => Promise<void>)(args[0], new Uint8Array([0xff]), args[2]); }
        throw enospc();
      }
      return (actual.writeFile as (...values: unknown[]) => Promise<void>)(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) { faults.rename = false; throw enospc(); }
      return actual.rename(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.link) { faults.link = false; throw enospc(); }
      return actual.link(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (faults.read) { faults.read = false; throw enospc(); }
      return (actual.readFile as (...values: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

import { createLocalArtifactStore } from '../src/index.js';

const roots: string[] = [];
const scope = Object.freeze({ principalId: 'disk-full', projectId: 'recovery' });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'mayura-artifact-enospc-')); roots.push(value); return value; }
function input(value: number) {
  return { scope, content: new Uint8Array([value]), mediaType: 'application/octet-stream', classification: 'internal' as const };
}

afterEach(async () => {
  Object.assign(faults, { write: false, partialWrite: false, rename: false, link: false, read: false });
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('local artifact storage exhaustion', () => {
  it('reports a safe failure and removes a partial staging write', async () => {
    const directory = await root(); const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100 });
    faults.write = true; faults.partialWrite = true;
    await expect(store.stage(input(1))).rejects.toEqual(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE', message: expect.not.stringContaining(directory) }));
    expect(await readdir(join(directory, 'staging'))).toEqual([]);
  });

  it('retains an admitted stage when promotion runs out of space and retries exactly', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const staged = await store.stage(input(2)); faults.rename = true;
    await expect(store.commit(staged)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const reference = await store.commit(staged);
    expect(await store.read(reference, scope)).toEqual(new Uint8Array([2]));
  });

  it('removes a partial restore staging write and leaves no committed object', async () => {
    const source = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await source.commit(await source.stage(input(3)));
    const archive = await source.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 10 });
    const directory = await root(); const destination = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100 });
    faults.write = true; faults.partialWrite = true;
    await expect(destination.restore(archive, scope, { maxArchiveBytes: 10_000, maxTotalBytes: 10, maxArtifacts: 1 }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await readdir(join(directory, 'staging'))).toEqual([]);
    await expect(destination.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(destination.restore(archive, scope, { maxArchiveBytes: 10_000, maxTotalBytes: 10, maxArtifacts: 1 }))
      .resolves.toMatchObject({ restored: 1, existing: 0 });
  });

  it('publishes no object when restore linking runs out of space and remains retryable', async () => {
    const source = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await source.commit(await source.stage(input(4)));
    const archive = await source.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 10 });
    const destination = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 }); faults.link = true;
    await expect(destination.restore(archive, scope, { maxArchiveBytes: 10_000, maxTotalBytes: 10, maxArtifacts: 1 }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(destination.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(destination.restore(archive, scope, { maxArchiveBytes: 10_000, maxTotalBytes: 10, maxArtifacts: 1 }))
      .resolves.toMatchObject({ restored: 1 });
  });

  it('returns no backup on read exhaustion and succeeds on an explicit retry', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage(input(5))); faults.read = true;
    await expect(store.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 10 }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(store.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 10 }))
      .resolves.toBeInstanceOf(Uint8Array);
  });
});
