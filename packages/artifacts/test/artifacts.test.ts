import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalArtifactStore, type ArtifactReference, type ArtifactScope } from '../src/index.js';

const roots: string[] = [];
const scope = Object.freeze({ tenantId: 'tenant-a', projectId: 'project-a' });

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'mayura-artifact-'));
  roots.push(value);
  return value;
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
    const path = join(directory, 'objects', reference.scopeDigest.slice(7), reference.referenceDigest.slice(7, 9), reference.referenceDigest.slice(7));
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
});
