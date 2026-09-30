import { describe, expect, it } from 'vitest';
import { createFileStore } from 'mayura/files';
import { r2Files, type R2BucketLike, type R2ObjectLike } from '../src/index.js';

const object = (key: string, size = 1): R2ObjectLike => ({ key, size, etag: 'abc', httpEtag: '"abc"', uploaded: new Date(0) });
const bucket = (overrides: Partial<R2BucketLike>): R2BucketLike => ({
  head: async () => null, get: async () => null, put: async key => object(key), delete: async () => undefined,
  list: async () => ({ objects: [], truncated: false }), ...overrides,
});

describe('@mayurajs/filestorage-r2', () => {
  it('passes R2 its bare etag, and reads a null answer to a precondition as CONFLICT', async () => {
    const seen: unknown[] = [];
    const store = createFileStore(r2Files({ bucket: bucket({ put: async (_key, _value, options) => { seen.push(options?.onlyIf); return null; } }) }), { maxFileBytes: 64 });
    await expect(store.put('a', new Uint8Array(1), { ifMatch: '"abc"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.put('a', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(seen).toEqual([{ etagMatches: 'abc' }, { etagDoesNotMatch: '*' }]);
    await expect(store.put('a', new Uint8Array(1))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('declares no conditional delete, so one is refused before reaching the binding', async () => {
    let deleted = 0;
    const store = createFileStore(r2Files({ bucket: bucket({ delete: async () => { deleted++; } }) }), { maxFileBytes: 64 });
    expect(store.conditionalDelete).toBe(false);
    await expect(store.delete('a', { ifMatch: '"abc"' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(deleted).toBe(0);
  });

  it('refuses a body over the limit before reading it, and stops when cancelled', async () => {
    let read = false;
    const big = { ...object('a', 1_000), body: new ReadableStream(), arrayBuffer: async () => { read = true; return new ArrayBuffer(1_000); } };
    await expect(createFileStore(r2Files({ bucket: bucket({ get: async () => big }) }), { maxFileBytes: 64 }).get('a')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(read).toBe(false);
    const hanging = createFileStore(r2Files({ bucket: bucket({ head: () => new Promise(() => undefined) }) }), { maxFileBytes: 64 });
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    await expect(hanging.head('a', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('needs a bucket binding', () => {
    expect(() => r2Files({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => r2Files({ bucket: { head: () => null } as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
