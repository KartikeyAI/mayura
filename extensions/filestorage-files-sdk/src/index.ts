import { MayuraError } from 'mayura';
import { fileConflict, FileStoreError, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

/** A file as Files SDK returns it from `head`, `download` and `list`. */
export interface FilesSdkFileLike {
  readonly key: string;
  readonly size: number;
  readonly type?: string;
  readonly etag?: string;
  readonly lastModified?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/** The parts of a Files SDK client (`new Files({ adapter })`) this backend uses, typed by shape. */
export interface FilesSdkLike {
  readonly capabilities: {
    readonly rangeRead: boolean;
    readonly metadata: boolean;
    readonly conditional: { readonly create: boolean; readonly replace: boolean; readonly exactRead: boolean; readonly delete: boolean };
  };
  upload(key: string, body: Uint8Array, options?: {
    contentType?: string; metadata?: Record<string, string>; signal?: AbortSignal;
    condition?: { type: 'create' } | { type: 'replace'; etag: string };
  }): Promise<{ readonly etag?: string; readonly lastModified?: number }>;
  download(key: string, options?: { condition?: { etag: string }; range?: { start: number; end?: number }; signal?: AbortSignal }): Promise<FilesSdkFileLike>;
  head(key: string, options?: { signal?: AbortSignal }): Promise<FilesSdkFileLike>;
  delete(key: string, options?: { condition?: { etag: string }; signal?: AbortSignal }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ readonly items: readonly FilesSdkFileLike[]; readonly cursor?: string }>;
}

export interface FilesSdkFilesOptions {
  /** A Files SDK client, such as `new Files({ adapter: s3({ ... }) })`, over any of its providers. */
  readonly files: FilesSdkLike;
}

/** Files SDK's error code, when the error is one of its own. */
function filesErrorCode(error: unknown): string | undefined {
  const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof value === 'string' && ['NotFound', 'Unauthorized', 'Conflict', 'ReadOnly', 'Provider'].includes(value) ? value : undefined;
}
/** A Files SDK failure as the file store reports it, without its message. */
function failure(error: unknown): never {
  if (error instanceof MayuraError) throw error;
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  const timedOut = !!error && typeof error === 'object' && (error as { timedOut?: unknown }).timedOut === true;
  switch (filesErrorCode(error)) {
    case 'Conflict': throw fileConflict();
    case 'Unauthorized': throw new FileStoreError('authentication');
    case 'ReadOnly': throw new FileStoreError('rejected');
    case 'Provider': throw new FileStoreError(timedOut ? 'timeout' : 'unavailable');
    default: throw new FileStoreError('unavailable');
  }
}
const notFound = (error: unknown) => filesErrorCode(error) === 'NotFound';

/**
 * Any Files SDK provider as a file store backend: `createFileStore(filesSdkFiles({ files }), { maxFileBytes })`, where
 * `files` is a Files SDK client over S3, R2, GCS, Azure, Supabase, Dropbox, SFTP or any of its other adapters. The
 * store keeps what the provider can: preconditions when its adapter has native conditional create, replace and exact
 * reads (and conditional deletes), metadata when it keeps metadata, and ranged reads where it has them (otherwise the
 * file is read whole, within the limit, and the range taken from it).
 */
export function filesSdkFiles(options: FilesSdkFilesOptions): FileBackend {
  const files = options?.files;
  if (!files || (['upload', 'download', 'head', 'delete', 'list'] as const).some(name => typeof files[name] !== 'function') || !files.capabilities?.conditional) {
    throw new MayuraError('INVALID_CONFIG', 'filesSdkFiles() needs a Files SDK client: new Files({ adapter }).');
  }
  const capabilities = files.capabilities;
  const conditionalWrites = capabilities.conditional.create === true && capabilities.conditional.replace === true && capabilities.conditional.exactRead === true;
  const describe = (file: FilesSdkFileLike, key: string, etag?: string): FileInfo => {
    const tag = etag ?? file?.etag;
    if (!file || file.key !== key || !Number.isSafeInteger(file.size) || file.size < 0 || typeof tag !== 'string' || !tag) throw new FileStoreError('invalid_response');
    const metadata = file.metadata && Object.keys(file.metadata).length ? { ...file.metadata } : undefined;
    return { key, size: file.size, etag: tag, ...(typeof file.type === 'string' && file.type ? { contentType: file.type } : {}),
      ...(Number.isFinite(file.lastModified) ? { lastModified: file.lastModified! } : {}), ...(metadata ? { metadata } : {}) };
  };
  const head = async (key: string, signal: AbortSignal): Promise<FileInfo | undefined> => {
    try { return describe(await files.head(key, { signal }), key); } catch (error) { if (notFound(error)) return undefined; return failure(error); }
  };

  return Object.freeze({
    id: 'files-sdk',
    conditionalWrites,
    conditionalDelete: capabilities.conditional.delete === true,
    async put(key, data, putOptions) {
      const hasMetadata = Object.keys(putOptions.metadata).length > 0;
      if (hasMetadata && !capabilities.metadata) throw new MayuraError('INVALID_INPUT', 'This Files SDK provider keeps no metadata.');
      const condition = putOptions.ifNoneMatch ? { type: 'create' as const } : putOptions.ifMatch !== undefined ? { type: 'replace' as const, etag: putOptions.ifMatch } : undefined;
      let written: { readonly etag?: string; readonly lastModified?: number };
      try {
        written = await files.upload(key, data, { contentType: putOptions.contentType, signal: putOptions.signal,
          ...(hasMetadata ? { metadata: { ...putOptions.metadata } } : {}), ...(condition ? { condition } : {}) });
      } catch (error) {
        // A replace of a file that is not there is a conflict too.
        if (condition && notFound(error)) throw fileConflict();
        return failure(error);
      }
      const etag = written?.etag ?? (await head(key, putOptions.signal))?.etag;
      if (typeof etag !== 'string' || !etag) throw new FileStoreError('invalid_response');
      return { etag, ...(Number.isFinite(written?.lastModified) ? { lastModified: written.lastModified! } : {}) };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const range = getOptions.range && (getOptions.range.offset > 0 || getOptions.range.length !== undefined) ? getOptions.range : undefined;
      // A ranged read reports the range's size: the whole file's size and version come from head.
      const info = range || getOptions.ifMatch !== undefined ? await head(key, getOptions.signal) : undefined;
      if ((range || getOptions.ifMatch !== undefined) && info === undefined) return undefined;
      if (info && getOptions.ifMatch !== undefined && info.etag !== getOptions.ifMatch) throw fileConflict();
      const offset = range?.offset ?? 0;
      if (info && range && offset >= info.size) return { ...info, data: new Uint8Array(0) };
      const end = info && range ? (range.length === undefined ? info.size : Math.min(info.size, offset + range.length)) : undefined;
      if (end !== undefined && end - offset > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
      const native = range !== undefined && capabilities.rangeRead;
      if (range && !native && info!.size > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
      let file: FilesSdkFileLike;
      try {
        file = await files.download(key, { signal: getOptions.signal, ...(getOptions.ifMatch !== undefined && conditionalWrites ? { condition: { etag: getOptions.ifMatch } } : {}),
          ...(native ? { range: { start: offset, end: end! - 1 } } : {}) });
      } catch (error) {
        if (notFound(error)) { if (getOptions.ifMatch !== undefined) throw fileConflict(); return undefined; }
        return failure(error);
      }
      if (!native && !info && file.size > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
      let data = new Uint8Array(await file.arrayBuffer());
      if (range && !native) data = data.slice(offset, end);
      const described = info ?? describe(file, key);
      // The bytes must be the version described: otherwise the file changed in between.
      if (info && file.etag !== undefined && file.etag !== info.etag) { if (getOptions.ifMatch !== undefined) throw fileConflict(); throw new FileStoreError('unavailable'); }
      const expected = range ? end! - offset : described.size;
      if (data.byteLength !== expected) throw new FileStoreError('invalid_response');
      return { ...described, data };
    },
    head: (key, headOptions) => head(key, headOptions.signal),
    async list(listOptions) {
      let page: { readonly items: readonly FilesSdkFileLike[]; readonly cursor?: string };
      try { page = await files.list({ limit: listOptions.limit, signal: listOptions.signal, ...(listOptions.prefix ? { prefix: listOptions.prefix } : {}), ...(listOptions.cursor === undefined ? {} : { cursor: listOptions.cursor }) }); }
      catch (error) { return failure(error); }
      if (!page || !Array.isArray(page.items)) throw new FileStoreError('invalid_response');
      const result: FileInfo[] = [];
      for (const item of page.items) {
        // A provider that lists without etags is asked for each file's.
        if (item?.etag) { result.push(describe(item, item.key)); continue; }
        const info = await head(item?.key, listOptions.signal);
        if (info) result.push(info);
      }
      return { files: result, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
    async delete(key, deleteOptions) {
      try { await files.delete(key, { signal: deleteOptions.signal, ...(deleteOptions.ifMatch === undefined ? {} : { condition: { etag: deleteOptions.ifMatch } }) }); }
      catch (error) {
        if (notFound(error)) { if (deleteOptions.ifMatch !== undefined) throw fileConflict(); return; }
        return failure(error);
      }
    },
  } satisfies FileBackend);
}
