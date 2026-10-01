import { MayuraError } from 'mayura';
import { utf8ByteLength } from 'mayura/core/host';
import { fileBody, FileStoreError, fileResponseFailure, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

export interface GoogleDriveFilesOptions {
  /**
   * An OAuth access token source with a Drive scope, called for each request: `drive.file` (files this app created)
   * or `drive.appdata` (the hidden app folder). Nothing is read from the environment.
   */
  readonly token: () => string | Promise<string>;
  /** The folder the files live in: a folder id, or `appDataFolder` for the app's hidden folder. */
  readonly folderId: string;
  /** Delete files outright instead of moving them to the trash, where they can be restored. Off by default. */
  readonly permanentDelete?: boolean;
  /** The most files a listing reads from the folder; 10,000 by default. Drive cannot list by prefix or in key order. */
  readonly maxFolderFiles?: number;
  /** Another endpoint instead of https://www.googleapis.com: https, or http on this machine for tests. */
  readonly endpoint?: string;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

interface DriveFile { readonly id?: unknown; readonly name?: unknown; readonly size?: unknown; readonly version?: unknown; readonly mimeType?: unknown; readonly modifiedTime?: unknown; readonly appProperties?: unknown }

const loopback = ['localhost', '127.0.0.1', '[::1]'];
const fields = 'id,name,size,version,mimeType,modifiedTime,appProperties';
/** A string literal for a Drive query: quoted, with backslashes and quotes escaped. */
const literal = (value: string) => `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
const compareKeys = (left: string, right: string) => {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

/**
 * Files in one Google Drive folder, over the Drive API v3 with fetch and no dependencies:
 * `createFileStore(googleDriveFiles({ token, folderId }), { maxFileBytes })`. Each file is named by its key.
 *
 * Drive has no preconditions and does not keep names unique, so the store's `conditionalWrites` and
 * `conditionalDelete` are false: `ifMatch` and `ifNoneMatch` are refused, and two writers racing to create one key can
 * leave two files, of which reads take the newest. A file's etag is its Drive version. Drive cannot list by prefix or
 * in key order, so a listing reads the folder (up to `maxFolderFiles`) and sorts it. Deletes move files to the trash
 * unless `permanentDelete` is set. Metadata is kept as app properties, each at most 124 bytes.
 */
export function googleDriveFiles(options: GoogleDriveFilesOptions): FileBackend {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles() needs a token source and a folderId.');
  const { token, folderId } = options;
  if (typeof token !== 'function') throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles(): token must be a function returning an access token.');
  if (typeof folderId !== 'string' || !/^(?:appDataFolder|[A-Za-z0-9_-]{10,200})$/u.test(folderId)) throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles(): folderId must be a Drive folder id or appDataFolder.');
  const permanentDelete = options.permanentDelete ?? false;
  if (typeof permanentDelete !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles(): permanentDelete must be a boolean.');
  const maxFolderFiles = options.maxFolderFiles ?? 10_000;
  if (!Number.isSafeInteger(maxFolderFiles) || maxFolderFiles < 1 || maxFolderFiles > 1_000_000) throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles(): maxFolderFiles must be 1 to 1,000,000.');
  let origin: URL;
  try { origin = new URL(options.endpoint ?? 'https://www.googleapis.com'); } catch { throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles(): endpoint must be a URL.'); }
  const local = origin.protocol === 'http:' && loopback.includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !local) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new MayuraError('INVALID_CONFIG', 'googleDriveFiles(): endpoint must be an https origin (or an http one on this machine), without a path, credentials or query.');
  }
  const base = `${origin.protocol}//${origin.host}`;
  const transport = options.fetch ?? globalThis.fetch;
  const appData = folderId === 'appDataFolder';

  const authorization = async (): Promise<string> => {
    let value: unknown;
    try { value = await token(); } catch { throw new FileStoreError('authentication'); }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 16_384) throw new FileStoreError('authentication');
    return `Bearer ${value}`;
  };
  const send = async (url: string, init: RequestInit & { headers?: Record<string, string> }) =>
    transport(url, { ...init, redirect: 'error', headers: { ...init.headers, authorization: await authorization() } });
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fileBody(response, 16 * 1_048_576)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value as Record<string, unknown>;
    } catch { throw new FileStoreError('invalid_response'); }
  };
  const describe = (file: DriveFile): FileInfo & { readonly id: string } => {
    if (typeof file?.id !== 'string' || typeof file.name !== 'string' || typeof file.version !== 'string' || !/^\d{1,20}$/u.test(file.version)
      || (file.size !== undefined && (typeof file.size !== 'string' || !/^\d{1,16}$/u.test(file.size)))) throw new FileStoreError('invalid_response');
    const modified = typeof file.modifiedTime === 'string' ? Date.parse(file.modifiedTime) : NaN;
    let metadata: Record<string, string> | undefined;
    if (file.appProperties !== undefined && file.appProperties !== null) {
      if (typeof file.appProperties !== 'object' || Object.values(file.appProperties).some(item => typeof item !== 'string')) throw new FileStoreError('invalid_response');
      if (Object.keys(file.appProperties).length) metadata = { ...(file.appProperties as Record<string, string>) };
    }
    return { id: file.id, key: file.name, size: Number(file.size ?? '0'), etag: file.version, ...(typeof file.mimeType === 'string' ? { contentType: file.mimeType } : {}),
      ...(Number.isFinite(modified) ? { lastModified: modified } : {}), ...(metadata ? { metadata } : {}) };
  };
  /** One page of the folder's files, optionally only those named `name`, newest first. */
  const query = async (signal: AbortSignal, name: string | undefined, pageToken?: string) => {
    const params = new URLSearchParams({ q: `${literal(folderId)} in parents and trashed = false${name === undefined ? '' : ` and name = ${literal(name)}`}`,
      fields: `nextPageToken,files(${fields})`, pageSize: '1000', orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      ...(appData ? { spaces: 'appDataFolder' } : {}), ...(pageToken ? { pageToken } : {}) });
    const response = await send(`${base}/drive/v3/files?${params}`, { method: 'GET', signal });
    if (!response.ok) throw fileResponseFailure(response);
    const body = await json(response);
    if (!Array.isArray(body['files']) || (body['nextPageToken'] !== undefined && typeof body['nextPageToken'] !== 'string')) throw new FileStoreError('invalid_response');
    return { files: (body['files'] as DriveFile[]).map(describe), next: body['nextPageToken'] as string | undefined };
  };
  /** The newest file named `key`, if there is one. */
  const find = async (key: string, signal: AbortSignal) => {
    const { files } = await query(signal, key);
    return files.find(file => file.key === key);
  };
  const strip = ({ id: _id, ...info }: FileInfo & { readonly id: string }): FileInfo => info;

  return Object.freeze({
    id: 'google-drive',
    conditionalWrites: false,
    conditionalDelete: false,
    async put(key, data, putOptions) {
      for (const [name, value] of Object.entries(putOptions.metadata)) {
        if (utf8ByteLength(name) + utf8ByteLength(value) > 124) throw new MayuraError('INVALID_INPUT', 'Drive keeps each metadata entry in at most 124 bytes of key and value.');
      }
      const existing = await find(key, putOptions.signal);
      const metadata = { ...(existing ? {} : { name: key, parents: [folderId] }), mimeType: putOptions.contentType,
        appProperties: Object.keys(putOptions.metadata).length || existing?.metadata ? { ...Object.fromEntries(Object.keys(existing?.metadata ?? {}).map(name => [name, null])), ...putOptions.metadata } : {} };
      // A resumable upload takes any size in two requests: the file's metadata, then its bytes.
      const session = await send(`${base}/upload/drive/v3/files${existing ? `/${existing.id}` : ''}?uploadType=resumable&supportsAllDrives=true`, {
        method: existing ? 'PATCH' : 'POST', signal: putOptions.signal,
        headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': putOptions.contentType, 'x-upload-content-length': String(data.byteLength) },
        body: JSON.stringify(metadata),
      });
      if (!session.ok) throw fileResponseFailure(session);
      void session.body?.cancel().catch(() => undefined);
      const location = session.headers.get('location');
      let upload: URL;
      try { upload = new URL(location ?? ''); } catch { throw new FileStoreError('invalid_response'); }
      if (upload.origin !== base) throw new FileStoreError('invalid_response');
      upload.searchParams.set('fields', fields);
      const response = await send(upload.href, { method: 'PUT', signal: putOptions.signal, headers: { 'content-type': putOptions.contentType }, body: data as BodyInit });
      if (!response.ok) throw fileResponseFailure(response);
      const written = describe(await json(response) as DriveFile);
      if (written.key !== key) throw new FileStoreError('invalid_response');
      return { etag: written.etag, ...(written.lastModified === undefined ? {} : { lastModified: written.lastModified }) };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const file = await find(key, getOptions.signal);
      if (file === undefined) return undefined;
      const offset = getOptions.range?.offset ?? 0;
      if (offset >= file.size) return { ...strip(file), data: new Uint8Array(0) };
      const end = getOptions.range?.length === undefined ? file.size : Math.min(file.size, offset + getOptions.range.length);
      if (end - offset > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
      const response = await send(`${base}/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`, { method: 'GET', signal: getOptions.signal,
        headers: offset > 0 || end < file.size ? { range: `bytes=${offset}-${end - 1}` } : {} });
      if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
      if (!response.ok) throw fileResponseFailure(response);
      const data = await fileBody(response, end - offset);
      if (data.byteLength !== end - offset) throw new FileStoreError('invalid_response');
      return { ...strip(file), data };
    },
    async head(key, headOptions) {
      const file = await find(key, headOptions.signal);
      return file === undefined ? undefined : strip(file);
    },
    async list(listOptions) {
      // Drive lists neither by prefix nor in key order: read the folder, then filter and sort by key.
      const newest = new Map<string, FileInfo>(); let pageToken: string | undefined; let read = 0;
      do {
        const page = await query(listOptions.signal, undefined, pageToken);
        read += page.files.length;
        if (read > maxFolderFiles) throw new MayuraError('LIMIT_EXCEEDED', `The folder holds more than ${maxFolderFiles} files to list.`);
        for (const file of page.files) if (file.key.startsWith(listOptions.prefix) && !newest.has(file.key)) newest.set(file.key, strip(file));
        pageToken = page.next;
      } while (pageToken);
      const keys = [...newest.keys()].filter(name => listOptions.cursor === undefined || compareKeys(name, listOptions.cursor) > 0).sort(compareKeys);
      const page = keys.slice(0, listOptions.limit);
      return { files: page.map(name => newest.get(name)!), ...(keys.length > page.length ? { cursor: page.at(-1)! } : {}) };
    },
    async delete(key, deleteOptions) {
      // Every file with the name, so a key raced into duplicates is gone after one delete.
      const { files } = await query(deleteOptions.signal, key);
      for (const file of files.filter(item => item.key === key)) {
        const url = `${base}/drive/v3/files/${encodeURIComponent(file.id)}?supportsAllDrives=true`;
        const response = permanentDelete
          ? await send(url, { method: 'DELETE', signal: deleteOptions.signal })
          : await send(url, { method: 'PATCH', signal: deleteOptions.signal, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true }) });
        void response.body?.cancel().catch(() => undefined);
        if (!response.ok && response.status !== 404) throw fileResponseFailure(response);
      }
    },
  } satisfies FileBackend);
}
