// The file store contract against fake-gcs-server, an independent emulator of the Cloud Storage JSON API. Set
// MAYURA_TEST_GCS_URL to it:
//   docker run -d -p 127.0.0.1:14443:4443 fsouza/fake-gcs-server -scheme http -port 4443 -public-host 127.0.0.1:14443
//   MAYURA_TEST_GCS_URL=http://127.0.0.1:14443
// Each run creates its own bucket.
import { describe, expect, it } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { gcsFiles } from '../src/index.js';

const configured = process.env['MAYURA_TEST_GCS_URL'];

describe.skipIf(!configured)('@mayurajs/filestorage-gcs against fake-gcs-server', async () => {
  const endpoint = configured ?? 'http://127.0.0.1:9';
  const bucket = `mayura-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (configured) {
    const response = await fetch(`${endpoint}/storage/v1/b?project=mayura-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: bucket }) });
    if (!response.ok) throw new Error(`Creating the test bucket failed with HTTP ${response.status}.`);
  }
  const store = createFileStore(gcsFiles({ bucket, token: () => 'emulator-token', endpoint }), { maxFileBytes: 4 * 1_048_576 });
  // fake-gcs-server applies ifGenerationMatch to uploads but not to deletes (Cloud Storage applies it to both).
  const skip = { 'deletes only the version given with ifMatch': 'fake-gcs-server ignores ifGenerationMatch on deletes' };
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store, skip })).toBe(test.name in skip ? 'skipped' : 'passed'); });
});
