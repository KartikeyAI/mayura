import { MayuraError } from 'mayura';
import { sha256Hex } from 'mayura/core/host';
import { fileConflict, FileStoreError, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

/** The parts of an AgentFS filesystem (`agentfs.fs`) this backend uses, typed structurally so any AgentFS build fits. */
export interface AgentFsLike {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ readonly size: number; readonly mtime: number; isFile(): boolean; isDirectory(): boolean }>;
  readdirPlus(path: string): Promise<readonly { readonly name: string; readonly stats: { isFile(): boolean; isDirectory(): boolean } }[]>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

export interface AgentFsFilesOptions {
  /** The AgentFS filesystem: `agentfs.fs` from `AgentFS.open(...)`, or the Cloudflare Durable Object build's. */
  readonly fs: AgentFsLike;
  /** The directory the files live in; `/files` by default. Its sidecar metadata lives in `<root>.mayura`. */
  readonly root?: string;
  /**
   * This backend is the only writer of the AgentFS database (one process, or one Durable Object). Then writes are
   * serialized and `ifMatch`, `ifNoneMatch` and conditional deletes are kept; otherwise they are refused, since
   * another writer could change a file between the check and the write.
   */
  readonly singleWriter?: boolean;
  /** The most files a listing walks; 10,000 by default. */
  readonly maxFiles?: number;
}

interface Sidecar { readonly contentType: string; readonly metadata: Readonly<Record<string, string>> }
const code = (error: unknown) => (error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined);
const compareKeys = (left: string, right: string) => {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};
/** One lock per filesystem, so every backend over it in this process takes turns. */
const locks = new WeakMap<object, Promise<void>>();

/**
 * Files in an AgentFS filesystem (Turso's SQLite-backed filesystem for agents):
 * `createFileStore(agentFsFiles({ fs: agentfs.fs }), { maxFileBytes })`. Each key is a path under `root`; a file's
 * etag is the SHA-256 of its content, and its media type and metadata live in a sidecar file. A filesystem cannot hold
 * a file where another key needs a directory (`a` and `a/b`): such a write is refused. Preconditions are kept only with
 * `singleWriter`. A listing walks the directories (up to `maxFiles`) and sorts them by key.
 */
export function agentFsFiles(options: AgentFsFilesOptions): FileBackend {
  const fs = options?.fs;
  if (!fs || (['readFile', 'writeFile', 'stat', 'readdirPlus', 'mkdir', 'unlink', 'rmdir'] as const).some(name => typeof fs[name] !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'agentFsFiles() needs an AgentFS filesystem, such as agentfs.fs.');
  }
  const root = options.root ?? '/files';
  if (typeof root !== 'string' || !/^(?:\/[A-Za-z0-9._-]+)+$/u.test(root) || root.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'agentFsFiles(): root must be an absolute directory path, such as /files.');
  }
  const metaRoot = `${root}.mayura`;
  const singleWriter = options.singleWriter ?? false;
  if (typeof singleWriter !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'agentFsFiles(): singleWriter must be a boolean.');
  const maxFiles = options.maxFiles ?? 10_000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new MayuraError('INVALID_CONFIG', 'agentFsFiles(): maxFiles must be a positive integer.');

  const exclusive = async <T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const previous = locks.get(fs) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    locks.set(fs, previous.then(() => turn));
    await previous;
    try { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); return await body(); } finally { release(); }
  };
  const ensureDirectory = async (path: string) => {
    let current = '';
    for (const part of path.split('/').slice(1)) {
      current += `/${part}`;
      try { await fs.mkdir(current); } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        const stats = await fs.stat(current);
        if (!stats.isDirectory()) throw new MayuraError('INVALID_INPUT', 'A key names a directory where another key is a file (a and a/b cannot both be files).');
      }
    }
  };
  const readFile = async (path: string): Promise<Uint8Array | undefined> => {
    try { return new Uint8Array(await fs.readFile(path)); } catch (error) {
      if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return undefined;
      if (code(error) === 'EISDIR') return undefined;
      throw error;
    }
  };
  const sidecar = async (key: string): Promise<Sidecar> => {
    const bytes = await readFile(`${metaRoot}/${key}.json`);
    if (!bytes) return { contentType: 'application/octet-stream', metadata: {} };
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Sidecar>;
      if (typeof value.contentType !== 'string' || !value.metadata || typeof value.metadata !== 'object') throw new Error('shape');
      return { contentType: value.contentType, metadata: value.metadata };
    } catch { throw new FileStoreError('invalid_response'); }
  };
  const read = async (key: string): Promise<(FileInfo & { data: Uint8Array }) | undefined> => {
    const data = await readFile(`${root}/${key}`);
    if (!data) return undefined;
    const stats = await fs.stat(`${root}/${key}`);
    const extra = await sidecar(key);
    return { key, size: data.byteLength, etag: `"${sha256Hex(data)}"`, contentType: extra.contentType, lastModified: stats.mtime < 1e11 ? stats.mtime * 1_000 : stats.mtime,
      ...(Object.keys(extra.metadata).length ? { metadata: { ...extra.metadata } } : {}), data };
  };
  const withoutData = ({ data: _data, ...info }: FileInfo & { data: Uint8Array }): FileInfo => info;
  /** Runs a write under the lock when preconditions are kept, directly otherwise. */
  const writing = <T>(signal: AbortSignal, body: () => Promise<T>) => (singleWriter ? exclusive(signal, body) : body());

  return Object.freeze({
    id: 'agentfs',
    conditionalWrites: singleWriter,
    conditionalDelete: singleWriter,
    put: (key, data, putOptions) => writing(putOptions.signal, async () => {
      if (putOptions.ifNoneMatch !== undefined || putOptions.ifMatch !== undefined) {
        const current = await read(key);
        if ((putOptions.ifNoneMatch && current) || (putOptions.ifMatch !== undefined && current?.etag !== putOptions.ifMatch)) throw fileConflict();
      }
      const path = `${root}/${key}`;
      await ensureDirectory(path.slice(0, path.lastIndexOf('/')));
      try { await fs.writeFile(path, data); } catch (error) {
        if (code(error) === 'EISDIR') throw new MayuraError('INVALID_INPUT', 'A key names a file where other keys are under it (a and a/b cannot both be files).');
        throw error;
      }
      const metaPath = `${metaRoot}/${key}.json`;
      await ensureDirectory(metaPath.slice(0, metaPath.lastIndexOf('/')));
      await fs.writeFile(metaPath, new TextEncoder().encode(JSON.stringify({ contentType: putOptions.contentType, metadata: putOptions.metadata })));
      return { etag: `"${sha256Hex(data)}"` };
    }),
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const file = await read(key);
      if (!file) return undefined;
      if (getOptions.ifMatch !== undefined && file.etag !== getOptions.ifMatch) throw fileConflict();
      const offset = Math.min(getOptions.range?.offset ?? 0, file.size);
      const end = getOptions.range?.length === undefined ? file.size : Math.min(file.size, offset + getOptions.range.length);
      if (end - offset > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
      return { ...withoutData(file), data: file.data.slice(offset, end) };
    },
    async head(key) {
      const file = await read(key);
      return file ? withoutData(file) : undefined;
    },
    async list(listOptions) {
      const keys: string[] = [];
      const walk = async (directory: string, prefix: string): Promise<void> => {
        let entries;
        try { entries = await fs.readdirPlus(directory); } catch (error) { if (code(error) === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          const key = `${prefix}${entry.name}`;
          if (entry.stats.isDirectory()) await walk(`${directory}/${entry.name}`, `${key}/`);
          else if (entry.stats.isFile()) {
            keys.push(key);
            if (keys.length > maxFiles) throw new MayuraError('LIMIT_EXCEEDED', `The store holds more than ${maxFiles} files to list.`);
          }
        }
      };
      await walk(root, '');
      const matching = keys.filter(key => key.startsWith(listOptions.prefix) && (listOptions.cursor === undefined || compareKeys(key, listOptions.cursor) > 0)).sort(compareKeys);
      const page = matching.slice(0, listOptions.limit);
      const files: FileInfo[] = [];
      for (const key of page) { const file = await read(key); if (file) files.push(withoutData(file)); }
      return { files, ...(matching.length > page.length ? { cursor: page.at(-1)! } : {}) };
    },
    delete: (key, deleteOptions) => writing(deleteOptions.signal, async () => {
      if (deleteOptions.ifMatch !== undefined) {
        const current = await read(key);
        if (current?.etag !== deleteOptions.ifMatch) throw fileConflict();
      }
      for (const path of [`${root}/${key}`, `${metaRoot}/${key}.json`]) {
        try { await fs.unlink(path); } catch (error) { if (code(error) !== 'ENOENT' && code(error) !== 'ENOTDIR') throw error; }
        // Remove directories the key leaves empty, so they do not collide with later keys.
        let directory = path.slice(0, path.lastIndexOf('/'));
        const stop = path.startsWith(`${metaRoot}/`) ? metaRoot : root;
        while (directory.length > stop.length) {
          try { await fs.rmdir(directory); } catch { break; }
          directory = directory.slice(0, directory.lastIndexOf('/'));
        }
      }
    }),
  } satisfies FileBackend);
}
