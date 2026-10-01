import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileStore, type FileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { agentFsFiles, type AgentFsLike } from '../src/index.js';

/** The part of AgentFS the tests use; loaded from the development dependency. */
interface AgentFs { readonly fs: AgentFsLike; close(): Promise<void> }
const agentfsModule = 'agentfs-sdk';
const directories: string[] = []; const opened: AgentFs[] = [];
async function open(): Promise<AgentFs> {
  const { AgentFS } = await import(agentfsModule) as { AgentFS: { open(options: { path: string }): Promise<AgentFs> } };
  const directory = await mkdtemp(join(tmpdir(), 'mayura-agentfs-')); directories.push(directory);
  const agent = await AgentFS.open({ path: join(directory, 'agent.db') }); opened.push(agent);
  return agent;
}
afterAll(async () => {
  for (const agent of opened) await agent.close().catch(() => undefined);
  for (const directory of directories) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

describe('@mayurajs/filestorage-agentfs keeps the file store contract on AgentFS, as the single writer', () => {
  let store: FileStore;
  beforeAll(async () => { store = createFileStore(agentFsFiles({ fs: (await open()).fs, singleWriter: true }), { maxFileBytes: 1_048_576 }); });
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store })).toBe('passed'); });
});

describe('@mayurajs/filestorage-agentfs keeps the file store contract on AgentFS, as one writer of many', () => {
  let store: FileStore;
  beforeAll(async () => { store = createFileStore(agentFsFiles({ fs: (await open()).fs }), { maxFileBytes: 1_048_576 }); });
  for (const test of fileStoreConformance) it(test.name, async () => {
    // Without singleWriter, preconditions are refused: those cases report themselves skipped.
    expect(await test.run({ store })).toBe(/ifMatch|ifNoneMatch/u.test(test.name) ? 'skipped' : 'passed');
  });
});

describe('@mayurajs/filestorage-agentfs', () => {
  it('refuses a key where the filesystem has a file on the way, and the other way round', async () => {
    const store = createFileStore(agentFsFiles({ fs: (await open()).fs }), { maxFileBytes: 64 });
    await store.put('a', new Uint8Array([1]));
    await expect(store.put('a/b', new Uint8Array([2]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await store.put('c/d', new Uint8Array([3]));
    await expect(store.put('c', new Uint8Array([4]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('serializes single-writer writes, so racing create-only writes make exactly one file', async () => {
    const store = createFileStore(agentFsFiles({ fs: (await open()).fs, singleWriter: true }), { maxFileBytes: 64 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => store.put('once.txt', new Uint8Array([index]), { ifNoneMatch: '*' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').every(result => (result as PromiseRejectedResult).reason.code === 'CONFLICT')).toBe(true);
  });

  it('removes directories a delete leaves empty, so a later key can take the name', async () => {
    const store = createFileStore(agentFsFiles({ fs: (await open()).fs }), { maxFileBytes: 64 });
    await store.put('x/y/z.txt', new Uint8Array([1]));
    await store.delete('x/y/z.txt');
    await store.put('x', new Uint8Array([2]));
    expect((await store.list()).files.map(file => file.key)).toEqual(['x']);
  });

  it('needs a filesystem and an absolute root', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => agentFsFiles({} as never)).toThrow(invalid);
    const fs = { readFile: async () => new Uint8Array(), writeFile: async () => undefined, stat: async () => ({ size: 0, mtime: 0, isFile: () => true, isDirectory: () => false }),
      readdirPlus: async () => [], mkdir: async () => undefined, unlink: async () => undefined, rmdir: async () => undefined };
    expect(() => agentFsFiles({ fs, root: 'relative' })).toThrow(invalid);
    expect(() => agentFsFiles({ fs, root: '/files/../etc' })).toThrow(invalid);
    expect(() => agentFsFiles({ fs, root: '/workspace/files' })).not.toThrow();
  });
});
