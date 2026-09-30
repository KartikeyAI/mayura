import { MayuraError } from '@mayura/core';

/** What a store knows about a file, without its content. */
export interface FileInfo {
  /** The file's key, relative to the store (or to the view made with `within`). */
  readonly key: string;
  /** Its size in bytes: the whole file's, even when a range was read. */
  readonly size: number;
  /** An opaque version tag. Pass it as `ifMatch` to change or read the file only while it is still this version. */
  readonly etag: string;
  readonly contentType?: string;
  /** When it was last written, in Unix milliseconds, when the store reports it. */
  readonly lastModified?: number;
  /** The metadata it was written with. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A file with its content, or the requested range of it. */
export interface StoredFile extends FileInfo {
  readonly data: Uint8Array;
}

export interface PutFileOptions {
  /** A media type, such as `text/csv`; `application/octet-stream` by default. */
  readonly contentType?: string;
  /** Up to 16 entries: lowercase keys of letters, digits and `-`, printable ASCII values, 2 KB in all. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** `'*'`: write only if no file has this key. A file already there fails the write with `CONFLICT`. */
  readonly ifNoneMatch?: '*';
  /** Write only if the file is still at this version (its `etag`). Otherwise the write fails with `CONFLICT`. */
  readonly ifMatch?: string;
  readonly signal?: AbortSignal;
}

export interface GetFileOptions {
  /** Read part of the file: `length` bytes from `offset`, or to the end without `length`. */
  readonly range?: { readonly offset: number; readonly length?: number };
  /** Read only if the file is still at this version. Otherwise the read fails with `CONFLICT`. */
  readonly ifMatch?: string;
  /** Refuse to read more than this many bytes; the store's `maxFileBytes` by default, and never more. */
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ListFilesOptions {
  /** Only keys starting with this, such as `reports/`. */
  readonly prefix?: string;
  /** The `cursor` of the previous page. */
  readonly cursor?: string;
  /** At most this many files per page; 100 by default, at most the store's `maxListLimit`. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** One page of files, in key order, and the cursor of the next page when there is one. */
export interface FileListing {
  readonly files: readonly FileInfo[];
  readonly cursor?: string;
}

export interface DeleteFileOptions {
  /** Delete only if the file is still at this version; for stores whose `conditionalDelete` is true. */
  readonly ifMatch?: string;
  readonly signal?: AbortSignal;
}

/**
 * A file store: keys to bytes, with versions for safe concurrent writes. Keys are `/`-separated paths such as
 * `reports/2026/q3.csv`; they cannot start or end with `/`, contain empty, `.` or `..` segments, backslashes or
 * control characters, and are at most 1,024 bytes of UTF-8.
 */
export interface FileStore {
  /** The backend's id, such as `s3` or `memory`. */
  readonly id: string;
  /** The largest file this store writes or reads. */
  readonly maxFileBytes: number;
  /** Whether `put` and `get` accept `ifNoneMatch` and `ifMatch` on this backend: whether writes can be made safe against races. */
  readonly conditionalWrites: boolean;
  /** Whether `delete` accepts `ifMatch` on this backend. */
  readonly conditionalDelete: boolean;
  put(key: string, data: Uint8Array, options?: PutFileOptions): Promise<FileInfo>;
  /** The file, or undefined when there is none. */
  get(key: string, options?: GetFileOptions): Promise<StoredFile | undefined>;
  /** The file's information, or undefined when there is none. */
  head(key: string, options?: { readonly signal?: AbortSignal }): Promise<FileInfo | undefined>;
  list(options?: ListFilesOptions): Promise<FileListing>;
  /** Deletes the file; deleting a file that is not there succeeds. */
  delete(key: string, options?: DeleteFileOptions): Promise<void>;
  /** The same store seen under a prefix: keys are relative to it, and nothing outside it can be reached. */
  within(prefix: string): FileStore;
}

/**
 * What a file storage provider implements, as `@mayurajs/filestorage-*` packages export it. Backends are trusted code:
 * `createFileStore` validates every key, option and size before calling them, and checks what they return. They map
 * every failure to a {@link FileStoreError} without the provider's text, a failed precondition to `CONFLICT`, and a
 * missing file to undefined.
 */
export interface FileBackend {
  /** Lowercase letters, digits and `-`, such as `s3`. */
  readonly id: string;
  /**
   * Whether `put` and `get` honour `ifNoneMatch` and `ifMatch` atomically. A backend without it (a service with no
   * versions or preconditions) is never given them: `createFileStore` refuses them rather than pretend.
   */
  readonly conditionalWrites: boolean;
  /** Whether `delete` honours `ifMatch`. A backend without it is never given one. */
  readonly conditionalDelete: boolean;
  put(key: string, data: Uint8Array, options: BackendPutOptions): Promise<{ readonly etag: string; readonly lastModified?: number }>;
  get(key: string, options: BackendGetOptions): Promise<StoredFile | undefined>;
  head(key: string, options: { readonly signal: AbortSignal }): Promise<FileInfo | undefined>;
  list(options: BackendListOptions): Promise<FileListing>;
  delete(key: string, options: { readonly ifMatch?: string; readonly signal: AbortSignal }): Promise<void>;
}
export interface BackendPutOptions {
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly ifNoneMatch?: '*';
  readonly ifMatch?: string;
  readonly signal: AbortSignal;
}
export interface BackendGetOptions {
  readonly range?: { readonly offset: number; readonly length?: number };
  readonly ifMatch?: string;
  /** Refuse (with `LIMIT_EXCEEDED`) a body larger than this, before or while reading it. */
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}
export interface BackendListOptions {
  /** Keys starting with this; may be empty. */
  readonly prefix: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}

/** Why a file store call failed. */
export type FileFailureReason = 'authentication' | 'rate_limited' | 'unavailable' | 'timeout' | 'rejected' | 'invalid_response';

const messages: Readonly<Record<FileFailureReason, string>> = {
  authentication: 'The file store refused the credentials.',
  rate_limited: 'The file store is rate limiting requests.',
  unavailable: 'The file store is unavailable.',
  timeout: 'The file store did not answer in time.',
  rejected: 'The file store rejected the request.',
  invalid_response: 'The file store returned a response that is not valid.',
};

/** A file store failure, with a fixed message: nothing the provider wrote reaches it. */
export class FileStoreError extends MayuraError {
  readonly reason: FileFailureReason;
  declare readonly httpStatus?: number;
  constructor(reason: FileFailureReason, httpStatus?: number) {
    if (!Object.hasOwn(messages, reason)) throw new MayuraError('INVALID_CONFIG', 'Unknown file store failure reason.');
    if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new MayuraError('INVALID_CONFIG', 'An HTTP status must be between 100 and 599.');
    super('STORAGE_UNAVAILABLE', httpStatus === undefined ? messages[reason] : `${messages[reason]} (HTTP ${httpStatus})`);
    this.reason = reason;
    if (httpStatus !== undefined) Object.defineProperty(this, 'httpStatus', { value: httpStatus, enumerable: true });
    Object.freeze(this);
  }
}

/** The error for a failed precondition: `ifNoneMatch` found a file, or `ifMatch` a different version or none. */
export function fileConflict(): MayuraError { return new MayuraError('CONFLICT', 'The file changed, is missing or already exists.'); }

/** For backends: an HTTP error status as its failure. 412 is a failed precondition. */
export function fileHttpFailure(status: number): MayuraError {
  if (status === 412) return fileConflict();
  if (status === 401 || status === 403) return new FileStoreError('authentication', status);
  if (status === 429) return new FileStoreError('rate_limited', status);
  if (status === 408) return new FileStoreError('timeout', status);
  if (status >= 500) return new FileStoreError('unavailable', status);
  return new FileStoreError('rejected', status);
}
