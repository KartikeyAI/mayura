import { describe, expect, it } from 'vitest';
import { MayuraError } from '@mayura/core';
import {
  compareFileKeys, createFileStore, fileTools, FileStoreError, isFileKey, memoryFiles, type FileBackend, type FileStore,
} from '@mayura/files';
import { fileStoreConformance, testTool, toolGrants } from '../../testing/src/index.js';

const text = (value: string) => new TextEncoder().encode(value);
const memoryStore = (maxFileBytes = 1_048_576) => createFileStore(memoryFiles(), { maxFileBytes });
const code = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => (error as MayuraError).code);
const output = (result: { outcome: unknown }) => (result.outcome as { output: Record<string, unknown> }).output;

describe('the memory file store keeps the file store contract', () => {
  const store = memoryStore();
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store })).toBe('passed'); });
});

describe('createFileStore', () => {
  it('accepts only well-formed keys', () => {
    for (const key of ['a', 'a/b.txt', 'reports/2026/q3 final.csv', 'ü/😀', 'a.b', '...x']) expect(isFileKey(key), key).toBe(true);
    for (const key of ['', '/a', 'a/', 'a//b', './a', 'a/../b', '..', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(1_025), 'é'.repeat(513), 'a\ud800b', 7]) expect(isFileKey(key), JSON.stringify(key)).toBe(false);
  });

  it('refuses bad keys, sizes, metadata, media types and preconditions before calling the backend', async () => {
    const calls: string[] = [];
    const backend: FileBackend = { ...memoryFiles(), put: async () => { calls.push('put'); return { etag: '"x"' }; } };
    const store = createFileStore(backend, { maxFileBytes: 8 });
    expect(await code(store.put('../x', text('a')))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('123456789')))).toBe('LIMIT_EXCEEDED');
    expect(await code(store.put('a', text('a'), { metadata: { Bad: 'x' } }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a'), { metadata: { ok: 'line\nbreak' } }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a'), { metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, 'v'])) }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a'), { contentType: 'text/html\r\nx-injected: 1' }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a'), { ifMatch: '"e"', ifNoneMatch: '*' }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a'), { ifNoneMatch: 'etag' as '*' }))).toBe('INVALID_INPUT');
    expect(await code(store.get('a', { range: { offset: -1 } }))).toBe('INVALID_INPUT');
    expect(await code(store.list({ limit: 1_001 }))).toBe('INVALID_INPUT');
    expect(calls).toEqual([]);
    expect(() => createFileStore(memoryFiles(), { maxFileBytes: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createFileStore({} as FileBackend, { maxFileBytes: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses preconditions a backend cannot keep, rather than ignore them', async () => {
    const store = createFileStore({ ...memoryFiles(), conditionalWrites: false, conditionalDelete: false }, { maxFileBytes: 64 });
    expect(store.conditionalWrites).toBe(false);
    expect(await code(store.put('a', text('a'), { ifNoneMatch: '*' }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a'), { ifMatch: '"m1"' }))).toBe('INVALID_INPUT');
    expect(await code(store.get('a', { ifMatch: '"m1"' }))).toBe('INVALID_INPUT');
    expect(await code(store.delete('a', { ifMatch: '"m1"' }))).toBe('INVALID_INPUT');
    expect(await code(store.put('a', text('a')))).toBe('resolved');
  });

  it('keeps a prefix view from reaching outside it', async () => {
    const backend = memoryFiles(); const root = createFileStore(backend, { maxFileBytes: 64 });
    await root.put('secret.txt', text('s'));
    const tenant = createFileStore(backend, { maxFileBytes: 64, prefix: 'tenants/acme' });
    await tenant.put('notes.txt', text('n'));
    expect(await root.head('tenants/acme/notes.txt')).toMatchObject({ key: 'tenants/acme/notes.txt' });
    expect((await tenant.list()).files.map(file => file.key)).toEqual(['notes.txt']);
    expect(await code(tenant.get('../secret.txt'))).toBe('INVALID_INPUT');
    expect(await tenant.get('secret.txt')).toBeUndefined();
    expect(() => tenant.within('..')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('refuses what a backend returns when it is not what was asked for', async () => {
    const stray: FileBackend = { ...memoryFiles(), list: async () => ({ files: [{ key: 'elsewhere/x', size: 1, etag: '"e"' }] }),
      get: async key => ({ key, size: 3, etag: '"e"', data: text('toolong') }), head: async () => ({ key: 'other', size: 1, etag: '"e"' }) };
    const store = createFileStore(stray, { maxFileBytes: 64, prefix: 'mine' });
    await expect(store.list()).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(store.get('x')).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(store.head('x')).rejects.toMatchObject({ reason: 'invalid_response' });
    const huge: FileBackend = { ...memoryFiles(), get: async key => ({ key, size: 100, etag: '"e"', data: new Uint8Array(100) }) };
    expect(await code(createFileStore(huge, { maxFileBytes: 64 }).get('x'))).toBe('LIMIT_EXCEEDED');
  });

  it('copies what it writes, so changing the buffer afterwards changes nothing', async () => {
    const store = memoryStore(); const data = text('abc');
    const pending = store.put('a', data); data[0] = 0x7a; await pending;
    expect(new TextDecoder().decode((await store.get('a'))!.data)).toBe('abc');
  });

  it('stops at its timeout and when cancelled, and maps unknown backend errors without their text', async () => {
    const hang: FileBackend = { ...memoryFiles(), get: (_key, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) };
    await expect(createFileStore(hang, { maxFileBytes: 8, timeoutMs: 30 }).get('a')).rejects.toMatchObject({ reason: 'timeout' });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    expect(await code(createFileStore(hang, { maxFileBytes: 8 }).get('a', { signal: controller.signal }))).toBe('CANCELLED');
    const broken: FileBackend = { ...memoryFiles(), head: async () => { throw new Error('SECRET internal detail'); } };
    const error = await createFileStore(broken, { maxFileBytes: 8 }).head('a').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FileStoreError); expect(JSON.stringify(error)).not.toContain('SECRET'); expect((error as Error).message).not.toContain('SECRET');
  });

  it('orders keys by code point, as object stores list them', () => {
    expect(['b', '😀', 'a/b', '￿', 'a'].sort(compareFileKeys)).toEqual(['a', 'a/b', 'b', '￿', '😀']);
  });
});

describe('fileTools', () => {
  const setup = async (options: Partial<Parameters<typeof fileTools>[1]> = {}, store: FileStore = memoryStore()) => {
    await store.put('docs/readme.md', text('# Hello'), { contentType: 'text/markdown' });
    await store.put('docs/logo.bin', new Uint8Array([0xff, 0x00, 0xfe]));
    const tools = fileTools(store, { name: 'workspace', ...options });
    return { store, tools: Object.fromEntries(tools.map(tool => [tool.id.split('.')[1]!, tool])) };
  };

  it('reads text as text and other bytes as base64, only with files:<name>:read', async () => {
    const { tools } = await setup();
    expect(Object.keys(tools).sort()).toEqual(['list', 'read']);
    expect(tools['read']!.capabilities).toEqual(['files:workspace:read']); expect(tools['read']!.effects).toBe('read');
    expect(output(await testTool(tools['read']!, { path: 'docs/readme.md' }))).toMatchObject({ found: true, text: '# Hello', size: 7 });
    expect(output(await testTool(tools['read']!, { path: 'docs/logo.bin' }))).toMatchObject({ found: true, base64: '/wD+' });
    expect(output(await testTool(tools['read']!, { path: 'nothing.txt' }))).toEqual({ path: 'nothing.txt', found: false });
    const denied = await testTool(tools['read']!, { path: 'docs/readme.md' }, { permissions: toolGrants(tools['read']!).filter(grant => !grant.startsWith('files:')) });
    expect(denied.outcome.status).not.toBe('succeeded');
    expect(output(await testTool(tools['list']!, { prefix: 'docs/' })).files).toHaveLength(2);
  });

  it('reads large files in parts', async () => {
    const store = memoryStore(); await store.put('big.txt', text('abcdefghij'));
    const [read] = fileTools(store, { name: 'ws', maxReadBytes: 4 });
    expect(output(await testTool(read!, { path: 'big.txt' }))).toMatchObject({ text: 'abcd', offset: 0, nextOffset: 4, size: 10 });
    expect(output(await testTool(read!, { path: 'big.txt', offset: 8 }))).toMatchObject({ text: 'ij', offset: 8 });
    expect(output(await testTool(read!, { path: 'big.txt', offset: 8 }))).not.toHaveProperty('nextOffset');
  });

  it('creates files only when absent unless overwriting is allowed, only with files:<name>:write', async () => {
    const { store, tools } = await setup({ write: true });
    expect(tools['write']!.capabilities).toEqual(['files:workspace:write']); expect(tools['write']!.effects).toBe('write');
    expect((await testTool(tools['write']!, { path: 'notes/today.md', text: 'hi' })).outcome.status).toBe('succeeded');
    expect(new TextDecoder().decode((await store.get('notes/today.md'))!.data)).toBe('hi');
    expect((await testTool(tools['write']!, { path: 'notes/today.md', text: 'replaced' })).outcome.status).not.toBe('succeeded');
    expect(new TextDecoder().decode((await store.get('notes/today.md'))!.data)).toBe('hi');
    const denied = await testTool(tools['write']!, { path: 'x.md', text: 'x' }, { permissions: toolGrants(tools['write']!).filter(grant => !grant.startsWith('files:')) });
    expect(denied.outcome.status).not.toBe('succeeded'); expect(await store.head('x.md')).toBeUndefined();
    expect((await testTool(tools['write']!, { path: 'both.md', text: 'x', base64: 'eA==' })).outcome.status).not.toBe('succeeded');
    expect((await testTool(tools['delete']!, { path: 'notes/today.md' })).outcome.status).toBe('succeeded');
    expect(await store.head('notes/today.md')).toBeUndefined();
  });

  it('replaces files when allowed, guarded by the etag when given', async () => {
    const { store, tools } = await setup({ write: true, overwrite: true });
    const etag = (await store.head('docs/readme.md'))!.etag;
    expect((await testTool(tools['write']!, { path: 'docs/readme.md', text: 'v2', ifMatch: etag })).outcome.status).toBe('succeeded');
    expect((await testTool(tools['write']!, { path: 'docs/readme.md', text: 'v3', ifMatch: etag })).outcome.status).not.toBe('succeeded');
    expect(new TextDecoder().decode((await store.get('docs/readme.md'))!.data)).toBe('v2');
  });

  it('refuses writes past maxWriteBytes, and configurations that cannot be kept', async () => {
    const { tools } = await setup({ write: true, maxWriteBytes: 4 });
    expect((await testTool(tools['write']!, { path: 'big.txt', text: 'too long' })).outcome.status).not.toBe('succeeded');
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => fileTools(memoryStore(), { name: 'Bad Name' })).toThrow(invalid);
    expect(() => fileTools(memoryStore(), { name: 'ws', overwrite: true })).toThrow(invalid);
    expect(() => fileTools(memoryStore(64), { name: 'ws', maxReadBytes: 65 })).toThrow(invalid);
    const plain = createFileStore({ ...memoryFiles(), conditionalWrites: false }, { maxFileBytes: 64 });
    expect(() => fileTools(plain, { name: 'ws', write: true })).toThrow(invalid);
    expect(fileTools(plain, { name: 'ws', write: true, overwrite: true })).toHaveLength(4);
  });
});

describe('FileStoreError', () => {
  it('has fixed messages and known reasons only', () => {
    expect(new FileStoreError('rate_limited', 429)).toMatchObject({ code: 'STORAGE_UNAVAILABLE', reason: 'rate_limited', httpStatus: 429 });
    expect(() => new FileStoreError('other' as 'rejected')).toThrow(MayuraError);
  });
});
