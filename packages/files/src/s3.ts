import { MayuraError } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { fileConflict, FileStoreError, type FileBackend, type FileInfo, type StoredFile } from './contracts.js';
import { awsCanonicalQuery, awsUriEncode, signAwsRequest, type AwsCredentials } from './sigv4.js';
import { fileBody, fileResponseFailure } from './transport.js';

export type S3Credentials = AwsCredentials;

export interface S3FilesOptions {
  /** The bucket. */
  readonly bucket: string;
  /** The bucket's region, such as `us-east-1`; `auto` for Cloudflare R2. */
  readonly region: string;
  /** Access keys, or a function returning fresh ones (for example from your own STS call). Nothing is read from the environment. */
  readonly credentials: S3Credentials | (() => S3Credentials | Promise<S3Credentials>);
  /**
   * An S3-compatible service's endpoint instead of AWS's, such as `https://<account>.r2.cloudflarestorage.com`: an
   * https origin, or an http one on this machine (`http://127.0.0.1:9000`) for local servers.
   */
  readonly endpoint?: string;
  /**
   * `virtual` puts the bucket in the host name (`bucket.s3.us-east-1.amazonaws.com`), `path` in the path
   * (`endpoint/bucket`). Virtual on AWS by default, path with an `endpoint` or a bucket name containing dots.
   */
  readonly addressing?: 'virtual' | 'path';
  /** Send `ifMatch` on deletes. Turn it on only for a service that honours If-Match on DeleteObject. */
  readonly conditionalDelete?: boolean;
  /** The largest list response read; 16 MiB by default. */
  readonly maxListResponseBytes?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

const xmlEntities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(value: string): string {
  return value.replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gu, (_, entity: string) => entity.startsWith('#x') ? String.fromCodePoint(parseInt(entity.slice(2), 16))
    : entity.startsWith('#') ? String.fromCodePoint(Number(entity.slice(1))) : xmlEntities[entity]!);
}
function xmlTag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(xml);
  return match ? xmlText(match[1]!) : undefined;
}
/** A key as S3 lists it with `encoding-type=url`: URL-encoded, with `+` for a space. */
function listedKey(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/gu, ' ')); } catch { throw new FileStoreError('invalid_response'); }
}
const lastModified = (value: string | null | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const loopback = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Files in an S3 bucket, or in any S3-compatible service (Cloudflare R2, MinIO, Backblaze B2 and others through
 * `endpoint`): `createFileStore(s3Files({ bucket, region, credentials }), { maxFileBytes })`. Requests are signed
 * with SigV4 and sent with fetch, so it runs on Node, Bun, Deno, Workers and Vercel Edge, with no AWS SDK.
 */
export function s3Files(options: S3FilesOptions): FileBackend {
  if (!options) throw new MayuraError('INVALID_CONFIG', 's3Files() needs a bucket, region and credentials.');
  const { bucket, region } = options;
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes('..')) throw new MayuraError('INVALID_CONFIG', 's3Files(): bucket must be a bucket name.');
  if (typeof region !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(region)) throw new MayuraError('INVALID_CONFIG', 's3Files(): region must be a region, such as us-east-1 or auto.');
  const credentialSource = options.credentials;
  if (typeof credentialSource !== 'function') checkCredentials(credentialSource, 'INVALID_CONFIG');
  let origin: URL;
  try { origin = new URL(options.endpoint ?? `https://s3.${region}.amazonaws.com`); } catch { throw new MayuraError('INVALID_CONFIG', 's3Files(): endpoint must be a URL.'); }
  const local = origin.protocol === 'http:' && loopback.includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !local) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new MayuraError('INVALID_CONFIG', 's3Files(): endpoint must be an https origin (or an http one on this machine), without a path, credentials or query.');
  }
  const addressing = options.addressing ?? (options.endpoint === undefined && !bucket.includes('.') ? 'virtual' : 'path');
  if (addressing !== 'virtual' && addressing !== 'path') throw new MayuraError('INVALID_CONFIG', "s3Files(): addressing is 'virtual' or 'path'.");
  const conditionalDelete = options.conditionalDelete ?? false;
  if (typeof conditionalDelete !== 'boolean') throw new MayuraError('INVALID_CONFIG', 's3Files(): conditionalDelete must be a boolean.');
  const maxListResponseBytes = options.maxListResponseBytes ?? 16 * 1_048_576;
  if (!Number.isSafeInteger(maxListResponseBytes) || maxListResponseBytes <= 0) throw new MayuraError('INVALID_CONFIG', 's3Files(): maxListResponseBytes must be a positive integer.');
  const base = addressing === 'virtual' ? `${origin.protocol}//${bucket}.${origin.host}` : `${origin.protocol}//${origin.host}/${bucket}`;
  const transport = options.fetch ?? globalThis.fetch;

  const credentials = async (): Promise<S3Credentials> => {
    if (typeof credentialSource !== 'function') return credentialSource;
    let value: unknown;
    try { value = await credentialSource(); } catch { throw new FileStoreError('authentication'); }
    return checkCredentials(value, 'authentication');
  };
  const send = async (method: string, key: string | undefined, init: { query?: readonly (readonly [string, string])[]; headers?: Record<string, string>; body?: Uint8Array; signal: AbortSignal }) => {
    const query = init.query ?? [];
    const path = key === undefined ? (addressing === 'virtual' ? '/' : '') : `/${awsUriEncode(key, true)}`;
    const search = awsCanonicalQuery(query);
    const url = new URL(`${base}${path}${search ? `?${search}` : ''}`);
    const body = init.body ?? new Uint8Array(0);
    const headers = await signAwsRequest({ method, url, query, headers: init.headers ?? {}, payloadHash: sha256Hex(body), region, service: 's3', credentials: await credentials(), now: new Date() });
    return transport(url, { method, headers, signal: init.signal, redirect: 'error', ...(init.body ? { body: init.body as BodyInit } : {}) });
  };
  const describe = (key: string, response: Response, size: number): FileInfo => {
    const etag = response.headers.get('etag');
    if (!etag) throw new FileStoreError('invalid_response');
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (name.startsWith('x-amz-meta-')) metadata[name.slice(11)] = value; });
    const type = response.headers.get('content-type'); const modified = lastModified(response.headers.get('last-modified'));
    return { key, size, etag, ...(type ? { contentType: type } : {}), ...(modified === undefined ? {} : { lastModified: modified }), ...(Object.keys(metadata).length ? { metadata } : {}) };
  };
  const head = async (key: string, signal: AbortSignal): Promise<FileInfo | undefined> => {
    const response = await send('HEAD', key, { signal });
    if (response.status === 404) return undefined;
    if (!response.ok) throw fileResponseFailure(response);
    const length = response.headers.get('content-length');
    if (length === null || !/^\d{1,16}$/u.test(length)) throw new FileStoreError('invalid_response');
    return describe(key, response, Number(length));
  };

  return Object.freeze({
    id: 's3',
    conditionalWrites: true,
    conditionalDelete,
    async put(key, data, putOptions) {
      const headers: Record<string, string> = { 'content-type': putOptions.contentType };
      for (const [name, value] of Object.entries(putOptions.metadata)) headers[`x-amz-meta-${name}`] = value;
      if (putOptions.ifNoneMatch) headers['if-none-match'] = '*';
      if (putOptions.ifMatch !== undefined) headers['if-match'] = putOptions.ifMatch;
      const response = await send('PUT', key, { headers, body: data, signal: putOptions.signal });
      const conditional = putOptions.ifNoneMatch !== undefined || putOptions.ifMatch !== undefined;
      // S3 answers a conditional write that lost a race with 409, and If-Match on a missing key with 404.
      if (conditional && (response.status === 409 || (response.status === 404 && putOptions.ifMatch !== undefined))) { void response.body?.cancel().catch(() => undefined); throw fileConflict(); }
      if (!response.ok) throw fileResponseFailure(response);
      void response.body?.cancel().catch(() => undefined);
      const etag = response.headers.get('etag');
      if (!etag) throw new FileStoreError('invalid_response');
      return { etag };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const headers: Record<string, string> = {};
      const range = getOptions.range;
      if (range && (range.offset > 0 || range.length !== undefined)) headers['range'] = `bytes=${range.offset}-${range.length === undefined ? '' : range.offset + range.length - 1}`;
      if (getOptions.ifMatch !== undefined) headers['if-match'] = getOptions.ifMatch;
      const response = await send('GET', key, { headers, signal: getOptions.signal });
      if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
      if (response.status === 416) {
        // A range that starts at or past the end: the file is there, and the range holds nothing.
        void response.body?.cancel().catch(() => undefined);
        const file = await head(key, getOptions.signal);
        if (file && getOptions.ifMatch !== undefined && file.etag !== getOptions.ifMatch) throw fileConflict();
        return file ? { ...file, data: new Uint8Array(0) } : undefined;
      }
      if (!response.ok) throw fileResponseFailure(response);
      let size: number;
      if (response.status === 206) {
        const match = /^bytes \d+-\d+\/(\d{1,16})$/u.exec(response.headers.get('content-range') ?? '');
        if (!match) { void response.body?.cancel().catch(() => undefined); throw new FileStoreError('invalid_response'); }
        size = Number(match[1]);
      } else size = -1;
      const data = await fileBody(response, getOptions.maxBytes);
      return { ...describe(key, response, size === -1 ? data.byteLength : size), data };
    },
    head: (key, headOptions) => head(key, headOptions.signal),
    async list(listOptions) {
      const query: [string, string][] = [['list-type', '2'], ['encoding-type', 'url'], ['max-keys', String(listOptions.limit)]];
      if (listOptions.prefix) query.push(['prefix', listOptions.prefix]);
      if (listOptions.cursor !== undefined) query.push(['continuation-token', listOptions.cursor]);
      const response = await send('GET', undefined, { query, signal: listOptions.signal });
      if (!response.ok) throw fileResponseFailure(response);
      let xml: string;
      try { xml = new TextDecoder('utf-8', { fatal: true }).decode(await fileBody(response, maxListResponseBytes)); } catch { throw new FileStoreError('invalid_response'); }
      if (!/<ListBucketResult[\s>]/u.test(xml)) throw new FileStoreError('invalid_response');
      const files: FileInfo[] = [];
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
        const key = xmlTag(entry!, 'Key'); const size = xmlTag(entry!, 'Size'); const etag = xmlTag(entry!, 'ETag');
        if (key === undefined || size === undefined || !/^\d{1,16}$/u.test(size) || !etag) throw new FileStoreError('invalid_response');
        const modified = lastModified(xmlTag(entry!, 'LastModified'));
        files.push({ key: listedKey(key), size: Number(size), etag, ...(modified === undefined ? {} : { lastModified: modified }) });
      }
      const truncated = xmlTag(xml, 'IsTruncated') === 'true';
      const next = xmlTag(xml, 'NextContinuationToken');
      if (truncated && !next) throw new FileStoreError('invalid_response');
      return { files, ...(truncated ? { cursor: next! } : {}) };
    },
    async delete(key, deleteOptions) {
      const headers: Record<string, string> = deleteOptions.ifMatch === undefined ? {} : { 'if-match': deleteOptions.ifMatch };
      const response = await send('DELETE', key, { headers, signal: deleteOptions.signal });
      if (deleteOptions.ifMatch !== undefined && (response.status === 404 || response.status === 409)) { void response.body?.cancel().catch(() => undefined); throw fileConflict(); }
      if (!response.ok && response.status !== 404) throw fileResponseFailure(response);
      void response.body?.cancel().catch(() => undefined);
    },
  } satisfies FileBackend);
}

function checkCredentials(value: unknown, code: 'INVALID_CONFIG' | 'authentication'): S3Credentials {
  const credentials = value as Partial<S3Credentials> | null;
  const header = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 4_096 && /^[!-~]+$/u.test(item);
  if (!credentials || typeof credentials !== 'object' || !header(credentials.accessKeyId) || !header(credentials.secretAccessKey)
    || (credentials.sessionToken !== undefined && !header(credentials.sessionToken))) {
    if (code === 'authentication') throw new FileStoreError('authentication');
    throw new MayuraError('INVALID_CONFIG', 's3Files(): credentials need an accessKeyId and a secretAccessKey.');
  }
  return { accessKeyId: credentials.accessKeyId!, secretAccessKey: credentials.secretAccessKey!, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) };
}
