// Artifacts in S3: the artifact store over s3Files against a real S3-compatible server (MAYURA_TEST_S3_URL; see
// packages/files/test/s3.integration.test.ts).
import { describe, expect, it } from 'vitest';
import { createFileStore, s3Files } from '@mayura/files';
import { createArtifactStore } from '../src/index.js';
import { s3TestBucket } from '../../files/test/s3-bucket.js';

const configured = process.env['MAYURA_TEST_S3_URL'];
const scope = { principalId: 'tenant-a', projectId: 'project-a' };

describe.skipIf(!configured)('artifacts in S3', async () => {
  const { endpoint, bucket, credentials } = configured ? await s3TestBucket(configured, 'mayura-artifacts') : { endpoint: 'http://127.0.0.1:9', bucket: 'unconfigured', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } };
  const files = createFileStore(s3Files({ bucket, region: 'us-east-1', credentials, endpoint, conditionalDelete: true }), { maxFileBytes: 1_048_576 }).within('artifacts');

  it('commits, reads, deduplicates, discloses, reconciles, backs up and restores', async () => {
    const artifacts = createArtifactStore({ files, maxArtifactBytes: 65_536 });
    const input = { scope, content: new TextEncoder().encode('order,total\nord-1001,42.00\n'), mediaType: 'text/csv', classification: 'internal' as const, filename: 'orders.csv' };
    const reference = await artifacts.commit(await artifacts.stage(input));
    expect(await artifacts.commit(await artifacts.stage(input))).toEqual(reference);
    expect(new TextDecoder().decode(await artifacts.read(reference, scope))).toContain('ord-1001');
    expect((await artifacts.disclose(reference, scope, { classifications: ['internal'], maxBytes: 1_024 })).headers['Content-Disposition']).toBe('attachment; filename="orders.csv"');
    const archive = await artifacts.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 1_024 });
    const stray = await artifacts.commit(await artifacts.stage({ ...input, content: new Uint8Array([1]), filename: 'stray.bin' }));
    const now = Date.now() + 60_000;
    const cleaner = createArtifactStore({ files, maxArtifactBytes: 65_536, clock: () => now });
    const plan = await cleaner.planReconciliation({ scope, retainedReferences: [reference], authoritativeSetComplete: true, olderThan: now - 1, maxExamined: 10, maxDeletes: 10 });
    expect(plan.candidates.map(candidate => candidate.referenceDigest)).toEqual([stray.referenceDigest]);
    expect(await cleaner.applyReconciliation(plan)).toEqual({ deleted: 1, changed: 0, missing: 0 });
    const copy = createArtifactStore({ files: files.within('copy'), maxArtifactBytes: 65_536 });
    expect(await copy.restore(archive, scope, { maxArchiveBytes: 65_536, maxTotalBytes: 1_024, maxArtifacts: 1 })).toMatchObject({ restored: 1 });
    expect(await copy.read(reference, scope)).toEqual(await artifacts.read(reference, scope));
  });
});
