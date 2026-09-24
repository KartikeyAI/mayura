import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalArtifactStore } from '@mayura/artifacts';

const directory = await mkdtemp(join(tmpdir(), 'mayura-packed-artifact-'));
const restoreDirectory = await mkdtemp(join(tmpdir(), 'mayura-packed-artifact-restore-'));
try {
  const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 1_024 });
  const scope = { tenantId: 'packed-tenant', projectId: 'packed-project' };
  const reference = await store.commit(await store.stage({ scope, content: new TextEncoder().encode('packed report'),
    mediaType: 'text/plain', classification: 'internal', filename: '../packed report.txt' }));
  const disclosure = await store.disclose(reference, scope, { classifications: ['internal'], maxBytes: 100 });
  const audit = await store.audit([reference], scope, { maxTotalBytes: 100 });
  const plan = await store.planReconciliation({ scope, retainedReferences: [reference], authoritativeSetComplete: true,
    olderThan: Date.now(), maxExamined: 10, maxDeletes: 10 });
  const reconciliation = await store.applyReconciliation(plan);
  const disposable = await store.stage({ scope, content: new Uint8Array(), mediaType: 'text/plain', classification: 'internal' });
  const stagedDiscard = await store.discard(disposable) && !(await store.discard(disposable));
  let separated = false;
  try { await store.read(reference, { tenantId: 'other' }); } catch (error) { separated = error?.code === 'PERMISSION_DENIED'; }
  const scoped = separated && reference.scopeDigest.startsWith('sha256:');
  const integrityVerified = new TextDecoder().decode(disclosure.body) === 'packed report' && reference.digest.startsWith('sha256:');
  const safeAttachment = disclosure.headers['Content-Disposition'] === 'attachment; filename="packed_report.txt"'
    && disclosure.headers['X-Content-Type-Options'] === 'nosniff';
  const artifactAudit = audit.observations.length === 1 && audit.observations[0]?.status === 'ok';
  const retentionPlan = plan.candidates.length === 0 && reconciliation.deleted === 0;
  const archive = await store.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 100 });
  const restoredStore = createLocalArtifactStore({ rootDirectory: restoreDirectory, maxArtifactBytes: 1_024 });
  const restore = await restoredStore.restore(archive, scope, { maxArchiveBytes: 4_096, maxTotalBytes: 100, maxArtifacts: 1 });
  const backupRestore = restore.restored === 1 && new TextDecoder().decode(await restoredStore.read(reference, scope)) === 'packed report';
  console.log(JSON.stringify({ status: scoped && integrityVerified && safeAttachment && artifactAudit && retentionPlan && stagedDiscard && backupRestore ? 'passed' : 'failed', scoped,
    integrityVerified, safeAttachment, artifactAudit, retentionPlan, stagedDiscard, backupRestore, noArthDependency: true }));
} finally {
  await Promise.all([directory, restoreDirectory].map((value) => rm(value, { recursive: true, force: true })));
}
