// The file store contract against a real S3-compatible server. Set MAYURA_TEST_S3_URL to a disposable one, with its
// access key and secret as the URL's user and password, for example RustFS:
//   docker run -d -p 127.0.0.1:19000:9000 -e RUSTFS_ACCESS_KEY=mayuratest -e RUSTFS_SECRET_KEY=mayuratest-secret-key rustfs/rustfs
//   MAYURA_TEST_S3_URL=http://mayuratest:mayuratest-secret-key@127.0.0.1:19000
// Each run creates its own bucket.
import { describe, expect, it } from 'vitest';
import { createFileStore, s3Files } from '@mayura/files';
import { fileStoreConformance } from '../../testing/src/index.js';
import { s3TestBucket } from './s3-bucket.js';

const configured = process.env['MAYURA_TEST_S3_URL'];

describe.skipIf(!configured)('s3Files against a real S3-compatible server', async () => {
  const { endpoint, bucket, credentials } = configured ? await s3TestBucket(configured, 'mayura-files') : { endpoint: 'http://127.0.0.1:9', bucket: 'unconfigured', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } };
  const store = createFileStore(s3Files({ bucket, region: 'us-east-1', credentials, endpoint, conditionalDelete: true }), { maxFileBytes: 8 * 1_048_576 });
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store })).toBe('passed'); });

  it('refuses requests signed with the wrong secret', async () => {
    const wrong = createFileStore(s3Files({ bucket, region: 'us-east-1', credentials: { ...credentials, secretAccessKey: 'not-the-secret' }, endpoint }), { maxFileBytes: 1_024 });
    await expect(wrong.head('anything')).rejects.toMatchObject({ reason: 'authentication' });
  });

  it('reads a large file whole and in ranges', async () => {
    const data = new Uint8Array(3 * 1_048_576).map((_, index) => (index * 31) % 251);
    await store.put('large.bin', data);
    const whole = await store.get('large.bin');
    expect(whole?.data.byteLength).toBe(data.byteLength); expect(whole?.data.every((byte, index) => byte === data[index])).toBe(true);
    const part = await store.get('large.bin', { range: { offset: 1_048_576, length: 10 } });
    expect([...part!.data]).toEqual([...data.subarray(1_048_576, 1_048_586)]);
    await expect(createFileStore(s3Files({ bucket, region: 'us-east-1', credentials, endpoint }), { maxFileBytes: 1_048_576 }).get('large.bin')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
