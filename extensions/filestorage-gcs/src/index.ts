import { MayuraError } from 'mayura';
import { fileBody, fileConflict, FileStoreError, fileResponseFailure, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

export interface GcsFilesOptions {
  /** The bucket. */
  readonly bucket: string;
  /**
   * An OAuth access token source with a Cloud Storage scope, such as a service account's through google-auth-library
   * (`() => auth.getAccessToken()`), called for each request. Nothing is read from the environment.
   */
  readonly token: () => string | Promise<string>;
  /** The project billed for requests to a Requester Pays bucket. */
  readonly userProject?: string;
  /** Another endpoint instead of https://storage.googleapis.com: https, or http on this machine for an emulator. */
  readonly endpoint?: string;
  /** The largest list response read; 16 MiB by default. */
  readonly maxListResponseBytes?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

interface GcsObject { readonly name?: unknown; readonly size?: unknown; readonly generation?: unknown; readonly contentType?: unknown; readonly updated?: unknown; readonly metadata?: unknown }

const loopback = ['localhost', '127.0.0.1', '[::1]'];
const generationPattern = /^[1-9]\d{0,19}$/u;

/**
 * Files in a Google Cloud Storage bucket, over the JSON API with fetch and no dependencies:
 * `createFileStore(gcsFiles({ bucket, token }), { maxFileBytes })`. A file's etag is its generation, so `ifMatch`
 * and `ifNoneMatch` are Cloud Storage's own generation preconditions, conditional deletes included.
 */
export function gcsFiles(options: GcsFilesOptions): FileBackend {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'gcsFiles() needs a bucket and a token source.');
  const { bucket, token, userProject } = options;
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u.test(bucket) || bucket.includes('..')) throw new MayuraError('INVALID_CONFIG', 'gcsFiles(): bucket must be a bucket name.');
  if (typeof token !== 'function') throw new MayuraError('INVALID_CONFIG', 'gcsFiles(): token must be a function returning an access token.');
  if (userProject !== undefined && (typeof userProject !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(userProject))) throw new MayuraError('INVALID_CONFIG', 'gcsFiles(): userProject must be a project id.');
  let origin: URL;
  try { origin = new URL(options.endpoint ?? 'https://storage.googleapis.com'); } catch { throw new MayuraError('INVALID_CONFIG', 'gcsFiles(): endpoint must be a URL.'); }
  const local = origin.protocol === 'http:' && loopback.includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !local) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new MayuraError('INVALID_CONFIG', 'gcsFiles(): endpoint must be an https origin (or an http one on this machine), without a path, credentials or query.');
  }
  const maxListResponseBytes = options.maxListResponseBytes ?? 16 * 1_048_576;
  if (!Number.isSafeInteger(maxListResponseBytes) || maxListResponseBytes <= 0) throw new MayuraError('INVALID_CONFIG', 'gcsFiles(): maxListResponseBytes must be a positive integer.');
  const base = `${origin.protocol}//${origin.host}`;
  const transport = options.fetch ?? globalThis.fetch;

  const authorization = async (): Promise<string> => {
    let value: unknown;
    try { value = await token(); } catch { throw new FileStoreError('authentication'); }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 16_384) throw new FileStoreError('authentication');
    return `Bearer ${value}`;
  };
  const url = (path: string, query: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined) search.set(name, value);
    if (userProject) search.set('userProject', userProject);
    const text = search.toString();
    return `${base}${path}${text ? `?${text}` : ''}`;
  };
  const objectPath = (key: string) => `/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`;
  const send = async (target: string, init: RequestInit & { headers?: Record<string, string> }) =>
    transport(target, { ...init, redirect: 'error', headers: { ...init.headers, authorization: await authorization() } });
  /** A generation from an etag this backend issued; anything else cannot match a file here. */
  const generation = (etag: string) => { if (!generationPattern.test(etag)) throw fileConflict(); return etag; };
  const json = async (response: Response, maxBytes: number): Promise<unknown> => {
    const bytes = await fileBody(response, maxBytes);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new FileStoreError('invalid_response'); }
  };
  const describe = (value: unknown, key?: string): FileInfo => {
    const object = value as GcsObject | null;
    if (!object || typeof object.name !== 'string' || (key !== undefined && object.name !== key) || typeof object.size !== 'string' || !/^\d{1,16}$/u.test(object.size)
      || typeof object.generation !== 'string' || !generationPattern.test(object.generation)) throw new FileStoreError('invalid_response');
    const updated = typeof object.updated === 'string' ? Date.parse(object.updated) : NaN;
    let metadata: Record<string, string> | undefined;
    if (object.metadata !== undefined && object.metadata !== null) {
      if (typeof object.metadata !== 'object' || Object.values(object.metadata).some(item => typeof item !== 'string')) throw new FileStoreError('invalid_response');
      if (Object.keys(object.metadata).length) metadata = { ...(object.metadata as Record<string, string>) };
    }
    return { key: object.name, size: Number(object.size), etag: object.generation, ...(typeof object.contentType === 'string' ? { contentType: object.contentType } : {}),
      ...(Number.isFinite(updated) ? { lastModified: updated } : {}), ...(metadata ? { metadata } : {}) };
  };
  const head = async (key: string, signal: AbortSignal, ifMatch?: string): Promise<FileInfo | undefined> => {
    const response = await send(url(objectPath(key), { ifGenerationMatch: ifMatch === undefined ? undefined : generation(ifMatch) }), { method: 'GET', signal });
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
    if (!response.ok) throw fileResponseFailure(response);
    return describe(await json(response, 1_048_576), key);
  };

  return Object.freeze({
    id: 'gcs',
    conditionalWrites: true,
    conditionalDelete: true,
    async put(key, data, putOptions) {
      const boundary = `mayura-${crypto.randomUUID()}`;
      const meta = JSON.stringify({ name: key, contentType: putOptions.contentType, ...(Object.keys(putOptions.metadata).length ? { metadata: putOptions.metadata } : {}) });
      const opening = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${putOptions.contentType}\r\n\r\n`);
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(opening.byteLength + data.byteLength + tail.byteLength);
      body.set(opening); body.set(data, opening.byteLength); body.set(tail, opening.byteLength + data.byteLength);
      const ifGenerationMatch = putOptions.ifNoneMatch ? '0' : putOptions.ifMatch === undefined ? undefined : generation(putOptions.ifMatch);
      const response = await send(url(`/upload/storage/v1/b/${bucket}/o`, { uploadType: 'multipart', ifGenerationMatch }), {
        method: 'POST', signal: putOptions.signal, headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: body as BodyInit,
      });
      if (!response.ok) throw fileResponseFailure(response);
      const written = describe(await json(response, 1_048_576), key);
      return { etag: written.etag, ...(written.lastModified === undefined ? {} : { lastModified: written.lastModified }) };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      // A file replaced between reading its information and its bytes: read it again, a few times at most.
      for (let attempt = 0; attempt < 3; attempt++) {
        const file = await head(key, getOptions.signal, getOptions.ifMatch);
        if (file === undefined) return undefined;
        const offset = getOptions.range?.offset ?? 0;
        if (offset >= file.size) return { ...file, data: new Uint8Array(0) };
        const end = getOptions.range?.length === undefined ? file.size : Math.min(file.size, offset + getOptions.range.length);
        if (end - offset > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
        // Download exactly the generation described, so the bytes and the information are one version.
        const response = await send(url(objectPath(key), { alt: 'media', generation: file.etag }), { method: 'GET', signal: getOptions.signal,
          headers: offset > 0 || end < file.size ? { range: `bytes=${offset}-${end - 1}` } : {} });
        if (response.status === 404) {
          void response.body?.cancel().catch(() => undefined);
          if (getOptions.ifMatch !== undefined) throw fileConflict();
          continue;
        }
        if (!response.ok) throw fileResponseFailure(response);
        const data = await fileBody(response, getOptions.maxBytes);
        if (data.byteLength !== end - offset) throw new FileStoreError('invalid_response');
        return { ...file, data };
      }
      throw new FileStoreError('unavailable');
    },
    head: (key, headOptions) => head(key, headOptions.signal),
    async list(listOptions) {
      const response = await send(url(`/storage/v1/b/${bucket}/o`, { prefix: listOptions.prefix || undefined, maxResults: String(listOptions.limit), pageToken: listOptions.cursor,
        fields: 'items(name,size,generation,contentType,updated),nextPageToken' }), { method: 'GET', signal: listOptions.signal });
      if (!response.ok) throw fileResponseFailure(response);
      const body = await json(response, maxListResponseBytes) as { items?: unknown; nextPageToken?: unknown } | null;
      if (!body || typeof body !== 'object' || (body.items !== undefined && !Array.isArray(body.items)) || (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string')) throw new FileStoreError('invalid_response');
      return { files: ((body.items ?? []) as unknown[]).map(item => describe(item)), ...(body.nextPageToken ? { cursor: body.nextPageToken } : {}) };
    },
    async delete(key, deleteOptions) {
      const ifGenerationMatch = deleteOptions.ifMatch === undefined ? undefined : generation(deleteOptions.ifMatch);
      const response = await send(url(objectPath(key), { ifGenerationMatch }), { method: 'DELETE', signal: deleteOptions.signal });
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404) { if (ifGenerationMatch !== undefined) throw fileConflict(); return; }
      if (!response.ok) throw fileResponseFailure(response);
    },
  } satisfies FileBackend);
}
