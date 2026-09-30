import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from 'mayura/files';
import { azureBlobFiles, azureBlobVersion } from '../src/index.js';

const accountKey = btoa('fixture-account-key-32-bytes!!!!');
type Seen = { method: string; url: URL; headers: Headers; body: Uint8Array }[];
const recorder = (answer: (request: Request) => Response | Promise<Response>, seen: Seen = []) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  seen.push({ method: request.method, url: new URL(request.url), headers: request.headers, body: new Uint8Array(await request.clone().arrayBuffer()) });
  return answer(request);
}) as typeof globalThis.fetch;

describe('@mayurajs/filestorage-azure-blob', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('writes a block blob signed with Shared Key, with metadata names Azure accepts, and reads nothing from the environment', async () => {
    vi.stubEnv('AZURE_STORAGE_CONNECTION_STRING', 'DefaultEndpointsProtocol=https;AccountName=attacker'); vi.stubEnv('AZURE_STORAGE_KEY', 'from-env');
    const seen: Seen = [];
    const store = createFileStore(azureBlobFiles({ account: 'acme', container: 'reports', accountKey,
      fetch: recorder(() => new Response(null, { status: 201, headers: { etag: '"0x8DE1"', 'last-modified': 'Thu, 01 Oct 2026 10:00:00 GMT' } }), seen) }), { maxFileBytes: 1_024 });
    const written = await store.put('q3/sales report.csv', new TextEncoder().encode('a,b'), { contentType: 'text/csv', metadata: { 'run-id': 'r-1' }, ifNoneMatch: '*' });
    expect(written).toMatchObject({ etag: '"0x8DE1"', size: 3 });
    const request = seen[0]!;
    expect(request.method).toBe('PUT'); expect(request.url.href).toBe('https://acme.blob.core.windows.net/reports/q3/sales%20report.csv');
    expect(Object.fromEntries(['x-ms-blob-type', 'x-ms-version', 'x-ms-meta-m_run_id', 'if-none-match', 'content-type'].map(name => [name, request.headers.get(name)])))
      .toEqual({ 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': azureBlobVersion, 'x-ms-meta-m_run_id': 'r-1', 'if-none-match': '*', 'content-type': 'text/csv' });
    expect(request.headers.get('authorization')).toMatch(/^SharedKey acme:[A-Za-z0-9+/]{43}=$/u);
    expect(Date.parse(request.headers.get('x-ms-date')!)).toBeGreaterThan(0);
  });

  it('reads metadata back under its own names and quotes the etags listings give bare', async () => {
    const answer = (request: Request) => {
      if (new URL(request.url).searchParams.get('comp') === 'list') {
        return new Response(`<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://acme.blob.core.windows.net/" ContainerName="reports"><Blobs>`
          + `<Blob><Name>a &amp; b.txt</Name><Properties><Last-Modified>Thu, 01 Oct 2026 10:00:00 GMT</Last-Modified><Etag>0x8DE2</Etag><Content-Length>3</Content-Length><Content-Type>text/plain</Content-Type></Properties></Blob>`
          + `</Blobs><NextMarker>2!72!MDAwMDE2IWEgJiBiLnR4dA--</NextMarker></EnumerationResults>`, { status: 200 });
      }
      return new Response(null, { status: 200, headers: { etag: '"0x8DE2"', 'content-length': '3', 'content-type': 'text/plain', 'x-ms-meta-m_run_id': 'r-1', 'x-ms-meta-other': 'kept' } });
    };
    const store = createFileStore(azureBlobFiles({ account: 'acme', container: 'reports', accountKey, fetch: recorder(answer) }), { maxFileBytes: 1_024 });
    const page = await store.list({ limit: 1 });
    expect(page).toEqual({ files: [expect.objectContaining({ key: 'a & b.txt', size: 3, etag: '"0x8DE2"' })], cursor: '2!72!MDAwMDE2IWEgJiBiLnR4dA--' });
    expect(await store.head('a & b.txt')).toMatchObject({ etag: '"0x8DE2"', metadata: { 'run-id': 'r-1', other: 'kept' } });
  });

  it('maps lost races and missing versions to CONFLICT, and errors to fixed reasons without the body', async () => {
    const answer = (status: number) => recorder(() => new Response('<Error><Code>X</Code><Message>SECRET</Message></Error>', { status }));
    const store = (status: number) => createFileStore(azureBlobFiles({ account: 'acme', container: 'reports', accountKey, fetch: answer(status) }), { maxFileBytes: 64 });
    await expect(store(409).put('a', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store(412).put('a', new Uint8Array(1), { ifMatch: '"0x1"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store(404).put('a', new Uint8Array(1), { ifMatch: '"0x1"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store(404).delete('a', { ifMatch: '"0x1"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store(404).delete('a')).resolves.toBeUndefined();
    for (const [status, reason] of [[403, 'authentication'], [429, 'rate_limited'], [500, 'unavailable'], [400, 'rejected']] as const) {
      const error = await store(status).put('a', new Uint8Array(1)).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason }); expect(JSON.stringify(error)).not.toContain('SECRET');
    }
  });

  it('authenticates with a token source or a SAS instead of the account key', async () => {
    const seen: Seen = [];
    const ok = recorder(() => new Response(null, { status: 404 }), seen);
    await createFileStore(azureBlobFiles({ account: 'acme', container: 'reports', token: async () => 'entra-token', fetch: ok }), { maxFileBytes: 64 }).head('a');
    await createFileStore(azureBlobFiles({ account: 'acme', container: 'reports', sas: 'sv=2024-11-04&sp=rcwdl&sig=abc%2Bdef', fetch: ok }), { maxFileBytes: 64 }).head('a');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer entra-token');
    expect(seen[1]!.headers.get('authorization')).toBeNull(); expect(seen[1]!.url.searchParams.get('sig')).toBe('abc+def');
    let sent = 0; const counting = (async () => { sent++; return new Response(null, { status: 404 }); }) as unknown as typeof globalThis.fetch;
    const error = await createFileStore(azureBlobFiles({ account: 'acme', container: 'reports', token: () => { throw new Error('SECRET'); }, fetch: counting }), { maxFileBytes: 64 }).head('a').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'authentication' }); expect(sent).toBe(0);
  });

  it('needs an account, a container, exactly one credential and an https endpoint (or Azurite on this machine)', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    type Options = Parameters<typeof azureBlobFiles>[0];
    const make = (options: { [K in keyof Options]?: Options[K] | undefined }) => () => azureBlobFiles({ account: 'acme', container: 'reports', accountKey, ...options } as Options);
    expect(make({})).not.toThrow();
    expect(make({ account: 'Acme!' })).toThrow(invalid); expect(make({ container: 'Bad_Container' })).toThrow(invalid); expect(make({ container: 'a--b' })).toThrow(invalid);
    expect(make({ token: () => 't' })).toThrow(invalid); expect(make({ accountKey: 'not base64!' })).toThrow(invalid);
    expect(make({ accountKey: undefined, sas: '?sig=x' })).toThrow(invalid); expect(make({ accountKey: undefined, sas: 'sv=1' })).toThrow(invalid);
    expect(make({ endpoint: 'http://blobs.internal:10000' })).toThrow(invalid); expect(make({ endpoint: 'https://acme.blob.core.windows.net/other' })).toThrow(invalid);
    expect(make({ account: 'devstoreaccount1', endpoint: 'http://127.0.0.1:10000/devstoreaccount1' })).not.toThrow();
  });
});
