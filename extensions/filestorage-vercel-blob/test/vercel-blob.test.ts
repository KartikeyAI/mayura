import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFileStore } from 'mayura/files';
import { fileStoreConformance } from 'mayura/testing';
import { vercelBlobApiVersion, vercelBlobFiles } from '../src/index.js';

const token = 'vercel_blob_rw_StoreAbc123_secretXyz789';
interface Stored { data: Uint8Array; etag: string; contentType: string; uploadedAt: string }
const utf8Order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const error = (status: number, code: string) => Response.json({ error: { code, message: `SECRET ${code}` } }, { status });

/** Enough of the Blob API (vercel.com/api/blob) and the private blob host, as @vercel/blob 2.8 speaks to them. */
function emulator() {
  const blobs = new Map<string, Stored>(); let version = 0;
  const handle = async (request: Request): Promise<Response> => {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return error(403, 'forbidden');
    const url = new URL(request.url);
    if (url.pathname.startsWith('/blob/')) {
      const key = url.pathname.slice('/blob/'.length).split('/').map(decodeURIComponent).join('/'); const file = blobs.get(key);
      if (!file) return new Response('Not found', { status: 404 });
      const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.get('range') ?? '');
      const headers = { etag: file.etag, 'content-type': file.contentType };
      if (!range) return new Response(file.data as BodyInit, { status: 200, headers });
      return new Response(file.data.slice(Number(range[1]), Number(range[2]) + 1) as BodyInit, { status: 206, headers: { ...headers, 'content-range': `bytes ${range[1]}-${range[2]}/${file.data.byteLength}` } });
    }
    if (request.headers.get('x-api-version') !== vercelBlobApiVersion) return error(400, 'bad_request');
    const describe = (pathname: string, file: Stored) => ({ url: `https://storeabc123.private.blob.vercel-storage.com/${pathname}`, downloadUrl: '', pathname, size: file.data.byteLength,
      contentType: file.contentType, contentDisposition: '', cacheControl: '', uploadedAt: file.uploadedAt, etag: file.etag });
    if (request.method === 'PUT') {
      const pathname = url.searchParams.get('pathname')!; const existing = blobs.get(pathname);
      const ifMatch = request.headers.get('x-if-match');
      if (ifMatch !== null) { if (!existing) return error(404, 'not_found'); if (existing.etag !== ifMatch) return error(412, 'precondition_failed'); }
      else if (existing && request.headers.get('x-allow-overwrite') !== '1') return error(400, 'bad_request');
      const file = { data: new Uint8Array(await request.arrayBuffer()), etag: `"${(++version).toString(16)}"`, contentType: request.headers.get('x-content-type') ?? 'application/octet-stream', uploadedAt: new Date().toISOString() };
      blobs.set(pathname, file);
      return Response.json(describe(pathname, file));
    }
    if (request.method === 'POST' && url.pathname.endsWith('/delete')) {
      const { urls } = await request.json() as { urls: string[] }; const ifMatch = request.headers.get('x-if-match');
      for (const pathname of urls) {
        if (ifMatch !== null) { const file = blobs.get(pathname); if (!file) return error(404, 'not_found'); if (file.etag !== ifMatch) return error(412, 'precondition_failed'); }
        blobs.delete(pathname);
      }
      return Response.json({});
    }
    if (request.method === 'GET' && url.searchParams.has('url')) {
      const pathname = url.searchParams.get('url')!; const file = blobs.get(pathname);
      return file ? Response.json(describe(pathname, file)) : error(404, 'not_found');
    }
    if (request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? ''; const limit = Number(url.searchParams.get('limit') ?? 1000); const after = url.searchParams.get('cursor');
      const names = [...blobs.keys()].filter(name => name.startsWith(prefix) && (after === null || utf8Order(name, after) > 0)).sort(utf8Order);
      const page = names.slice(0, limit);
      return Response.json({ blobs: page.map(name => describe(name, blobs.get(name)!)), hasMore: names.length > page.length, ...(names.length > page.length ? { cursor: page.at(-1) } : {}) });
    }
    return error(400, 'bad_request');
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof globalThis.fetch;
  return { handle, fetch, blobs };
}
const backend = (fetch: typeof globalThis.fetch) => vercelBlobFiles({ token, apiURL: 'http://127.0.0.1:1/api/blob', blobURL: 'http://127.0.0.1:1/blob', fetch });

describe('@mayurajs/filestorage-vercel-blob keeps the file store contract', () => {
  const store = createFileStore(backend(emulator().fetch), { maxFileBytes: 1_048_576 });
  // Vercel Blob keeps no custom metadata, which the first case writes and reads back.
  const skip = { 'writes and reads back bytes, media type and metadata': 'Vercel Blob keeps no custom metadata' };
  for (const test of fileStoreConformance) it(test.name, async () => { expect(await test.run({ store, skip })).toBe(test.name in skip ? 'skipped' : 'passed'); });
});

describe('@mayurajs/filestorage-vercel-blob', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('stores the media type, refuses metadata it cannot keep, and reads nothing from the environment', async () => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_Attacker_env'); vi.stubEnv('VERCEL_BLOB_API_URL', 'https://attacker.example');
    const seen: string[] = []; const blob = emulator();
    const store = createFileStore(backend((async (input: RequestInfo | URL, init?: RequestInit) => { seen.push(String(input)); return blob.fetch(input, init); }) as typeof globalThis.fetch), { maxFileBytes: 64 });
    await store.put('a.csv', new TextEncoder().encode('a,b'), { contentType: 'text/csv' });
    expect(await store.head('a.csv')).toMatchObject({ contentType: 'text/csv', size: 3 });
    await expect(store.put('b.txt', new Uint8Array(1), { metadata: { owner: 'acme' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(seen.every(url => url.startsWith('http://127.0.0.1:1/'))).toBe(true);
  });

  it('reports a create-only write to an existing blob as CONFLICT, whatever error the service gives', async () => {
    const blob = emulator();
    const store = createFileStore(backend(blob.fetch), { maxFileBytes: 64 });
    await store.put('once.txt', new Uint8Array([1]));
    await expect(store.put('once.txt', new Uint8Array([2]), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const refusing = (async () => error(400, 'bad_request')) as unknown as typeof globalThis.fetch;
    await expect(createFileStore(backend(refusing), { maxFileBytes: 64 }).put('new.txt', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ reason: 'rejected' });
  });

  it('maps errors to fixed reasons without the service text', async () => {
    for (const [status, code, reason] of [[403, 'forbidden', 'authentication'], [429, 'rate_limited', 'rate_limited'], [503, 'service_unavailable', 'unavailable']] as const) {
      const failing = (async () => error(status, code)) as unknown as typeof globalThis.fetch;
      const caught = await createFileStore(backend(failing), { maxFileBytes: 64 }).head('a').catch((thrown: unknown) => thrown);
      expect(caught).toMatchObject({ reason }); expect(JSON.stringify(caught)).not.toContain('SECRET');
    }
  });

  it('needs a read-write token and https endpoints (or http on this machine)', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => vercelBlobFiles({} as never)).toThrow(invalid);
    expect(() => vercelBlobFiles({ token: 'vercel_blob_client_x' })).toThrow(invalid);
    expect(() => vercelBlobFiles({ token, apiURL: 'http://blob.internal/api' })).toThrow(invalid);
    expect(() => vercelBlobFiles({ token })).not.toThrow();
  });
});

describe('@mayurajs/filestorage-vercel-blob speaks the protocol @vercel/blob does', () => {
  type Recorded = { method: string; path: string; headers: Record<string, string | undefined>; body: string };
  let server: Server; let base = ''; let recorded: Recorded[] = [];
  const kept = ['authorization', 'x-api-version', 'x-vercel-blob-store-id', 'x-vercel-blob-access', 'x-content-type', 'x-add-random-suffix', 'x-allow-overwrite', 'x-if-match', 'content-type'];
  beforeAll(async () => {
    const blob = emulator();
    server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      recorded.push({ method: incoming.method!, path: incoming.url!, headers: Object.fromEntries(kept.map(name => [name, incoming.headers[name] as string | undefined])), body: body.toString('latin1') });
      const response = await blob.handle(new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method!, headers: incoming.headers as Record<string, string>, ...(body.byteLength ? { body } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('sends the same put, head, list and delete requests as @vercel/blob', async () => {
    const sdk = await import('@vercel/blob');
    const run = async (label: string, body: () => Promise<unknown>) => { recorded = []; await body(); return recorded.map(request => ({ ...request, label })); };
    vi.stubEnv('VERCEL_BLOB_API_URL', `${base}/api/blob`); vi.stubEnv('VERCEL_BLOB_RETRIES', '0');
    const theirs = [
      ...await run('put', () => sdk.put('dir/a b.txt', 'hello', { access: 'private', token, contentType: 'text/plain', addRandomSuffix: false, allowOverwrite: false })),
      ...await run('head', () => sdk.head('dir/a b.txt', { token })),
      ...await run('list', () => sdk.list({ token, prefix: 'dir/', limit: 10, mode: 'expanded' })),
    ];
    const etag = (await sdk.head('dir/a b.txt', { token })).etag;
    theirs.push(...await run('replace', () => sdk.put('dir/a b.txt', 'again', { access: 'private', token, contentType: 'text/plain', addRandomSuffix: false, ifMatch: etag })));
    const etag2 = (await sdk.head('dir/a b.txt', { token })).etag;
    theirs.push(...await run('delete', () => sdk.del('dir/a b.txt', { token, ifMatch: etag2 })));
    vi.unstubAllEnvs();
    const ours = vercelBlobFiles({ token, apiURL: `${base}/api/blob`, blobURL: `${base}/blob` }); const signal = new AbortController().signal;
    const mine = [
      ...await run('put', () => ours.put('dir/a b.txt', new TextEncoder().encode('hello'), { contentType: 'text/plain', metadata: {}, ifNoneMatch: '*', signal })),
      ...await run('head', () => ours.head('dir/a b.txt', { signal })),
      ...await run('list', () => ours.list({ prefix: 'dir/', limit: 10, signal })),
    ];
    const current = (await ours.head('dir/a b.txt', { signal }))!.etag;
    mine.push(...await run('replace', () => ours.put('dir/a b.txt', new TextEncoder().encode('again'), { contentType: 'text/plain', metadata: {}, ifMatch: current, signal })));
    const current2 = (await ours.head('dir/a b.txt', { signal }))!.etag;
    mine.push(...await run('delete', () => ours.delete('dir/a b.txt', { ifMatch: current2, signal })));
    // Two differences are not protocol: the etags (the emulator's versions keep counting between the runs) and the
    // Content-Type fetch gives the SDK's string body on a put (the service takes the media type from x-content-type).
    const normalize = (requests: (Recorded & { label: string })[]) => requests.map(({ label, method, path, headers, body }) => ({ label, method, path: new URL(path, base).pathname,
      query: Object.fromEntries([...new URL(path, base).searchParams].sort()),
      headers: { ...headers, ...(headers['x-if-match'] === undefined ? {} : { 'x-if-match': '<etag>' }), ...(method === 'PUT' ? { 'content-type': '<body>' } : {}) },
      body: label === 'delete' ? JSON.parse(body) : body }));
    expect(normalize(mine)).toEqual(normalize(theirs));
  });
});
