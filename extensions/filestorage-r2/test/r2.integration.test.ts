// The file store contract on Cloudflare's own R2 implementation, locally in Miniflare (workerd), through the same
// binding a Worker gets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileStore, type FileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { r2Files, type R2BucketLike } from '../src/index.js';

/** The part of Miniflare this test uses. Its published declarations are written against zod 3, so it loads untyped. */
interface Miniflare { readonly ready: Promise<URL>; getR2Bucket(name: string): Promise<unknown>; dispose(): Promise<void> }
const miniflareModule = 'miniflare';
let miniflare: Miniflare | undefined; let store: FileStore;
beforeAll(async () => {
  const { Miniflare: create } = await import(miniflareModule) as { Miniflare: new (options: unknown) => Miniflare };
  miniflare = new create({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', r2Buckets: ['FILES'] });
  await miniflare.ready;
  store = createFileStore(r2Files({ bucket: await miniflare.getR2Bucket('FILES') as R2BucketLike }), { maxFileBytes: 1_048_576 });
}, 60_000);
afterAll(async () => { await miniflare?.dispose(); });

describe('@mayurajs/filestorage-r2 on R2 in Miniflare', () => {
  for (const test of fileStoreConformance) it(test.name, async () => {
    expect(await test.run({ store })).toBe(test.name.startsWith('deletes only the version') ? 'skipped' : 'passed');
  });
});
