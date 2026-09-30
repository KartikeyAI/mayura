import { MayuraError } from 'mayura';
import { fileBody, fileConflict, FileStoreError, fileHttpFailure, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

export interface VercelBlobFilesOptions {
  /**
   * The store's read-write token (`vercel_blob_rw_...`). Required: nothing is read from the environment, where
   * `@vercel/blob` would also read the API's address.
   */
  readonly token: string;
  /** Another Blob API address instead of https://vercel.com/api/blob, for tests: https, or http on this machine. */
  readonly apiURL?: string;
  /** Another address for reading blobs instead of the store's own, for tests: https, or http on this machine. */
  readonly blobURL?: string;
  /** The largest API response read; 16 MiB by default. */
  readonly maxResponseBytes?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The Blob API version these requests are written against, as `@vercel/blob` 2.8 sends it. */
export const vercelBlobApiVersion = '12';

const loopback = ['localhost', '127.0.0.1', '[::1]'];
function origin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new MayuraError('INVALID_CONFIG', `vercelBlobFiles(): ${name} must be a URL.`); }
  const local = url.protocol === 'http:' && loopback.includes(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) {
    throw new MayuraError('INVALID_CONFIG', `vercelBlobFiles(): ${name} must be https (or http on this machine), without credentials or query.`);
  }
  return url.href.replace(/\/$/u, '');
}
const encodePath = (key: string) => key.split('/').map(encodeURIComponent).join('/');

/**
 * Files in a private Vercel Blob store: `createFileStore(vercelBlobFiles({ token }), { maxFileBytes })`. Requests go
 * over fetch in the form `@vercel/blob` 2.8 sends them (Blob API version 12), without its dependencies or its
 * environment variables. Writes are create-only unless overwriting (`ifNoneMatch`), `ifMatch` guards writes and
 * deletes, and reads bypass the CDN cache, so they see the latest version. Vercel Blob keeps no custom metadata: a
 * write with metadata is refused.
 */
export function vercelBlobFiles(options: VercelBlobFilesOptions): FileBackend {
  const token = options?.token;
  if (typeof token !== 'string' || !/^vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]+$/u.test(token) || token.length > 512) {
    throw new MayuraError('INVALID_CONFIG', 'vercelBlobFiles() needs the store\'s read-write token (vercel_blob_rw_...).');
  }
  const storeId = token.split('_')[3]!;
  const api = origin(options.apiURL ?? 'https://vercel.com/api/blob', 'apiURL');
  const blobs = origin(options.blobURL ?? `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com`, 'blobURL');
  const maxResponseBytes = options.maxResponseBytes ?? 16 * 1_048_576;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new MayuraError('INVALID_CONFIG', 'vercelBlobFiles(): maxResponseBytes must be a positive integer.');
  const transport = options.fetch ?? globalThis.fetch;

  /** A Blob API request, with the headers `@vercel/blob` sends. */
  const request = (path: string, init: RequestInit & { headers?: Record<string, string> }) => transport(`${api}${path}`, {
    ...init, redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'x-api-version': vercelBlobApiVersion, 'x-vercel-blob-store-id': storeId, ...init.headers },
  });
  /** The error code the Blob API gives, read only to classify it: its message is never kept. */
  const errorCode = async (response: Response): Promise<string | undefined> => {
    try {
      const body = JSON.parse(new TextDecoder().decode(await fileBody(response, 65_536))) as { error?: { code?: unknown } };
      return typeof body?.error?.code === 'string' ? body.error.code : undefined;
    } catch { return undefined; }
  };
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fileBody(response, maxResponseBytes)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value as Record<string, unknown>;
    } catch { throw new FileStoreError('invalid_response'); }
  };
  const describe = (value: Record<string, unknown>, key?: string): FileInfo => {
    const { pathname, size, etag, contentType, uploadedAt } = value;
    if (typeof pathname !== 'string' || (key !== undefined && pathname !== key) || !Number.isSafeInteger(size) || (size as number) < 0 || typeof etag !== 'string' || !etag) {
      throw new FileStoreError('invalid_response');
    }
    const uploaded = typeof uploadedAt === 'string' ? Date.parse(uploadedAt) : NaN;
    return { key: pathname, size: size as number, etag, ...(typeof contentType === 'string' ? { contentType } : {}), ...(Number.isFinite(uploaded) ? { lastModified: uploaded } : {}) };
  };
  const head = async (key: string, signal: AbortSignal): Promise<FileInfo | undefined> => {
    const response = await request(`?${new URLSearchParams({ url: key })}`, { method: 'GET', signal });
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
    if (!response.ok) { const code = await errorCode(response); if (code === 'not_found') return undefined; throw fileHttpFailure(response.status); }
    return describe(await json(response), key);
  };

  return Object.freeze({
    id: 'vercel-blob',
    conditionalWrites: true,
    conditionalDelete: true,
    async put(key, data, putOptions) {
      if (Object.keys(putOptions.metadata).length) throw new MayuraError('INVALID_INPUT', 'Vercel Blob keeps no custom metadata.');
      // Vercel Blob refuses to replace a blob unless told it may: create-only is its default.
      const headers: Record<string, string> = { 'x-vercel-blob-access': 'private', 'x-content-type': putOptions.contentType, 'x-add-random-suffix': '0',
        'x-allow-overwrite': putOptions.ifNoneMatch ? '0' : '1', ...(putOptions.ifMatch === undefined ? {} : { 'x-if-match': putOptions.ifMatch }) };
      const response = await request(`/?${new URLSearchParams({ pathname: key })}`, { method: 'PUT', body: data as BodyInit, headers, signal: putOptions.signal });
      if (!response.ok) {
        const code = await errorCode(response);
        if (code === 'precondition_failed' || response.status === 412) throw fileConflict();
        if (putOptions.ifMatch !== undefined && (code === 'not_found' || response.status === 404)) throw fileConflict();
        // A create-only write the service refused: a conflict when the blob is there.
        if (putOptions.ifNoneMatch && response.status >= 400 && response.status < 500 && ![401, 403, 429].includes(response.status)
          && await head(key, putOptions.signal) !== undefined) throw fileConflict();
        throw fileHttpFailure(response.status);
      }
      const written = await json(response);
      if (written['pathname'] !== key || typeof written['etag'] !== 'string' || !written['etag']) throw new FileStoreError('invalid_response');
      return { etag: written['etag'] };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const range = getOptions.range && (getOptions.range.offset > 0 || getOptions.range.length !== undefined) ? getOptions.range : undefined;
      // A blob replaced between reading its information and its bytes: read it again, a few times at most.
      for (let attempt = 0; attempt < 3; attempt++) {
        const file = await head(key, getOptions.signal);
        if (file === undefined) return undefined;
        if (getOptions.ifMatch !== undefined && file.etag !== getOptions.ifMatch) throw fileConflict();
        const offset = range?.offset ?? 0;
        if (offset >= file.size && file.size > 0) return { ...file, data: new Uint8Array(0) };
        const end = range?.length === undefined ? file.size : Math.min(file.size, offset + range.length);
        if (end - offset > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
        // Private blobs, read past the CDN cache so the bytes are the latest version.
        const response = await transport(`${blobs}/${encodePath(key)}?cache=0`, { method: 'GET', redirect: 'error', signal: getOptions.signal,
          headers: { authorization: `Bearer ${token}`, ...(range ? { range: `bytes=${offset}-${end - 1}` } : {}) } });
        const cancel = () => { void response.body?.cancel().catch(() => undefined); };
        if (response.status === 404) { cancel(); if (getOptions.ifMatch !== undefined) throw fileConflict(); continue; }
        if (!response.ok) { cancel(); throw fileHttpFailure(response.status); }
        // The bytes must be the version described: otherwise the blob changed in between.
        const etag = response.headers.get('etag');
        if (etag !== null && etag !== file.etag) { cancel(); if (getOptions.ifMatch !== undefined) throw fileConflict(); continue; }
        const whole = response.status !== 206;
        // A service that ignores the range answers with the whole file, which must fit the limit too.
        if (whole && range && file.size > getOptions.maxBytes) { cancel(); throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`); }
        let data = await fileBody(response, whole ? file.size : end - offset);
        if (whole && range) data = data.slice(offset, end);
        if (data.byteLength !== end - offset) throw new FileStoreError('invalid_response');
        return { ...file, data };
      }
      throw new FileStoreError('unavailable');
    },
    head: (key, headOptions) => head(key, headOptions.signal),
    async list(listOptions) {
      const query = new URLSearchParams({ limit: String(listOptions.limit), mode: 'expanded' });
      if (listOptions.prefix) query.set('prefix', listOptions.prefix);
      if (listOptions.cursor !== undefined) query.set('cursor', listOptions.cursor);
      const response = await request(`?${query}`, { method: 'GET', signal: listOptions.signal });
      if (!response.ok) { await errorCode(response); throw fileHttpFailure(response.status); }
      const body = await json(response);
      if (!Array.isArray(body['blobs']) || typeof body['hasMore'] !== 'boolean' || (body['hasMore'] && (typeof body['cursor'] !== 'string' || !body['cursor']))) throw new FileStoreError('invalid_response');
      return { files: (body['blobs'] as Record<string, unknown>[]).map(item => describe(item)), ...(body['hasMore'] ? { cursor: body['cursor'] as string } : {}) };
    },
    async delete(key, deleteOptions) {
      const response = await request('/delete', { method: 'POST', signal: deleteOptions.signal, body: JSON.stringify({ urls: [key] }),
        headers: { 'content-type': 'application/json', ...(deleteOptions.ifMatch === undefined ? {} : { 'x-if-match': deleteOptions.ifMatch }) } });
      if (response.ok) { void response.body?.cancel().catch(() => undefined); return; }
      const code = await errorCode(response);
      if (code === 'precondition_failed' || response.status === 412) throw fileConflict();
      if (code === 'not_found' || response.status === 404) { if (deleteOptions.ifMatch !== undefined) throw fileConflict(); return; }
      throw fileHttpFailure(response.status);
    },
  } satisfies FileBackend);
}
