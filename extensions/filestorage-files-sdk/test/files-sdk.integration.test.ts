// The file store contract through Files SDK's own S3 implementation (its RustFS adapter over fetch), against a real
// S3-compatible server named by MAYURA_TEST_S3_URL; see packages/files/test/s3.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { filesSdkFiles, type FilesSdkLike } from '../src/index.js';
import { s3TestBucket } from '../../../packages/files/test/s3-bucket.js';

const configured = process.env['MAYURA_TEST_S3_URL'];
const filesModule = 'files-sdk'; const rustfsModule = 'files-sdk/rustfs';

describe.skipIf(!configured)('@mayurajs/filestorage-files-sdk through Files SDK\'s RustFS adapter', async () => {
  const { endpoint, bucket, credentials } = configured ? await s3TestBucket(configured, 'mayura-files-sdk') : { endpoint: 'http://127.0.0.1:9', bucket: 'unconfigured', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } };
  const { Files } = await import(filesModule) as { Files: new (options: { adapter: unknown }) => FilesSdkLike };
  const { rustfs } = await import(rustfsModule) as { rustfs: (options: object) => unknown };
  const files = new Files({ adapter: rustfs({ bucket, endpoint, ...credentials, region: 'us-east-1', forcePathStyle: true, client: 'fetch' }) });
  const store = createFileStore(filesSdkFiles({ files }), { maxFileBytes: 4 * 1_048_576 });
  for (const test of fileStoreConformance) it(test.name, async () => {
    const result = await test.run({ store });
    // Whatever Files SDK declares for this adapter decides the precondition cases; everything else must pass.
    if (/ifMatch|ifNoneMatch/u.test(test.name)) expect(['passed', 'skipped']).toContain(result); else expect(result).toBe('passed');
  });
  it('reports the capabilities Files SDK declares for the adapter', () => {
    expect(store.conditionalWrites).toBe(files.capabilities.conditional.create && files.capabilities.conditional.replace && files.capabilities.conditional.exactRead);
    expect(store.conditionalDelete).toBe(files.capabilities.conditional.delete);
  });
});
