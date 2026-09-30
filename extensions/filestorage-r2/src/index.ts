import { MayuraError } from 'mayura';
import { fileConflict, FileStoreError, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

/** The parts of an R2 object this backend reads, as the Workers runtime returns them. */
export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  /** The bare etag, as R2's preconditions take it. */
  readonly etag: string;
  /** The etag quoted as HTTP carries it. */
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Readonly<Record<string, string>>;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/**
 * The parts of a Workers R2 binding (`env.MY_BUCKET`, an `R2Bucket`) this backend uses. Typed structurally, so
 * the package needs no Workers types and any faithful binding, such as Miniflare's, fits.
 */
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string, options?: { onlyIf?: { etagMatches?: string }; range?: { offset: number; length?: number } }): Promise<R2ObjectLike | R2ObjectBodyLike | null>;
  put(key: string, value: Uint8Array, options?: {
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  }): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ readonly objects: readonly R2ObjectLike[]; readonly truncated: boolean; readonly cursor?: string }>;
}

export interface R2FilesOptions {
  /** The bucket binding from the Worker's environment, such as `env.FILES`. */
  readonly bucket: R2BucketLike;
}

/** R2's precondition etag: the quoted etag without its quotes. */
const bare = (etag: string) => (etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag);
/** Whether R2 returned the body. Only the method is checked: reading `body` claims the stream, and then it cannot be read. */
const hasBody = (object: R2ObjectLike | R2ObjectBodyLike): object is R2ObjectBodyLike => typeof (object as R2ObjectBodyLike).arrayBuffer === 'function';
const cancel = (object: R2ObjectLike | R2ObjectBodyLike) => { if (hasBody(object)) void object.body.cancel().catch(() => undefined); };

/**
 * Files in Cloudflare R2 through a Workers binding: `createFileStore(r2Files({ bucket: env.FILES }), { maxFileBytes })`.
 * No keys, endpoints or signing: the binding is the credential. `ifMatch` and `ifNoneMatch` are R2's own
 * preconditions. The binding cannot delete conditionally, so `conditionalDelete` is false. Outside Workers, reach R2
 * over its S3 API with `s3Files` in `mayura/files`.
 */
export function r2Files(options: R2FilesOptions): FileBackend {
  const bucket = options?.bucket;
  if (!bucket || (['head', 'get', 'put', 'delete', 'list'] as const).some(name => typeof bucket[name] !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'r2Files() needs an R2 bucket binding, such as env.FILES.');
  }
  const describe = (object: R2ObjectLike, key?: string): FileInfo => {
    if (!object || typeof object.key !== 'string' || (key !== undefined && object.key !== key) || !Number.isSafeInteger(object.size) || object.size < 0
      || typeof object.httpEtag !== 'string' || !object.httpEtag) throw new FileStoreError('invalid_response');
    const uploaded = object.uploaded instanceof Date ? object.uploaded.getTime() : NaN;
    const metadata = object.customMetadata && Object.keys(object.customMetadata).length ? { ...object.customMetadata } : undefined;
    return { key: object.key, size: object.size, etag: object.httpEtag, ...(object.httpMetadata?.contentType ? { contentType: object.httpMetadata.contentType } : {}),
      ...(Number.isFinite(uploaded) ? { lastModified: uploaded } : {}), ...(metadata ? { metadata } : {}) };
  };
  /** Runs a binding call, stopping when the call's signal aborts (the binding itself takes no signal). */
  const call = <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      run().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  return Object.freeze({
    id: 'r2',
    conditionalWrites: true,
    conditionalDelete: false,
    async put(key, data, putOptions) {
      const onlyIf = putOptions.ifNoneMatch ? { etagDoesNotMatch: '*' } : putOptions.ifMatch !== undefined ? { etagMatches: bare(putOptions.ifMatch) } : undefined;
      const written = await call(putOptions.signal, () => bucket.put(key, data, { httpMetadata: { contentType: putOptions.contentType },
        ...(Object.keys(putOptions.metadata).length ? { customMetadata: { ...putOptions.metadata } } : {}), ...(onlyIf ? { onlyIf } : {}) }));
      // R2 answers a failed precondition with null instead of an object.
      if (written === null) { if (onlyIf) throw fileConflict(); throw new FileStoreError('invalid_response'); }
      const file = describe(written, key);
      return { etag: file.etag, ...(file.lastModified === undefined ? {} : { lastModified: file.lastModified }) };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const range = getOptions.range && (getOptions.range.offset > 0 || getOptions.range.length !== undefined) ? getOptions.range : undefined;
      let object: R2ObjectLike | R2ObjectBodyLike | null;
      try {
        object = await call(getOptions.signal, () => bucket.get(key, { ...(getOptions.ifMatch === undefined ? {} : { onlyIf: { etagMatches: bare(getOptions.ifMatch) } }),
          ...(range ? { range: { offset: range.offset, ...(range.length === undefined ? {} : { length: range.length }) } } : {}) }));
      } catch (error) {
        if (!range || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        // R2 refuses a range that starts at or past the end: the file may be there, and the range holds nothing.
        const file = await call(getOptions.signal, () => bucket.head(key));
        if (file === null) return undefined;
        const info = describe(file, key);
        if (range.offset < info.size) throw new FileStoreError('unavailable');
        if (getOptions.ifMatch !== undefined && info.etag !== getOptions.ifMatch) throw fileConflict();
        return { ...info, data: new Uint8Array(0) };
      }
      if (object === null) return undefined;
      // A failed precondition returns the object without its body.
      if (!hasBody(object)) { if (getOptions.ifMatch !== undefined) throw fileConflict(); throw new FileStoreError('invalid_response'); }
      const info = describe(object, key);
      const expected = range ? Math.max(0, Math.min(range.length ?? Infinity, info.size - range.offset)) : info.size;
      if (expected > getOptions.maxBytes) { cancel(object); throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`); }
      const data = new Uint8Array(await call(getOptions.signal, () => object.arrayBuffer()));
      if (data.byteLength !== expected) throw new FileStoreError('invalid_response');
      return { ...info, data };
    },
    async head(key, headOptions) {
      const object = await call(headOptions.signal, () => bucket.head(key));
      return object === null ? undefined : describe(object, key);
    },
    async list(listOptions) {
      const page = await call(listOptions.signal, () => bucket.list({ limit: listOptions.limit, ...(listOptions.prefix ? { prefix: listOptions.prefix } : {}),
        ...(listOptions.cursor === undefined ? {} : { cursor: listOptions.cursor }) }));
      if (!page || !Array.isArray(page.objects) || typeof page.truncated !== 'boolean' || (page.truncated && (typeof page.cursor !== 'string' || !page.cursor))) throw new FileStoreError('invalid_response');
      return { files: page.objects.map(object => describe(object)), ...(page.truncated ? { cursor: page.cursor! } : {}) };
    },
    async delete(key, deleteOptions) {
      await call(deleteOptions.signal, () => bucket.delete(key));
    },
  } satisfies FileBackend);
}
