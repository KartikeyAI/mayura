import { MayuraError } from '@mayura/core';
import { fileConflict, type FileBackend, type FileInfo, type StoredFile } from './contracts.js';

interface Entry { readonly data: Uint8Array; readonly etag: string; readonly contentType: string; readonly metadata: Readonly<Record<string, string>>; readonly lastModified: number }

/** Keys in code-point order, which is UTF-8 byte order: the order S3 and most object stores list in. */
export function compareFileKeys(left: string, right: string): number {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

const abortIf = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); };

/**
 * A file backend in memory, for tests and development: `createFileStore(memoryFiles(), { maxFileBytes })`. Everything
 * is lost when the process ends. It keeps every precondition as a real store does, and deletes conditionally.
 */
export function memoryFiles(): FileBackend {
  const files = new Map<string, Entry>(); let version = 0;
  const describe = (key: string, entry: Entry): FileInfo => ({ key, size: entry.data.byteLength, etag: entry.etag, contentType: entry.contentType,
    lastModified: entry.lastModified, ...(Object.keys(entry.metadata).length ? { metadata: entry.metadata } : {}) });
  return Object.freeze({
    id: 'memory',
    conditionalWrites: true,
    conditionalDelete: true,
    async put(key, data, options) {
      abortIf(options.signal);
      const existing = files.get(key);
      if ((options.ifNoneMatch && existing) || (options.ifMatch !== undefined && existing?.etag !== options.ifMatch)) throw fileConflict();
      const entry: Entry = { data: data.slice(), etag: `"m${++version}"`, contentType: options.contentType, metadata: options.metadata, lastModified: Date.now() };
      files.set(key, entry);
      return { etag: entry.etag, lastModified: entry.lastModified };
    },
    async get(key, options): Promise<StoredFile | undefined> {
      abortIf(options.signal);
      const entry = files.get(key);
      if (!entry) return undefined;
      if (options.ifMatch !== undefined && entry.etag !== options.ifMatch) throw fileConflict();
      const start = Math.min(options.range?.offset ?? 0, entry.data.byteLength);
      const end = options.range?.length === undefined ? entry.data.byteLength : Math.min(start + options.range.length, entry.data.byteLength);
      if (end - start > options.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${options.maxBytes} bytes.`);
      return { ...describe(key, entry), data: entry.data.slice(start, end) };
    },
    async head(key, options) {
      abortIf(options.signal);
      const entry = files.get(key);
      return entry ? describe(key, entry) : undefined;
    },
    async list(options) {
      abortIf(options.signal);
      const keys = [...files.keys()].filter(key => key.startsWith(options.prefix) && (options.cursor === undefined || compareFileKeys(key, options.cursor) > 0)).sort(compareFileKeys);
      const page = keys.slice(0, options.limit);
      return { files: page.map(key => describe(key, files.get(key)!)), ...(keys.length > page.length ? { cursor: page.at(-1)! } : {}) };
    },
    async delete(key, options) {
      abortIf(options.signal);
      if (options.ifMatch !== undefined && files.get(key)?.etag !== options.ifMatch) throw fileConflict();
      files.delete(key);
    },
  } satisfies FileBackend);
}
