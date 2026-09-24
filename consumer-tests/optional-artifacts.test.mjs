import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalArtifactStore } from '@mayura/artifacts';

const directory = await mkdtemp(join(tmpdir(), 'mayura-packed-artifact-'));
try {
  const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 1_024 });
  const scope = { tenantId: 'packed-tenant', projectId: 'packed-project' };
  const reference = await store.commit(await store.stage({ scope, content: new TextEncoder().encode('packed report'),
    mediaType: 'text/plain', classification: 'internal', filename: '../packed report.txt' }));
  const disclosure = await store.disclose(reference, scope, { classifications: ['internal'], maxBytes: 100 });
  let separated = false;
  try { await store.read(reference, { tenantId: 'other' }); } catch (error) { separated = error?.code === 'PERMISSION_DENIED'; }
  const scoped = separated && reference.scopeDigest.startsWith('sha256:');
  const integrityVerified = new TextDecoder().decode(disclosure.body) === 'packed report' && reference.digest.startsWith('sha256:');
  const safeAttachment = disclosure.headers['Content-Disposition'] === 'attachment; filename="packed_report.txt"'
    && disclosure.headers['X-Content-Type-Options'] === 'nosniff';
  console.log(JSON.stringify({ status: scoped && integrityVerified && safeAttachment ? 'passed' : 'failed', scoped,
    integrityVerified, safeAttachment, noArthDependency: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
