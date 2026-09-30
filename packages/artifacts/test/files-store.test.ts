import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileStore, memoryFiles, type FileStore } from '@mayura/files';
import { createArtifactStore, createLocalArtifactStore, type ArtifactReconciliationCursor, type ArtifactReconciliationPlan,
  type ArtifactReference, type ArtifactScope } from '../src/index.js';

const scope = Object.freeze({ principalId: 'tenant-a', projectId: 'project-a' });
const files = (): FileStore => createFileStore(memoryFiles(), { maxFileBytes: 1_048_576 }).within('artifacts');
const store = (options: Partial<Parameters<typeof createArtifactStore>[0]> = {}) => {
  const raw = options.files ?? files();
  return { raw, artifacts: createArtifactStore({ files: raw, maxArtifactBytes: 1_024, ...options }) };
};
const objectKey = (reference: ArtifactReference) => `objects/${reference.scopeDigest.slice(7)}/${reference.referenceDigest.slice(7)}`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe('artifact store over a file store', () => {
  it('promotes immutable content and deduplicates the same scoped bytes', async () => {
    const { artifacts } = store();
    const input = { scope, content: new TextEncoder().encode('report'), mediaType: 'text/plain', classification: 'internal' as const, filename: 'report.txt' };
    const first = await artifacts.commit(await artifacts.stage(input));
    const second = await artifacts.commit(await artifacts.stage(input));
    expect(second).toEqual(first);
    expect(new TextDecoder().decode(await artifacts.read(first, scope))).toBe('report');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('makes the same references as the local store, so references move between stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mayura-artifact-')); roots.push(directory);
    const local = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 1_024 });
    const { artifacts } = store();
    const input = { scope, content: new TextEncoder().encode('same'), mediaType: 'text/csv', classification: 'confidential' as const, filename: 'a.csv', expiresAt: Date.now() + 60_000 };
    expect(await artifacts.commit(await artifacts.stage(input))).toEqual(await local.commit(await local.stage(input)));
  });

  it('partitions identical content by verified scope', async () => {
    const { artifacts } = store();
    const bytes = new Uint8Array([1, 2, 3]);
    const first = await artifacts.commit(await artifacts.stage({ scope, content: bytes, mediaType: 'application/octet-stream', classification: 'confidential' }));
    const otherScope = { principalId: 'tenant-b', projectId: 'project-a' };
    const second = await artifacts.commit(await artifacts.stage({ scope: otherScope, content: bytes, mediaType: 'application/octet-stream', classification: 'confidential' }));
    expect(second.digest).toBe(first.digest); expect(second.scopeDigest).not.toBe(first.scopeDigest);
    await expect(artifacts.read(first, otherScope)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('revalidates content identity and fails closed after tampering, including a longer file', async () => {
    const { raw, artifacts } = store();
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream', classification: 'restricted' }));
    await raw.put(objectKey(reference), new Uint8Array([3, 2, 1]));
    await expect(artifacts.read(reference, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    await raw.put(objectKey(reference), new Uint8Array(500));
    await expect(artifacts.read(reference, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('refuses to commit over a different object already at its key', async () => {
    const { raw, artifacts } = store();
    const input = { scope, content: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream', classification: 'restricted' as const };
    const reference = await artifacts.commit(await artifacts.stage(input));
    await raw.put(objectKey(reference), new Uint8Array([7, 7, 7]));
    await expect(artifacts.commit(await artifacts.stage(input))).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('revalidates staged bytes immediately before promotion', async () => {
    const { raw, artifacts } = store();
    const staged = await artifacts.stage({ scope, content: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream', classification: 'restricted' });
    await raw.put(`staging/${staged.stageId}`, new Uint8Array([3, 2, 1]));
    await expect(artifacts.commit(staged)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('binds classification and disclosure metadata to the committed reference', async () => {
    const { artifacts } = store();
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'restricted' }));
    await expect(artifacts.read({ ...reference, classification: 'public' }, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    await expect(artifacts.read({ ...reference, mediaType: 'application/pdf' }, scope)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('rejects missing, expired and oversized references without releasing bytes', async () => {
    let now = 1_000;
    const { artifacts } = store({ maxArtifactBytes: 4, clock: () => now });
    await expect(artifacts.stage({ scope, content: new Uint8Array(5), mediaType: 'text/plain', classification: 'public' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'public', expiresAt: 2_000 }));
    now = 2_000;
    await expect(artifacts.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store({ clock: () => 1_000 }).artifacts.read(reference, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns a bounded attachment with a sanitized filename, and blocks what the policy does not allow', async () => {
    const { artifacts } = store();
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new TextEncoder().encode('safe'), mediaType: 'TEXT/PLAIN', classification: 'internal', filename: '../../quarter "one".txt' }));
    const disclosure = await artifacts.disclose(reference, scope, { classifications: ['internal'], maxBytes: 10, mediaTypes: ['text/plain'] });
    expect(new TextDecoder().decode(disclosure.body)).toBe('safe');
    expect(disclosure.headers).toEqual({ 'Content-Disposition': 'attachment; filename="quarter_one_.txt"', 'Content-Length': '4', 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    const html = await artifacts.commit(await artifacts.stage({ scope, content: new TextEncoder().encode('<script>'), mediaType: 'text/html', classification: 'public' }));
    await expect(artifacts.disclose(html, scope, { classifications: ['public'], maxBytes: 100 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(artifacts.disclose(reference, scope, { classifications: ['public'], maxBytes: 100 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(artifacts.disclose(reference, scope, { classifications: ['internal'], maxBytes: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('rejects forged handles, extended references and accessors without invoking them', async () => {
    const { artifacts } = store();
    await expect(artifacts.commit({ format: 'mayura-staged-artifact-v1', stageId: crypto.randomUUID(), digest: `sha256:${'a'.repeat(64)}`, bytes: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array(), mediaType: 'text/plain', classification: 'public' }));
    await expect(artifacts.read({ ...reference, extra: true } as unknown as ArtifactReference, scope)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    let invoked = false;
    const hostileScope = Object.defineProperty({ principalId: 'tenant-a' }, 'projectId', { enumerable: true, get: () => { invoked = true; return 'project-a'; } });
    await expect(artifacts.read(reference, hostileScope as ArtifactScope)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(invoked).toBe(false);
  });

  it('deletes only an exact scoped object and reports absence idempotently', async () => {
    const { artifacts } = store();
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([1]), mediaType: 'application/octet-stream', classification: 'restricted' }));
    await expect(artifacts.delete(reference, { principalId: 'other', projectId: 'project-a' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await artifacts.delete(reference, scope)).toBe(true);
    expect(await artifacts.delete(reference, scope)).toBe(false);
  });

  it('removes only bounded inactive staging files', async () => {
    const raw = files();
    const first = createArtifactStore({ files: raw, maxArtifactBytes: 100 });
    const staged = await first.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' });
    const second = createArtifactStore({ files: raw, maxArtifactBytes: 100, clock: () => Date.now() + 10_000 });
    expect(await second.reconcileStaging({ olderThan: Date.now() + 5_000, maxDeletes: 1 })).toEqual({ examined: 1, deleted: 1, remaining: false });
    await expect(first.commit(staged)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    await raw.put('staging/not-owned.txt', new TextEncoder().encode('leave'));
    await second.reconcileStaging({ olderThan: Date.now() + 5_000, maxDeletes: 1 });
    expect(await raw.head('staging/not-owned.txt')).toBeDefined();
  });

  it('bounds staged population and rejects shared mutable input', async () => {
    const { artifacts } = store({ maxStagedArtifacts: 1 });
    const input = { scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' as const };
    const first = await artifacts.stage(input);
    await expect(artifacts.stage(input)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await artifacts.commit(first);
    await artifacts.commit(await artifacts.stage(input));
    if (typeof SharedArrayBuffer !== 'undefined') await expect(artifacts.stage({ ...input, content: new Uint8Array(new SharedArrayBuffer(1)) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('audits available, missing, expired and corrupt objects without returning content', async () => {
    let now = Date.now() + 10_000;
    const { raw, artifacts } = store({ clock: () => now });
    const make = async (value: number, expiresAt?: number) => artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([value]),
      mediaType: 'application/octet-stream', classification: 'internal', ...(expiresAt === undefined ? {} : { expiresAt }) }));
    const ok = await make(1); const missing = await make(2); const expired = await make(3, now + 1_000); const corrupt = await make(4);
    await artifacts.delete(missing, scope); await raw.put(objectKey(corrupt), new Uint8Array([9])); now += 2_000;
    expect(await artifacts.audit([ok, missing, expired, corrupt], scope, { maxTotalBytes: 4 })).toEqual({ admittedBytes: 4, observations: [
      { referenceDigest: ok.referenceDigest, status: 'ok' }, { referenceDigest: missing.referenceDigest, status: 'missing' },
      { referenceDigest: expired.referenceDigest, status: 'expired' }, { referenceDigest: corrupt.referenceDigest, status: 'integrity_failed' },
    ] });
    await expect(artifacts.audit([ok, ok], scope, { maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(artifacts.audit([ok], scope, { maxTotalBytes: 0.5 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('plans finite cleanup, deletes only unretained objects, and consumes plans once', async () => {
    const now = Date.now() + 10_000;
    const { artifacts } = store({ clock: () => now });
    const references: ArtifactReference[] = [];
    for (let value = 1; value <= 5; value++) references.push(await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([value]), mediaType: 'application/octet-stream', classification: 'internal' })));
    const retained = [references[1]!, references[3]!]; const planned: ArtifactReconciliationPlan[] = []; let cursor: ArtifactReconciliationCursor | undefined;
    do {
      const plan = await artifacts.planReconciliation({ scope, retainedReferences: retained, authoritativeSetComplete: true, olderThan: now - 1, maxExamined: 2, maxDeletes: 2, ...(cursor === undefined ? {} : { cursor }) });
      planned.push(plan); cursor = plan.nextCursor;
    } while (cursor !== undefined);
    let deleted = 0;
    for (const plan of planned) deleted += (await artifacts.applyReconciliation(plan)).deleted;
    expect(deleted).toBe(3);
    for (const reference of retained) await expect(artifacts.read(reference, scope)).resolves.toHaveLength(1);
    await expect(artifacts.applyReconciliation(planned[0]!)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store().artifacts.applyReconciliation(planned[1]!)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([['with', true], ['without', false]] as const)('skips a candidate changed after planning and reports a disappeared one, %s conditional deletes', async (_, conditionalDelete) => {
    const now = Date.now() + 10_000;
    const { raw, artifacts } = store({ clock: () => now, files: createFileStore({ ...memoryFiles(), conditionalDelete }, { maxFileBytes: 1_048_576 }) });
    const changed = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' }));
    const changedPlan = await artifacts.planReconciliation({ scope, retainedReferences: [], authoritativeSetComplete: true, olderThan: now - 1, maxExamined: 1, maxDeletes: 1 });
    await raw.put(objectKey(changed), new Uint8Array([2]));
    await expect(artifacts.applyReconciliation(changedPlan)).resolves.toEqual({ deleted: 0, changed: 1, missing: 0 });
    const missing = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([3]), mediaType: 'text/plain', classification: 'internal' }));
    const missingPlan = await artifacts.planReconciliation({ scope, retainedReferences: [changed], authoritativeSetComplete: true, olderThan: now - 1, maxExamined: 2, maxDeletes: 1 });
    await artifacts.delete(missing, scope);
    await expect(artifacts.applyReconciliation(missingPlan)).resolves.toEqual({ deleted: 0, changed: 0, missing: 1 });
  });

  it('reports unrecognized entries as anomalies and leaves them, and refuses to back up around them', async () => {
    const { raw, artifacts } = store();
    const reference = await artifacts.commit(await artifacts.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' }));
    await raw.put(`objects/${reference.scopeDigest.slice(7)}/unrecognized`, new TextEncoder().encode('leave'));
    const plan = await artifacts.planReconciliation({ scope, retainedReferences: [reference], authoritativeSetComplete: true, olderThan: Date.now(), maxExamined: 2, maxDeletes: 1 });
    expect(plan.anomalies).toBe(1); expect(plan.candidates).toEqual([]);
    expect(await raw.head(`objects/${reference.scopeDigest.slice(7)}/unrecognized`)).toBeDefined();
    await expect(artifacts.backup({ scope, references: [reference], authoritativeSetComplete: true, maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
  });

  it('serializes concurrent promotion against the per-scope committed capacity', async () => {
    const { artifacts } = store({ maxCommittedArtifactsPerScope: 1 });
    const first = await artifacts.stage({ scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' });
    const second = await artifacts.stage({ scope, content: new Uint8Array([2]), mediaType: 'text/plain', classification: 'internal' });
    const results = await Promise.allSettled([artifacts.commit(first), artifacts.commit(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(['LIMIT_EXCEEDED']);
    const rejected = results[0]?.status === 'rejected' ? first : second;
    await expect(artifacts.discard(rejected)).resolves.toBe(true);
    await expect(artifacts.discard(rejected)).resolves.toBe(false);
  });

  it('backs up deterministically and restores idempotently, across local and file stores both ways', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mayura-artifact-')); roots.push(directory);
    const local = createLocalArtifactStore({ rootDirectory: directory, maxArtifactBytes: 1_024 });
    const first = await local.commit(await local.stage({ scope, content: new TextEncoder().encode('first'), mediaType: 'text/plain', classification: 'internal', filename: 'first.txt' }));
    const second = await local.commit(await local.stage({ scope, content: new Uint8Array([2, 3, 4]), mediaType: 'application/octet-stream', classification: 'restricted' }));
    const archive = await local.backup({ scope, references: [second, first], authoritativeSetComplete: true, maxTotalBytes: 100 });
    const limits = { maxArchiveBytes: 10_000, maxTotalBytes: 100, maxArtifacts: 2 };
    const { artifacts } = store();
    await expect(artifacts.restore(archive, scope, limits)).resolves.toEqual({ artifacts: 2, restored: 2, existing: 0, contentBytes: 8 });
    await expect(artifacts.restore(archive, scope, limits)).resolves.toEqual({ artifacts: 2, restored: 0, existing: 2, contentBytes: 8 });
    expect(new TextDecoder().decode(await artifacts.read(first, scope))).toBe('first');
    const again = await artifacts.backup({ scope, references: [first, second], authoritativeSetComplete: true, maxTotalBytes: 100 });
    expect(again).toEqual(archive);
    const localAgain = createLocalArtifactStore({ rootDirectory: join(directory, 'copy'), maxArtifactBytes: 1_024 });
    await expect(localAgain.restore(again, scope, limits)).resolves.toMatchObject({ restored: 2 });
    await expect(artifacts.backup({ scope, references: [first], authoritativeSetComplete: true, maxTotalBytes: 100 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects corrupt, cross-scope and conflicting restores before writing, and resumes a partial one', async () => {
    const source = store().artifacts;
    const input = { scope, content: new Uint8Array([1]), mediaType: 'text/plain', classification: 'internal' as const, filename: 'one.txt' };
    const first = await source.commit(await source.stage(input));
    const second = await source.commit(await source.stage({ ...input, content: new Uint8Array([2]), filename: 'two.txt' }));
    const archive = await source.backup({ scope, references: [first, second], authoritativeSetComplete: true, maxTotalBytes: 10 });
    const limits = { maxArchiveBytes: 10_000, maxTotalBytes: 10, maxArtifacts: 2 };
    const destination = store().artifacts;
    await expect(destination.restore(archive, { principalId: 'other', projectId: 'project-a' }, limits)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const corrupt = new Uint8Array(archive); corrupt[corrupt.length - 1] = 0x78;
    await expect(destination.restore(corrupt, scope, limits)).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    await expect(destination.restore(archive, scope, { ...limits, maxArtifacts: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(destination.read(first, scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await destination.commit(await destination.stage(input))).toEqual(first);
    await expect(destination.restore(archive, scope, limits)).resolves.toEqual({ artifacts: 2, restored: 1, existing: 1, contentBytes: 2 });
    const conflicting = store().artifacts;
    await conflicting.commit(await conflicting.stage({ ...input, content: new Uint8Array([9]), filename: 'other.txt' }));
    await expect(conflicting.restore(archive, scope, limits)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('needs a file store that writes conditionally and holds artifacts of the size allowed', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    const plain = createFileStore({ ...memoryFiles(), conditionalWrites: false }, { maxFileBytes: 1_024 });
    expect(() => createArtifactStore({ files: plain, maxArtifactBytes: 100 })).toThrow(invalid);
    expect(() => createArtifactStore({ files: createFileStore(memoryFiles(), { maxFileBytes: 64 }), maxArtifactBytes: 100 })).toThrow(invalid);
    expect(() => createArtifactStore({ files: {} as FileStore, maxArtifactBytes: 100 })).toThrow(invalid);
  });
});
