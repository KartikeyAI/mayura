import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalArtifactStore, type ArtifactReconciliationCursor, type ArtifactReconciliationPlan,
  type ArtifactReference, type ArtifactScope } from '../src/index.js';

const roots: string[] = [];
const scope = Object.freeze({ tenantId: 'tenant-a', projectId: 'project-a' });

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'mayura-artifact-'));
  roots.push(value);
  return value;
}

function storedPath(directory: string, reference: ArtifactReference): string {
  return join(directory, 'objects', reference.scopeDigest.slice(7), reference.referenceDigest.slice(7, 9), reference.referenceDigest.slice(7));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('local artifact store', () => {
  it('promotes immutable content and deduplicates the same scoped bytes', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 1_024 });
    const input = { scope, content: new TextEncoder().encode('report'), mediaType: 'text/plain', classification: 'internal' as const, filename: 'report.txt' };
    const first = await store.commit(await store.stage(input));
    const second = await store.commit(await store.stage(input));
    expect(second).toEqual(first);
    expect(new TextDecoder().decode(await store.read(first, scope))).toBe('report');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('partitions identical content by verified scope', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const bytes = new Uint8Array([1, 2, 3]);
    const first = await store.commit(await store.stage({ scope, content: bytes, mediaType: 'application/octet-stream', classification: 'confidential' }));
    const otherScope = { tenantId: 'tenant-b', projectId: 'project-a' };
    const second = await store.commit(await store.stage({ scope: otherScope, content: bytes, mediaType: 'application/octet-stream', classification: 'confidential' }));
    expect(second.digest).toBe(first.digest);
    expect(second.scopeDigest).not.toBe(first.scopeDigest);
    await expect(store.read(first, otherScope)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('revalidates content identity and fails closed after tampering', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream', classification: 'restricted' }));
    const path = storedPath(directory, reference);
    await writeFile(path, new Uint8Array([3, 2, 1]));
    await expect(store.read(reference, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('revalidates staged bytes immediately before promotion', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100 });
    const staged = await store.stage({ scope, content: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream', classification: 'restricted' });
    await writeFile(join(directory, 'staging', `${staged.stageId}.stage`), new Uint8Array([3, 2, 1]));
    await expect(store.commit(staged)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('binds classification and disclosure metadata to the committed reference', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'restricted' }));
    await expect(store.read({ ...reference, classification: 'public' }, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    await expect(store.read({ ...reference, mediaType: 'application/pdf' }, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('rejects missing, expired and oversized references without releasing bytes', async () => {
    let now = 1_000;
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 4, clock: () => now });
    await expect(store.stage({ scope, content: new Uint8Array(5), mediaType: 'text/plain', classification: 'public' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'public', expiresAt: 2_000 }));
    now = 2_000;
    await expect(store.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const freshStore = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 4, clock: () => 1_000 });
    await expect(freshStore.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns a bounded attachment with a sanitized filename', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage({
      scope, content: new TextEncoder().encode('safe'), mediaType: 'TEXT/PLAIN', classification: 'internal', filename: '../../quarter "one".txt',
    }));
    const disclosure = await store.disclose(reference, scope, { classifications: ['internal'], maxBytes: 10, mediaTypes: ['text/plain'] });
    expect(new TextDecoder().decode(disclosure.body)).toBe('safe');
    expect(disclosure.headers).toEqual({
      'Content-Disposition': 'attachment; filename="quarter_one_.txt"',
      'Content-Length': '4',
      'Content-Type': 'text/plain',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('blocks active markup, disallowed classifications, media types and response sizes', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 1_000 });
    const html = await store.commit(await store.stage({ scope, content: new TextEncoder().encode('<script>'), mediaType: 'text/html', classification: 'public' }));
    await expect(store.disclose(html, scope, { classifications: ['public'], maxBytes: 100 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const text = await store.commit(await store.stage({ scope, content: new TextEncoder().encode('private'), mediaType: 'text/plain', classification: 'confidential' }));
    await expect(store.disclose(text, scope, { classifications: ['public'], maxBytes: 100 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(store.disclose(text, scope, { classifications: ['confidential'], maxBytes: 100, mediaTypes: ['application/pdf'] })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(store.disclose(text, scope, { classifications: ['confidential'], maxBytes: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects forged handles, extended references and accessors without invoking them', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    await expect(store.commit({ format: 'mayura-staged-artifact-v1', stageId: crypto.randomUUID(), digest: `sha256:${'a'.repeat(64)}`, bytes: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array(), mediaType: 'text/plain', classification: 'public' }));
    await expect(store.read({ ...reference, extra: true } as unknown as ArtifactReference, scope)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    let invoked = false;
    const hostileScope = Object.defineProperty({ tenantId: 'tenant-a' }, 'projectId', { enumerable: true, get: () => { invoked = true; return 'project-a'; } });
    await expect(store.read(reference, hostileScope as ArtifactScope)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(invoked).toBe(false);
  });

  it('deletes only an exact scoped object and reports absence idempotently', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array([1]), mediaType: 'application/octet-stream', classification: 'restricted' }));
    await expect(store.delete(reference, { tenantId: 'other' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await store.delete(reference, scope)).toBe(true);
    expect(await store.delete(reference, scope)).toBe(false);
  });

  it('removes only bounded inactive staging files', async () => {
    const directory = await root();
    const first = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100 });
    const staged = await first.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' });
    const second = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100, clock: () => Date.now() + 10_000 });
    expect(await second.reconcileStaging({ olderThan: Date.now() + 5_000, maxDeletes: 1 })).toEqual({ examined: 1, deleted: 1, remaining: false });
    await expect(first.commit(staged)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    await writeFile(join(directory, 'staging', 'not-owned.txt'), 'leave');
    await second.reconcileStaging({ olderThan: Date.now() + 5_000, maxDeletes: 1 });
    expect(await readFile(join(directory, 'staging', 'not-owned.txt'), 'utf8')).toBe('leave');
  });

  it('bounds staged population and rejects shared mutable input', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100, maxStagedArtifacts: 1 });
    const input = { scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' as const };
    const first = await store.stage(input);
    await expect(store.stage(input)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await store.commit(first);
    const second = await store.stage(input);
    expect(second).toMatchObject({ format: 'mayura-staged-artifact-v1' });
    await store.commit(second);
    if (typeof SharedArrayBuffer !== 'undefined') {
      await expect(store.stage({ ...input, content: new Uint8Array(new SharedArrayBuffer(1)) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('audits available, missing, expired and corrupt objects without returning content', async () => {
    const directory = await root(); let now = Date.now() + 10_000;
    const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100, clock: () => now });
    const make = async (value: number, expiresAt?: number) => store.commit(await store.stage({ scope, content: new Uint8Array([value]),
      mediaType: 'application/octet-stream', classification: 'internal', ...(expiresAt === undefined ? {} : { expiresAt }) }));
    const ok = await make(1); const missing = await make(2); const expired = await make(3, now + 1_000); const corrupt = await make(4);
    await store.delete(missing, scope); await writeFile(storedPath(directory, corrupt), new Uint8Array([9])); now += 2_000;
    const result = await store.audit([ok, missing, expired, corrupt], scope, { maxTotalBytes: 4 });
    expect(result).toEqual({ admittedBytes: 4, observations: [
      { referenceDigest: ok.referenceDigest, status: 'ok' },
      { referenceDigest: missing.referenceDigest, status: 'missing' },
      { referenceDigest: expired.referenceDigest, status: 'expired' },
      { referenceDigest: corrupt.referenceDigest, status: 'integrity_failed' },
    ] });
    expect('body' in result).toBe(false); expect(Object.isFrozen(result.observations)).toBe(true);
  });

  it('prevalidates the complete audit set and its cumulative byte budget', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array([1, 2]), mediaType: 'text/plain', classification: 'internal' }));
    await expect(store.audit([reference, reference], scope, { maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.audit([reference], scope, { maxTotalBytes: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(store.audit([reference], { tenantId: 'other' }, { maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    let invoked = false; const hostile = [reference];
    Object.defineProperty(hostile, '0', { enumerable: true, get: () => { invoked = true; return reference; } });
    await expect(store.audit(hostile, scope, { maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(invoked).toBe(false);
  });

  it('plans finite committed-object cleanup and deletes only unretained objects', async () => {
    const directory = await root(); const now = Date.now() + 10_000;
    const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100, clock: () => now });
    const references: ArtifactReference[] = [];
    for (let value = 1; value <= 5; value++) references.push(await store.commit(await store.stage({ scope,
      content: new Uint8Array([value]), mediaType: 'application/octet-stream', classification: 'internal', filename: `${value}.bin` })));
    const retained = [references[1]!, references[3]!]; const planned: ArtifactReconciliationPlan[] = []; let cursor: ArtifactReconciliationCursor | undefined;
    do {
      const plan = await store.planReconciliation({ scope, retainedReferences: retained, authoritativeSetComplete: true,
        olderThan: now - 1, maxExamined: 2, maxDeletes: 2, ...(cursor === undefined ? {} : { cursor }) });
      planned.push(plan); cursor = plan.nextCursor;
    } while (cursor !== undefined);
    expect(new Set(planned.flatMap((plan) => plan.candidates.map((candidate) => candidate.referenceDigest))))
      .toEqual(new Set(references.filter((reference) => !retained.includes(reference)).map((reference) => reference.referenceDigest)));
    let deleted = 0;
    for (const plan of planned) deleted += (await store.applyReconciliation(plan)).deleted;
    expect(deleted).toBe(3);
    for (const reference of retained) await expect(store.read(reference, scope)).resolves.toHaveLength(1);
    for (const reference of references.filter((item) => !retained.includes(item))) await expect(store.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('consumes plans once and rejects plans or cursors from another authority', async () => {
    const now = Date.now() + 10_000;
    const first = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100, clock: () => now });
    const second = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100 });
    const reference = await first.commit(await first.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' }));
    const plan = await first.planReconciliation({ scope, retainedReferences: [], authoritativeSetComplete: true,
      olderThan: now - 1, maxExamined: 1, maxDeletes: 1 });
    await expect(second.applyReconciliation(plan)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(first.applyReconciliation(plan)).resolves.toEqual({ deleted: 1, changed: 0, missing: 0 });
    await expect(first.applyReconciliation(plan)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const wrongCursor = { format: 'mayura-artifact-reconciliation-cursor-v1', scopeDigest: reference.scopeDigest,
      after: reference.referenceDigest } as const;
    await expect(first.planReconciliation({ scope: { tenantId: 'other' }, retainedReferences: [], authoritativeSetComplete: true,
      olderThan: Date.now(), maxExamined: 1, maxDeletes: 1, cursor: wrongCursor })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('skips a candidate changed after planning and reports a disappeared candidate', async () => {
    const directory = await root(); const now = Date.now() + 10_000;
    const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100, clock: () => now });
    const changed = await store.commit(await store.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' }));
    const changedPlan = await store.planReconciliation({ scope, retainedReferences: [], authoritativeSetComplete: true,
      olderThan: now - 1, maxExamined: 1, maxDeletes: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5)); await writeFile(storedPath(directory, changed), new Uint8Array([2]));
    await expect(store.applyReconciliation(changedPlan)).resolves.toEqual({ deleted: 0, changed: 1, missing: 0 });
    const missing = await store.commit(await store.stage({ scope, content: new Uint8Array([3]), mediaType: 'text/plain', classification: 'internal' }));
    const missingPlan = await store.planReconciliation({ scope, retainedReferences: [changed], authoritativeSetComplete: true,
      olderThan: now - 1, maxExamined: 2, maxDeletes: 1 });
    await store.delete(missing, scope);
    await expect(store.applyReconciliation(missingPlan)).resolves.toEqual({ deleted: 0, changed: 0, missing: 1 });
  });

  it('reports structural anomalies without deleting unrecognized entries', async () => {
    const directory = await root(); const store = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 100 });
    const reference = await store.commit(await store.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' }));
    const scopeDirectory = join(directory, 'objects', reference.scopeDigest.slice(7));
    await mkdir(scopeDirectory, { recursive: true }); await writeFile(join(scopeDirectory, 'unrecognized'), 'leave');
    const plan = await store.planReconciliation({ scope, retainedReferences: [reference], authoritativeSetComplete: true,
      olderThan: Date.now(), maxExamined: 2, maxDeletes: 1 });
    expect(plan.anomalies).toBe(1); expect(plan.candidates).toEqual([]);
    await expect(store.applyReconciliation(plan)).resolves.toEqual({ deleted: 0, changed: 0, missing: 0 });
    expect(await readFile(join(scopeDirectory, 'unrecognized'), 'utf8')).toBe('leave');
  });

  it('serializes concurrent promotion against the per-scope committed capacity', async () => {
    const store = createLocalArtifactStore({ rootDirectory: await root(), maxArtifactBytes: 100, maxCommittedArtifactsPerScope: 1 });
    const first = await store.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' });
    const second = await store.stage({ scope, content: new Uint8Array([2]), mediaType: 'text/plain', classification: 'internal' });
    const results = await Promise.allSettled([store.commit(first), store.commit(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['LIMIT_EXCEEDED']);
    const rejected = results[0]?.status === 'rejected' ? first : second;
    await expect(store.discard(rejected)).resolves.toBe(true);
    await expect(store.discard(rejected)).resolves.toBe(false);
    await expect(store.discard({ ...rejected })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
