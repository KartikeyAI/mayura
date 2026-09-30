import { assertPositiveInteger, MayuraError } from '@mayura/core';
import { utf8ByteLength } from '@mayura/core/host';
import {
  FileStoreError,
  type DeleteFileOptions, type FileBackend, type FileInfo, type FileListing, type FileStore, type GetFileOptions, type ListFilesOptions,
  type PutFileOptions, type StoredFile,
} from './contracts.js';

export interface FileStoreOptions {
  /** The largest file the store writes or reads, up to 5 GiB. Files are held in memory while stored and read. */
  readonly maxFileBytes: number;
  /** The most files one `list` call returns; 1,000 by default and at most. */
  readonly maxListLimit?: number;
  /** How long one call may take; 60 s by default. */
  readonly timeoutMs?: number;
  /** Keep every key under this prefix, as `within(prefix)` does. */
  readonly prefix?: string;
}

const maxKeyBytes = 1_024;
/** Whether `key` is a valid file key: `/`-separated segments, none empty, `.` or `..`, and no control characters or backslashes. */
export function isFileKey(key: unknown): key is string {
  if (typeof key !== 'string' || key === '' || utf8ByteLength(key) > maxKeyBytes || /[\u0000-\u001f\u007f\\]/u.test(key)) return false;
  // A lone surrogate cannot be sent as UTF-8.
  if (/\p{Cs}/u.test(key)) return false;
  return key.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
function key(value: unknown, name = 'key'): string {
  if (!isFileKey(value)) throw new MayuraError('INVALID_INPUT', `${name} must be a file key: /-separated names, without empty, . or .. parts, backslashes or control characters, at most 1,024 bytes.`);
  return value;
}
/** A list prefix: any start of a valid key, such as `reports/` or `rep`, or empty. */
function listPrefix(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !isFileKey(value.endsWith('/') ? value.slice(0, -1) : `${value}x`)) throw new MayuraError('INVALID_INPUT', 'prefix must be the start of a file key.');
  return value;
}
const etagPattern = /^[ -~]{1,256}$/u;
function etag(value: unknown, name: string): string {
  if (typeof value !== 'string' || !etagPattern.test(value)) throw new MayuraError('INVALID_INPUT', `${name} must be a version tag (etag) returned by the store.`);
  return value;
}
const contentTypePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[ -~]*"))*$/u;
function contentType(value: unknown): string {
  if (value === undefined) return 'application/octet-stream';
  if (typeof value !== 'string' || value.length > 255 || !contentTypePattern.test(value)) throw new MayuraError('INVALID_INPUT', 'contentType must be a media type, such as text/csv.');
  return value;
}
function metadata(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', 'metadata must be an object of strings.');
  const entries = Object.entries(value as Record<string, unknown>);
  let bytes = 0;
  if (entries.length > 16) throw new MayuraError('INVALID_INPUT', 'metadata has at most 16 entries.');
  for (const [name, item] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) || typeof item !== 'string' || !/^[ -~]{0,1024}$/u.test(item)) {
      throw new MayuraError('INVALID_INPUT', 'metadata keys are lowercase letters, digits and -, and values printable ASCII.');
    }
    bytes += name.length + item.length;
  }
  if (bytes > 2_048) throw new MayuraError('INVALID_INPUT', 'metadata is at most 2 KB.');
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
function nonNegative(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MayuraError('INVALID_INPUT', `${name} must be a non-negative integer.`);
  return value as number;
}

/** One call's signal: aborted by the caller's signal or at the timeout. */
function callSignal(timeoutMs: number, caller: AbortSignal | undefined) {
  if (caller !== undefined && !(caller instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'signal must be an AbortSignal.');
  if (caller?.aborted) throw new MayuraError('CANCELLED', 'The file store call was cancelled.');
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    /** The error to raise for what ended the call: the timeout, the caller, or the backend's own error. */
    failure(error: unknown): never {
      if (timedOut) throw new FileStoreError('timeout');
      if (caller?.aborted) throw new MayuraError('CANCELLED', 'The file store call was cancelled.');
      if (error instanceof MayuraError) throw error;
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) throw new FileStoreError('unavailable');
      throw new FileStoreError('invalid_response');
    },
    done() { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); },
  };
}

const invalid = () => new FileStoreError('invalid_response');
/** A backend's file information, checked, with its key made relative to `base`. */
function info(value: unknown, base: string, expectedKey?: string): FileInfo {
  const file = value as Partial<FileInfo> | null;
  if (!file || typeof file !== 'object' || typeof file.key !== 'string' || !file.key.startsWith(base) || !Number.isSafeInteger(file.size) || file.size! < 0
    || typeof file.etag !== 'string' || !etagPattern.test(file.etag)) throw invalid();
  const relative = file.key.slice(base.length);
  if (!isFileKey(relative) || (expectedKey !== undefined && relative !== expectedKey)) throw invalid();
  if (file.contentType !== undefined && typeof file.contentType !== 'string') throw invalid();
  if (file.lastModified !== undefined && !Number.isFinite(file.lastModified)) throw invalid();
  let meta: Readonly<Record<string, string>> | undefined;
  if (file.metadata !== undefined) {
    if (!file.metadata || typeof file.metadata !== 'object' || Object.values(file.metadata).some(item => typeof item !== 'string')) throw invalid();
    meta = Object.freeze({ ...file.metadata });
  }
  return Object.freeze({ key: relative, size: file.size!, etag: file.etag, ...(file.contentType ? { contentType: file.contentType } : {}),
    ...(file.lastModified === undefined ? {} : { lastModified: file.lastModified }), ...(meta ? { metadata: meta } : {}) });
}

/**
 * A file store over a backend, such as `s3Files(...)` or a `@mayurajs/filestorage-*` package's. Every key, option and
 * size is checked before the backend is called, and everything it returns is checked before you see it.
 */
export function createFileStore(backend: FileBackend, options: FileStoreOptions): FileStore {
  if (!backend || typeof backend.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(backend.id) || typeof backend.conditionalDelete !== 'boolean' || typeof backend.conditionalWrites !== 'boolean'
    || (['put', 'get', 'head', 'list', 'delete'] as const).some(name => typeof backend[name] !== 'function')) throw new MayuraError('INVALID_CONFIG', 'createFileStore() needs a file backend.');
  if (!options) throw new MayuraError('INVALID_CONFIG', 'createFileStore() needs options with maxFileBytes.');
  const maxFileBytes = options.maxFileBytes; assertPositiveInteger(maxFileBytes, 'maxFileBytes');
  if (maxFileBytes > 5 * 1_073_741_824) throw new MayuraError('INVALID_CONFIG', 'maxFileBytes is at most 5 GiB.');
  const maxListLimit = options.maxListLimit ?? 1_000; assertPositiveInteger(maxListLimit, 'maxListLimit');
  if (maxListLimit > 1_000) throw new MayuraError('INVALID_CONFIG', 'maxListLimit is at most 1,000.');
  const timeoutMs = options.timeoutMs ?? 60_000; assertPositiveInteger(timeoutMs, 'timeoutMs');
  const root = options.prefix === undefined ? '' : `${key(options.prefix, 'prefix')}/`;

  const view = (base: string): FileStore => {
    const full = (name: string) => {
      const value = base + key(name);
      if (utf8ByteLength(value) > maxKeyBytes) throw new MayuraError('INVALID_INPUT', 'The key, with the store\'s prefix, is longer than 1,024 bytes.');
      return value;
    };
    const run = async <T>(caller: AbortSignal | undefined, body: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const call = callSignal(timeoutMs, caller);
      try { return await body(call.signal); } catch (error) { return call.failure(error); } finally { call.done(); }
    };
    return Object.freeze({
      id: backend.id, maxFileBytes, conditionalWrites: backend.conditionalWrites, conditionalDelete: backend.conditionalDelete,
      put: async (name: string, data: Uint8Array, putOptions: PutFileOptions = {}): Promise<FileInfo> => {
        const path = full(name);
        if (!(data instanceof Uint8Array)) throw new MayuraError('INVALID_INPUT', 'data must be a Uint8Array.');
        if (data.byteLength > maxFileBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxFileBytes} bytes.`);
        const type = contentType(putOptions.contentType); const meta = metadata(putOptions.metadata);
        if (putOptions.ifNoneMatch !== undefined && putOptions.ifNoneMatch !== '*') throw new MayuraError('INVALID_INPUT', "ifNoneMatch can only be '*'.");
        const ifMatch = putOptions.ifMatch === undefined ? undefined : etag(putOptions.ifMatch, 'ifMatch');
        if (ifMatch !== undefined && putOptions.ifNoneMatch !== undefined) throw new MayuraError('INVALID_INPUT', 'Give ifMatch or ifNoneMatch, not both.');
        if ((ifMatch !== undefined || putOptions.ifNoneMatch !== undefined) && !backend.conditionalWrites) throw new MayuraError('INVALID_INPUT', `The ${backend.id} file store cannot write conditionally.`);
        // The backend may keep what it is given: hand it a copy the caller cannot change afterwards.
        const copy = data.slice();
        return run(putOptions.signal, async signal => {
          const written = await backend.put(path, copy, { contentType: type, metadata: meta, signal,
            ...(putOptions.ifNoneMatch ? { ifNoneMatch: '*' as const } : {}), ...(ifMatch === undefined ? {} : { ifMatch }) });
          if (!written || typeof written.etag !== 'string' || !etagPattern.test(written.etag) || (written.lastModified !== undefined && !Number.isFinite(written.lastModified))) throw invalid();
          return Object.freeze({ key: name, size: copy.byteLength, etag: written.etag, contentType: type, ...(written.lastModified === undefined ? {} : { lastModified: written.lastModified }),
            ...(Object.keys(meta).length ? { metadata: meta } : {}) });
        });
      },
      get: async (name: string, getOptions: GetFileOptions = {}): Promise<StoredFile | undefined> => {
        const path = full(name);
        const maxBytes = getOptions.maxBytes === undefined ? maxFileBytes : Math.min(nonNegative(getOptions.maxBytes, 'maxBytes'), maxFileBytes);
        let range: { offset: number; length?: number } | undefined;
        if (getOptions.range !== undefined) {
          if (!getOptions.range || typeof getOptions.range !== 'object') throw new MayuraError('INVALID_INPUT', 'range must be { offset, length? }.');
          const offset = nonNegative(getOptions.range.offset, 'range.offset');
          const length = getOptions.range.length === undefined ? undefined : nonNegative(getOptions.range.length, 'range.length');
          if (length === 0) throw new MayuraError('INVALID_INPUT', 'range.length must be positive.');
          if (length !== undefined && length > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The range is longer than ${maxBytes} bytes.`);
          range = { offset, ...(length === undefined ? {} : { length }) };
        }
        const ifMatch = getOptions.ifMatch === undefined ? undefined : etag(getOptions.ifMatch, 'ifMatch');
        if (ifMatch !== undefined && !backend.conditionalWrites) throw new MayuraError('INVALID_INPUT', `The ${backend.id} file store cannot read conditionally.`);
        return run(getOptions.signal, async signal => {
          const file = await backend.get(path, { maxBytes, signal, ...(range ? { range } : {}), ...(ifMatch === undefined ? {} : { ifMatch }) });
          if (file === undefined) return undefined;
          const checked = info(file, base, name);
          if (!(file.data instanceof Uint8Array) || file.data.byteLength > maxBytes) throw file?.data instanceof Uint8Array ? new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`) : invalid();
          const expected = range === undefined ? checked.size : Math.max(0, Math.min(range.length ?? Infinity, checked.size - range.offset));
          if (file.data.byteLength !== expected) throw invalid();
          return Object.freeze({ ...checked, data: file.data });
        });
      },
      head: async (name: string, headOptions: { readonly signal?: AbortSignal } = {}): Promise<FileInfo | undefined> => {
        const path = full(name);
        return run(headOptions.signal, async signal => {
          const file = await backend.head(path, { signal });
          return file === undefined ? undefined : info(file, base, name);
        });
      },
      list: async (listOptions: ListFilesOptions = {}): Promise<FileListing> => {
        const prefix = base + listPrefix(listOptions.prefix);
        const limit = listOptions.limit === undefined ? Math.min(100, maxListLimit) : nonNegative(listOptions.limit, 'limit');
        if (limit < 1 || limit > maxListLimit) throw new MayuraError('INVALID_INPUT', `limit must be 1 to ${maxListLimit}.`);
        const cursor = listOptions.cursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '' || cursor.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(cursor))) throw new MayuraError('INVALID_INPUT', 'cursor must be the cursor of a previous page.');
        return run(listOptions.signal, async signal => {
          const page = await backend.list({ prefix, limit, signal, ...(cursor === undefined ? {} : { cursor }) });
          if (!page || !Array.isArray(page.files) || page.files.length > limit || (page.cursor !== undefined && (typeof page.cursor !== 'string' || page.cursor === '' || page.cursor.length > 4_096))) throw invalid();
          const files = page.files.map(file => info(file, base));
          if (files.some(file => !(base + file.key).startsWith(prefix))) throw invalid();
          return Object.freeze({ files: Object.freeze(files), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) });
        });
      },
      delete: async (name: string, deleteOptions: DeleteFileOptions = {}): Promise<void> => {
        const path = full(name);
        const ifMatch = deleteOptions.ifMatch === undefined ? undefined : etag(deleteOptions.ifMatch, 'ifMatch');
        if (ifMatch !== undefined && !backend.conditionalDelete) throw new MayuraError('INVALID_INPUT', `The ${backend.id} file store cannot delete conditionally.`);
        await run(deleteOptions.signal, signal => backend.delete(path, { signal, ...(ifMatch === undefined ? {} : { ifMatch }) }));
      },
      within: (prefix: string): FileStore => {
        const next = `${base}${key(prefix, 'prefix')}/`;
        if (utf8ByteLength(next) >= maxKeyBytes) throw new MayuraError('INVALID_INPUT', 'The prefix leaves no room for keys.');
        return view(next);
      },
    });
  };
  return view(root);
}

