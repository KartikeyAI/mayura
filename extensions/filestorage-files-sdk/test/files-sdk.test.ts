import { describe, expect, it } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { filesSdkFiles, type FilesSdkLike } from '../src/index.js';

/** Files SDK, loaded from the development dependency: the tests use its own clients and adapters. */
const filesModule = 'files-sdk'; const memoryModule = 'files-sdk/memory';
async function memoryFiles(): Promise<FilesSdkLike> {
  const { Files } = await import(filesModule) as { Files: new (options: { adapter: unknown }) => FilesSdkLike };
  const { memory } = await import(memoryModule) as { memory: () => unknown };
  return new Files({ adapter: memory() });
}

describe('@mayurajs/filestorage-files-sdk keeps the file store contract over Files SDK\'s memory adapter', async () => {
  const store = createFileStore(filesSdkFiles({ files: await memoryFiles() }), { maxFileBytes: 1_048_576 });
  // Files SDK's memory adapter has no native conditional operations, so the precondition cases report themselves skipped.
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store })).toBe(/ifMatch|ifNoneMatch/u.test(test.name) ? 'skipped' : 'passed'); });
});

describe('@mayurajs/filestorage-files-sdk', () => {
  type Capabilities = FilesSdkLike['capabilities'];
  const fake = (capabilities: { rangeRead?: boolean; metadata?: boolean; conditional?: Partial<Capabilities['conditional']> }, overrides: Partial<FilesSdkLike> = {}): FilesSdkLike => ({
    capabilities: { rangeRead: false, metadata: false, ...capabilities, conditional: { create: false, replace: false, exactRead: false, delete: false, ...capabilities.conditional } },
    upload: async () => ({ etag: '"e"' }), head: async key => ({ key, size: 1, etag: '"e"', arrayBuffer: async () => new ArrayBuffer(1) }),
    download: async key => ({ key, size: 1, etag: '"e"', arrayBuffer: async () => new ArrayBuffer(1) }), delete: async () => undefined, list: async () => ({ items: [] }), ...overrides,
  });

  it('keeps preconditions and metadata only where the provider has them', async () => {
    const plain = createFileStore(filesSdkFiles({ files: fake({}) }), { maxFileBytes: 64 });
    expect([plain.conditionalWrites, plain.conditionalDelete]).toEqual([false, false]);
    await expect(plain.put('a', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(plain.put('a', new Uint8Array(1), { metadata: { owner: 'acme' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const partial = createFileStore(filesSdkFiles({ files: fake({ conditional: { create: true, replace: true } }) }), { maxFileBytes: 64 });
    expect(partial.conditionalWrites).toBe(false);
    const full = createFileStore(filesSdkFiles({ files: fake({ metadata: true, conditional: { create: true, replace: true, exactRead: true, delete: true } }) }), { maxFileBytes: 64 });
    expect([full.conditionalWrites, full.conditionalDelete]).toEqual([true, true]);
  });

  it('passes preconditions to a provider that has them, and reads its Conflict as CONFLICT', async () => {
    const seen: unknown[] = [];
    const conflict = () => Object.assign(new Error('SECRET'), { code: 'Conflict' });
    const conditional = fake({ conditional: { create: true, replace: true, exactRead: true, delete: true } }, {
      upload: async (_key, _body, options) => { seen.push(options?.condition); if (options?.condition?.type === 'replace' && options.condition.etag !== '"e"') throw conflict(); return { etag: '"e2"' }; },
      delete: async (_key, options) => { seen.push(options?.condition); throw conflict(); },
      download: async (key, options) => { seen.push(options?.condition); return { key, size: 1, etag: '"e"', arrayBuffer: async () => new ArrayBuffer(1) }; },
    });
    const store = createFileStore(filesSdkFiles({ files: conditional }), { maxFileBytes: 64 });
    await store.put('a', new Uint8Array(1), { ifNoneMatch: '*' });
    await store.put('a', new Uint8Array(1), { ifMatch: '"e"' });
    await expect(store.put('a', new Uint8Array(1), { ifMatch: '"stale"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.get('a', { ifMatch: '"e"' });
    await expect(store.delete('a', { ifMatch: '"e"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(seen).toEqual([{ type: 'create' }, { type: 'replace', etag: '"e"' }, { type: 'replace', etag: '"stale"' }, { etag: '"e"' }, { etag: '"e"' }]);
  });

  it('reads a range from the whole file where the provider has no ranged reads, within the limit', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    const whole = fake({}, { head: async key => ({ key, size: 10, etag: '"e"', arrayBuffer: async () => bytes.buffer }), download: async key => ({ key, size: 10, etag: '"e"', arrayBuffer: async () => bytes.slice().buffer }) });
    const store = createFileStore(filesSdkFiles({ files: whole }), { maxFileBytes: 64 });
    expect(new TextDecoder().decode((await store.get('a', { range: { offset: 2, length: 3 } }))!.data)).toBe('234');
    await expect(createFileStore(filesSdkFiles({ files: whole }), { maxFileBytes: 8 }).get('a', { range: { offset: 0, length: 2 } })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('maps Files SDK errors to the store\'s without their messages', async () => {
    const thrower = (code: string, extra: object = {}) => fake({}, { head: async () => { throw Object.assign(new Error(`SECRET ${code}`), { code, ...extra }); } });
    for (const [code, expected] of [['Unauthorized', { reason: 'authentication' }], ['Provider', { reason: 'unavailable' }], ['ReadOnly', { reason: 'rejected' }]] as const) {
      const caught = await createFileStore(filesSdkFiles({ files: thrower(code) }), { maxFileBytes: 64 }).head('a').catch((thrown: unknown) => thrown);
      expect(caught).toMatchObject(expected); expect(JSON.stringify(caught)).not.toContain('SECRET'); expect((caught as Error).message).not.toContain('SECRET');
    }
    expect(await createFileStore(filesSdkFiles({ files: thrower('NotFound') }), { maxFileBytes: 64 }).head('a')).toBeUndefined();
    await expect(createFileStore(filesSdkFiles({ files: thrower('Provider', { timedOut: true }) }), { maxFileBytes: 64 }).head('a')).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('needs a Files SDK client', () => {
    expect(() => filesSdkFiles({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => filesSdkFiles({ files: { upload: () => undefined } as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
