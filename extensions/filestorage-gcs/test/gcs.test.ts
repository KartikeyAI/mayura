import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { gcsFiles } from '../src/index.js';

interface Stored { data: Uint8Array; generation: number; contentType: string; metadata?: Record<string, string>; updated: string }
const describeObject = (name: string, file: Stored) => ({ kind: 'storage#object', name, bucket: 'box', size: String(file.data.byteLength), generation: String(file.generation),
  metageneration: '1', contentType: file.contentType, updated: file.updated, ...(file.metadata ? { metadata: file.metadata } : {}) });
const utf8Order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Enough of the Cloud Storage JSON API to run the file store contract: multipart uploads, generations and preconditions. */
function emulator(seen: Request[] = []) {
  const objects = new Map<string, Stored>(); let generation = 1_700_000_000_000_000;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); seen.push(request.clone());
    if (request.headers.get('authorization') !== 'Bearer fixture-token') return Response.json({ error: { code: 401, message: 'SECRET' } }, { status: 401 });
    const url = new URL(request.url); const query = url.searchParams;
    const condition = query.get('ifGenerationMatch');
    const fails = (file: Stored | undefined) => condition !== null && (condition === '0' ? file !== undefined : file?.generation !== Number(condition));
    if (request.method === 'POST' && url.pathname === '/upload/storage/v1/b/box/o' && query.get('uploadType') === 'multipart') {
      const boundary = /boundary=(.+)$/u.exec(request.headers.get('content-type') ?? '')![1]!;
      const body = new Uint8Array(await request.arrayBuffer()); const text = Buffer.from(body).toString('latin1');
      const parts = text.split(`--${boundary}`).slice(1, -1);
      const metadataPart = parts[0]!; const meta = JSON.parse(Buffer.from(metadataPart.slice(metadataPart.indexOf('\r\n\r\n') + 4, -2), 'latin1').toString('utf8')) as { name: string; contentType: string; metadata?: Record<string, string> };
      const dataPart = parts[1]!; const data = new Uint8Array(Buffer.from(dataPart.slice(dataPart.indexOf('\r\n\r\n') + 4, -2), 'latin1'));
      if (fails(objects.get(meta.name))) return Response.json({ error: { code: 412, message: 'SECRET Precondition Failed' } }, { status: 412 });
      const file = { data, generation: ++generation, contentType: meta.contentType, ...(meta.metadata ? { metadata: meta.metadata } : {}), updated: new Date().toISOString() };
      objects.set(meta.name, file);
      return Response.json(describeObject(meta.name, file));
    }
    if (request.method === 'GET' && url.pathname === '/storage/v1/b/box/o') {
      const prefix = query.get('prefix') ?? ''; const limit = Number(query.get('maxResults')); const after = query.get('pageToken');
      const names = [...objects.keys()].filter(name => name.startsWith(prefix) && (after === null || utf8Order(name, after) > 0)).sort(utf8Order);
      const page = names.slice(0, limit);
      return Response.json({ kind: 'storage#objects', items: page.map(name => describeObject(name, objects.get(name)!)), ...(names.length > page.length ? { nextPageToken: page.at(-1) } : {}) });
    }
    const match = /^\/storage\/v1\/b\/box\/o\/([^/]+)$/u.exec(url.pathname);
    if (!match) return new Response(null, { status: 400 });
    const name = decodeURIComponent(match[1]!); const file = objects.get(name);
    if (request.method === 'DELETE') {
      if (!file) return Response.json({ error: { code: 404 } }, { status: 404 });
      if (fails(file)) return Response.json({ error: { code: 412 } }, { status: 412 });
      objects.delete(name); return new Response(null, { status: 204 });
    }
    if (!file) return Response.json({ error: { code: 404 } }, { status: 404 });
    if (fails(file)) return Response.json({ error: { code: 412 } }, { status: 412 });
    if (query.get('alt') !== 'media') return Response.json(describeObject(name, file));
    if (query.get('generation') !== String(file.generation)) return Response.json({ error: { code: 404 } }, { status: 404 });
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range') ?? '');
    if (!range) return new Response(file.data as BodyInit, { status: 200, headers: { 'content-type': file.contentType, 'x-goog-generation': String(file.generation) } });
    return new Response(file.data.slice(Number(range[1]), Number(range[2]) + 1) as BodyInit, { status: 206, headers: { 'content-range': `bytes ${range[1]}-${range[2]}/${file.data.byteLength}` } });
  }) as typeof globalThis.fetch;
  return { fetch, objects };
}
const token = () => 'fixture-token';

describe('@mayurajs/filestorage-gcs keeps the file store contract', () => {
  const store = createFileStore(gcsFiles({ bucket: 'box', token, fetch: emulator().fetch }), { maxFileBytes: 1_048_576 });
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store })).toBe('passed'); });
});

describe('@mayurajs/filestorage-gcs', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uploads one multipart request with generation 0 for create-only, and reads nothing from the environment', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/attacker/key.json'); vi.stubEnv('STORAGE_EMULATOR_HOST', 'attacker.example');
    const seen: Request[] = []; const gcs = emulator(seen);
    const store = createFileStore(gcsFiles({ bucket: 'box', token, userProject: 'my-billing-project', fetch: gcs.fetch }), { maxFileBytes: 1_024 });
    const written = await store.put('reports/q3 final.csv', new TextEncoder().encode('a,b'), { contentType: 'text/csv', metadata: { owner: 'acme' }, ifNoneMatch: '*' });
    expect(written.etag).toMatch(/^\d+$/u);
    const upload = new URL(seen[0]!.url);
    expect(`${upload.origin}${upload.pathname}`).toBe('https://storage.googleapis.com/upload/storage/v1/b/box/o');
    expect(Object.fromEntries(upload.searchParams)).toEqual({ uploadType: 'multipart', ifGenerationMatch: '0', userProject: 'my-billing-project' });
    expect(gcs.objects.get('reports/q3 final.csv')).toMatchObject({ contentType: 'text/csv', metadata: { owner: 'acme' } });
    await store.get('reports/q3 final.csv');
    expect(new URL(seen[1]!.url).pathname).toBe('/storage/v1/b/box/o/reports%2Fq3%20final.csv');
    expect(new URL(seen[2]!.url).searchParams.get('generation')).toBe(written.etag);
    expect(seen.every(request => request.headers.get('authorization') === 'Bearer fixture-token')).toBe(true);
  });

  it('reads the version it described, even when the file is replaced in between', async () => {
    const gcs = emulator(); let replace = true;
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await gcs.fetch(input, init);
      if (replace && new URL(String(input)).searchParams.get('alt') !== 'media' && (init?.method ?? 'GET') === 'GET' && !String(input).endsWith('/o?')) {
        replace = false; const file = gcs.objects.get('a.txt')!; gcs.objects.set('a.txt', { ...file, data: new TextEncoder().encode('new!'), generation: file.generation + 1 });
      }
      return response;
    }) as typeof globalThis.fetch;
    const store = createFileStore(gcsFiles({ bucket: 'box', token, fetch: racing }), { maxFileBytes: 64 });
    replace = false; await store.put('a.txt', new TextEncoder().encode('old')); replace = true;
    const file = await store.get('a.txt');
    expect(new TextDecoder().decode(file!.data)).toBe('new!'); expect(file!.size).toBe(4);
  });

  it('maps Cloud Storage answers to fixed reasons without its text, and refuses a failing token source before sending', async () => {
    const answer = (status: number) => (async () => Response.json({ error: { code: status, message: 'SECRET' } }, { status })) as unknown as typeof globalThis.fetch;
    for (const [status, reason] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate_limited'], [503, 'unavailable'], [400, 'rejected']] as const) {
      const error = await createFileStore(gcsFiles({ bucket: 'box', token, fetch: answer(status) }), { maxFileBytes: 64 }).head('a').catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason }); expect(JSON.stringify(error)).not.toContain('SECRET');
    }
    await expect(createFileStore(gcsFiles({ bucket: 'box', token, fetch: answer(412) }), { maxFileBytes: 64 }).put('a', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'CONFLICT' });
    let sent = 0;
    const counting = (async () => { sent++; return new Response(null, { status: 404 }); }) as unknown as typeof globalThis.fetch;
    await expect(createFileStore(gcsFiles({ bucket: 'box', token: () => { throw new Error('SECRET'); }, fetch: counting }), { maxFileBytes: 64 }).head('a')).rejects.toMatchObject({ reason: 'authentication' });
    expect(sent).toBe(0);
    await expect(createFileStore(gcsFiles({ bucket: 'box', token, fetch: counting }), { maxFileBytes: 64 }).put('a', new Uint8Array(1), { ifMatch: '"not-a-generation"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(sent).toBe(0);
  });

  it('needs a bucket, a token source and an https endpoint (or http on this machine)', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => gcsFiles({ bucket: 'Bad Bucket', token })).toThrow(invalid);
    expect(() => gcsFiles({ bucket: 'box', token: 'secret' as never })).toThrow(invalid);
    expect(() => gcsFiles({ bucket: 'box', token, endpoint: 'http://gcs.internal:4443' })).toThrow(invalid);
    expect(() => gcsFiles({ bucket: 'box', token, userProject: 'Bad/Project' })).toThrow(invalid);
    expect(() => gcsFiles({ bucket: 'box', token, endpoint: 'http://127.0.0.1:4443' })).not.toThrow();
  });
});
