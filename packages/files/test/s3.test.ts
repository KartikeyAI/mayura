import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { createFileStore, s3Files, type S3Credentials } from '@mayura/files';
import { fileStoreConformance } from '../../testing/src/index.js';
import { awsUriEncode, signAwsRequest } from '../src/sigv4.js';

type Source = string | ArrayBuffer | ArrayBufferView;
const bytes = (data: Source) => typeof data === 'string' ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
/** SHA-256 for the AWS SDK's own signer, which the tests use as the reference SigV4 implementation. */
class NodeSha256 {
  private readonly hash;
  constructor(secret?: Source) { this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret)); }
  update(data: Source) { this.hash.update(bytes(data)); }
  async digest() { return new Uint8Array(this.hash.digest()); }
  reset() { /* one use per instance */ }
}
/** The Authorization header the AWS SDK's signer computes for a request, to compare with ours. */
async function referenceAuthorization(request: Request, body: Uint8Array, credentials: S3Credentials, region: string): Promise<string> {
  const url = new URL(request.url); const headers: Record<string, string> = { host: url.host };
  request.headers.forEach((value, name) => { if (name !== 'authorization') headers[name] = value; });
  const date = headers['x-amz-date']!;
  const signingDate = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15)));
  const query: Record<string, string> = {}; url.searchParams.forEach((value, name) => { query[name] = value; });
  const signer = new SignatureV4({ service: 's3', region, credentials, sha256: NodeSha256, uriEscapePath: false, applyChecksum: true });
  const signed = await signer.sign({ method: request.method, protocol: url.protocol, hostname: url.hostname, ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname, query, headers, body }, { signingDate });
  return signed.headers['authorization'] as string;
}

interface Stored { data: Uint8Array; etag: string; contentType: string; metadata: Record<string, string> }
/**
 * A small S3 over path-style URLs: enough of PutObject, GetObject, HeadObject, DeleteObject and ListObjectsV2 to run the
 * file store contract, checking every request's signature against the AWS SDK's signer.
 */
function emulator(credentials: S3Credentials, region = 'us-east-1', seen: Request[] = []) {
  const buckets = new Map<string, Map<string, Stored>>(); let version = 0; const signatureFailures: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); seen.push(request.clone());
    const body = new Uint8Array(await request.arrayBuffer());
    if (request.headers.get('authorization') !== await referenceAuthorization(request, body, credentials, region)) {
      signatureFailures.push(`${request.method} ${request.url}`);
      return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    }
    const url = new URL(request.url); const [, bucketName, ...rest] = url.pathname.split('/');
    const bucket = buckets.get(bucketName!) ?? buckets.set(bucketName!, new Map()).get(bucketName!)!;
    const key = decodeURIComponent(rest.join('/')); const existing = bucket.get(key);
    const ifMatch = request.headers.get('if-match'); const ifNoneMatch = request.headers.get('if-none-match');
    const describe = (file: Stored) => { const headers = new Headers({ etag: file.etag, 'content-type': file.contentType, 'last-modified': new Date(0).toUTCString() });
      for (const [name, value] of Object.entries(file.metadata)) headers.set(`x-amz-meta-${name}`, value); return headers; };
    if (request.method === 'PUT') {
      if (ifMatch !== null && !existing) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      if ((ifNoneMatch === '*' && existing) || (ifMatch !== null && existing?.etag !== ifMatch)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      const metadata: Record<string, string> = {}; request.headers.forEach((value, name) => { if (name.startsWith('x-amz-meta-')) metadata[name.slice(11)] = value; });
      const file = { data: body, etag: `"${(++version).toString(16).padStart(32, '0')}"`, contentType: request.headers.get('content-type') ?? 'binary/octet-stream', metadata };
      bucket.set(key, file);
      return new Response(null, { status: 200, headers: { etag: file.etag } });
    }
    if (request.method === 'DELETE') { bucket.delete(key); return new Response(null, { status: 204 }); }
    if ((request.method === 'GET' || request.method === 'HEAD') && key !== '') {
      if (!existing) return new Response(request.method === 'HEAD' ? null : '<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      if (ifMatch !== null && existing.etag !== ifMatch) return new Response(null, { status: 412 });
      const headers = describe(existing);
      if (request.method === 'HEAD') { headers.set('content-length', String(existing.data.byteLength)); return new Response(null, { status: 200, headers }); }
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.get('range') ?? '');
      if (!range) { headers.set('content-length', String(existing.data.byteLength)); return new Response(existing.data as BodyInit, { status: 200, headers }); }
      const start = Number(range[1]); if (start >= existing.data.byteLength) return new Response('<Error><Code>InvalidRange</Code></Error>', { status: 416 });
      const end = Math.min(range[2] ? Number(range[2]) : existing.data.byteLength - 1, existing.data.byteLength - 1);
      headers.set('content-range', `bytes ${start}-${end}/${existing.data.byteLength}`);
      return new Response(existing.data.slice(start, end + 1) as BodyInit, { status: 206, headers });
    }
    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''; const limit = Number(url.searchParams.get('max-keys')); const after = url.searchParams.get('continuation-token');
      const keys = [...bucket.keys()].filter(item => item.startsWith(prefix) && (after === null || Buffer.compare(Buffer.from(item), Buffer.from(after)) > 0)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const page = keys.slice(0, limit); const truncated = keys.length > page.length;
      const xml = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
      const encode = (value: string) => encodeURIComponent(value).replace(/%2F/gu, '/').replace(/%20/gu, '+');
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucketName}</Name><Prefix>${encode(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${limit}</MaxKeys><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>`
        + page.map(item => `<Contents><Key>${encode(item)}</Key><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>${xml(bucket.get(item)!.etag)}</ETag><Size>${bucket.get(item)!.data.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
        + (truncated ? `<NextContinuationToken>${xml(page.at(-1)!)}</NextContinuationToken>` : '') + '</ListBucketResult>', { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return new Response(null, { status: 400 });
  }) as typeof globalThis.fetch;
  return { fetch, signatureFailures };
}
const credentials: S3Credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

describe('s3Files keeps the file store contract, with every request signed as the AWS SDK signs it', () => {
  const s3 = emulator(credentials);
  const store = createFileStore(s3Files({ bucket: 'conformance', region: 'us-east-1', credentials, endpoint: 'http://127.0.0.1:9000', fetch: s3.fetch }), { maxFileBytes: 1_048_576 });
  for (const test of fileStoreConformance) it(test.name, async () => {
    expect(await test.run({ store })).toBe(test.name.startsWith('deletes only the version') ? 'skipped' : 'passed');
    expect(s3.signatureFailures).toEqual([]);
  });
});

describe('SigV4', () => {
  it('signs as the AWS SDK does, for keys and queries that need encoding and temporary credentials', async () => {
    const temporary = { ...credentials, sessionToken: 'session/token+with=chars' };
    for (const [path, query] of [['/', []], ['/bucket/a%20b/%E4%B8%AD%E6%96%87/%F0%9F%98%80.txt', []], ['/bucket', [['list-type', '2'], ['prefix', 'a b/ü+&='], ['continuation-token', 'x/y+z=']]]] as const) {
      const url = new URL(`https://s3.eu-west-1.amazonaws.com${path}`);
      const encoded = query.map(([name, value]) => `${awsUriEncode(name, false)}=${awsUriEncode(value, false)}`).sort().join('&');
      const full = new URL(`${url.origin}${path}${encoded ? `?${encoded}` : ''}`);
      const headers = await signAwsRequest({ method: 'GET', url: full, query, headers: { range: 'bytes=0-9', 'x-amz-meta-note': 'Hello  world ' }, payloadHash: createHash('sha256').update('').digest('hex'),
        region: 'eu-west-1', service: 's3', credentials: temporary, now: new Date(Date.UTC(2026, 9, 1, 12, 30, 5)) });
      const request = new Request(full, { headers });
      expect(headers['authorization']).toBe(await referenceAuthorization(request, new Uint8Array(0), temporary, 'eu-west-1'));
      expect(headers['x-amz-security-token']).toBe(temporary.sessionToken);
    }
  });

  it('encodes every byte of UTF-8 except the unreserved characters', () => {
    expect(awsUriEncode('a b+c/ü~._-', false)).toBe('a%20b%2Bc%2F%C3%BC~._-');
    expect(awsUriEncode('a b/c', true)).toBe('a%20b/c');
  });
});

describe('s3Files', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('addresses AWS buckets by host name, and buckets with dots and other services by path', async () => {
    const urls: string[] = [];
    const record = (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response(null, { status: 404 }); }) as typeof globalThis.fetch;
    const head = (options: Partial<Parameters<typeof s3Files>[0]>) => createFileStore(s3Files({ bucket: 'reports', region: 'us-east-1', credentials, fetch: record, ...options }), { maxFileBytes: 64 }).head('q3/sales report.csv');
    await head({}); await head({ bucket: 'my.reports' }); await head({ endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto' }); await head({ endpoint: 'https://acct.r2.cloudflarestorage.com', addressing: 'virtual' });
    expect(urls).toEqual(['https://reports.s3.us-east-1.amazonaws.com/q3/sales%20report.csv', 'https://s3.us-east-1.amazonaws.com/my.reports/q3/sales%20report.csv',
      'https://acct.r2.cloudflarestorage.com/reports/q3/sales%20report.csv', 'https://reports.acct.r2.cloudflarestorage.com/q3/sales%20report.csv']);
  });

  it('signs with the credentials given, fresh for each request, and reads nothing from the environment', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAENVIRONMENT'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'from-env'); vi.stubEnv('AWS_ENDPOINT_URL_S3', 'https://attacker.example');
    const seen: Request[] = []; let calls = 0;
    const temporary = { ...credentials, sessionToken: 'token-1' };
    const s3 = emulator(temporary, 'us-east-1', seen);
    const store = createFileStore(s3Files({ bucket: 'box', region: 'us-east-1', credentials: async () => { calls++; return temporary; }, endpoint: 'http://localhost:9000', fetch: s3.fetch }), { maxFileBytes: 64 });
    await store.put('a.txt', new TextEncoder().encode('hi')); await store.get('a.txt');
    expect(calls).toBe(2); expect(s3.signatureFailures).toEqual([]);
    expect(seen.every(request => request.headers.get('authorization')!.includes('Credential=AKIDEXAMPLE/') && request.headers.get('x-amz-security-token') === 'token-1' && request.url.startsWith('http://localhost:9000/box/'))).toBe(true);
    const failing = createFileStore(s3Files({ bucket: 'box', region: 'us-east-1', credentials: async () => { throw new Error('SECRET'); }, fetch: s3.fetch }), { maxFileBytes: 64 });
    const error = await failing.head('a.txt').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'authentication' }); expect(JSON.stringify(error)).not.toContain('SECRET'); expect(seen).toHaveLength(2);
  });

  it('maps S3 answers: lost races and missing versions to CONFLICT, errors to fixed reasons without the body', async () => {
    const answer = (status: number, body = '<Error><Message>SECRET</Message></Error>') => (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
    const store = (status: number, body?: string) => createFileStore(s3Files({ bucket: 'box', region: 'us-east-1', credentials, fetch: answer(status, body) }), { maxFileBytes: 64 });
    await expect(store(409).put('a', new Uint8Array(1), { ifNoneMatch: '*' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store(404).put('a', new Uint8Array(1), { ifMatch: '"e"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store(412).get('a', { ifMatch: '"e"' })).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const [status, reason] of [[403, 'authentication'], [429, 'rate_limited'], [500, 'unavailable'], [503, 'unavailable'], [400, 'rejected']] as const) {
      const error = await store(status).head('a').catch((caught: unknown) => caught).then(() => store(status).put('a', new Uint8Array(1)).catch((caught: unknown) => caught));
      expect(error).toMatchObject({ reason }); expect(JSON.stringify(error)).not.toContain('SECRET');
    }
    await expect(store(200, '<NotAListing/>').list()).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(store(200, '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>').list()).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('refuses a body larger than the limit from its length, before reading it', async () => {
    let pulled = 0;
    const big = (async () => new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1_024)); } }),
      { status: 200, headers: { etag: '"e"', 'content-length': '1000000' } })) as unknown as typeof globalThis.fetch;
    await expect(createFileStore(s3Files({ bucket: 'box', region: 'us-east-1', credentials, fetch: big }), { maxFileBytes: 64 }).get('a')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(pulled).toBeLessThanOrEqual(1);
    const unbounded = (async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32)); } }), { status: 200, headers: { etag: '"e"' } })) as unknown as typeof globalThis.fetch;
    await expect(createFileStore(s3Files({ bucket: 'box', region: 'us-east-1', credentials, fetch: unbounded }), { maxFileBytes: 64 }).get('a')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('needs a bucket, a region, credentials and an https endpoint (or http on this machine)', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    const make = (options: Partial<Parameters<typeof s3Files>[0]>) => () => s3Files({ bucket: 'box', region: 'us-east-1', credentials, ...options });
    expect(make({})).not.toThrow();
    expect(make({ bucket: 'Bad_Bucket' })).toThrow(invalid); expect(make({ bucket: 'a..b' })).toThrow(invalid);
    expect(make({ region: 'us east' })).toThrow(invalid);
    expect(make({ credentials: { accessKeyId: 'a', secretAccessKey: '' } })).toThrow(invalid);
    expect(make({ endpoint: 'http://minio.internal:9000' })).toThrow(invalid);
    expect(make({ endpoint: 'https://s3.example.com/base' })).toThrow(invalid);
    expect(make({ endpoint: 'https://user:pass@s3.example.com' })).toThrow(invalid);
    expect(make({ endpoint: 'http://[::1]:9000' })).not.toThrow();
  });
});
