import { MayuraError } from 'mayura';
import { fileBody, FileStoreError, fileResponseFailure, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

export interface MesaFilesOptions {
  /** A Mesa access token source (a short-lived JWT minted from your API key), called for each request. Nothing is read from the environment. */
  readonly token: () => string | Promise<string>;
  /** The organization. */
  readonly org: string;
  /** The repository. */
  readonly repo: string;
  /** The bookmark (branch) files are read from and committed to; `main` by default. */
  readonly bookmark?: string;
  /** The commit author; `Mayura <mayura@users.noreply.mesa.dev>` by default. */
  readonly author?: { readonly name: string; readonly email: string };
  /** How many times a write rebases onto a bookmark another writer moved; 5 by default. */
  readonly maxRebases?: number;
  /** The most files a listing walks; 10,000 by default. */
  readonly maxFiles?: number;
  /** Another API address instead of https://api.mesa.dev/v1, for tests: https, or http on this machine. */
  readonly apiURL?: string;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The largest file Mesa's REST API takes inline: 128 KB. */
export const mesaMaxFileBytes = 128 * 1_024;
const loopback = ['localhost', '127.0.0.1', '[::1]'];
const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const toBase64 = (data: Uint8Array) => { let binary = ''; for (let offset = 0; offset < data.byteLength; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000)); return btoa(binary); };
function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/u.test(text)) throw new FileStoreError('invalid_response');
  const binary = atob(text.replace(/[\r\n]/gu, '')); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}
const compareKeys = (left: string, right: string) => {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

/**
 * Files in a Mesa repository (mesa.dev, a versioned filesystem for agents), over its REST API with fetch:
 * `createFileStore(mesaFiles({ token, org, repo }), { maxFileBytes: mesaMaxFileBytes })`. Each key is a file path on a
 * bookmark, and each write or delete is a change committed on the bookmark's head; when another writer moved the
 * bookmark first, the write is rebased onto it, so concurrent writers never lose each other's changes. Mesa has no
 * per-file preconditions, media types or metadata: `ifMatch`, `ifNoneMatch` and metadata are refused, and reads
 * report no media type. A file's etag is its git blob SHA. Files are at most 128 KB, and ranges are read from the
 * whole file.
 */
export function mesaFiles(options: MesaFilesOptions): FileBackend {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'mesaFiles() needs a token source, an org and a repo.');
  const { token, org, repo } = options;
  const bookmark = options.bookmark ?? 'main';
  if (typeof token !== 'function') throw new MayuraError('INVALID_CONFIG', 'mesaFiles(): token must be a function returning an access token.');
  for (const [value, label] of [[org, 'org'], [repo, 'repo'], [bookmark, 'bookmark']] as const) {
    if (typeof value !== 'string' || !name.test(value)) throw new MayuraError('INVALID_CONFIG', `mesaFiles(): ${label} must be a Mesa name.`);
  }
  const author = options.author ?? { name: 'Mayura', email: 'mayura@users.noreply.mesa.dev' };
  if (!author || typeof author.name !== 'string' || !author.name.trim() || author.name.length > 200 || typeof author.email !== 'string' || !/^[^\s@]+@[^\s@]+$/u.test(author.email)) {
    throw new MayuraError('INVALID_CONFIG', 'mesaFiles(): author must have a name and an email.');
  }
  const maxRebases = options.maxRebases ?? 5;
  const maxFiles = options.maxFiles ?? 10_000;
  for (const [value, label] of [[maxRebases, 'maxRebases'], [maxFiles, 'maxFiles']] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new MayuraError('INVALID_CONFIG', `mesaFiles(): ${label} must be a positive integer.`);
  }
  let api: URL;
  try { api = new URL(options.apiURL ?? 'https://api.mesa.dev/v1'); } catch { throw new MayuraError('INVALID_CONFIG', 'mesaFiles(): apiURL must be a URL.'); }
  const local = api.protocol === 'http:' && loopback.includes(api.hostname);
  if ((api.protocol !== 'https:' && !local) || api.username || api.password || api.search || api.hash) throw new MayuraError('INVALID_CONFIG', 'mesaFiles(): apiURL must be https (or http on this machine).');
  const base = `${api.href.replace(/\/$/u, '')}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const transport = options.fetch ?? globalThis.fetch;

  const authorization = async (): Promise<string> => {
    let value: unknown;
    try { value = await token(); } catch { throw new FileStoreError('authentication'); }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 16_384) throw new FileStoreError('authentication');
    return `Bearer ${value}`;
  };
  const send = async (path: string, init: RequestInit & { headers?: Record<string, string> }) =>
    transport(`${base}${path}`, { ...init, redirect: 'error', headers: { ...init.headers, authorization: await authorization() } });
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fileBody(response, 32 * 1_048_576)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value as Record<string, unknown>;
    } catch { throw new FileStoreError('invalid_response'); }
  };
  /** The change the bookmark points at. */
  const head = async (signal: AbortSignal): Promise<string> => {
    const response = await send(`/bookmarks/${encodeURIComponent(bookmark)}`, { method: 'GET', signal });
    if (!response.ok) throw fileResponseFailure(response);
    const body = await json(response);
    if (typeof body['change_id'] !== 'string' || !body['change_id']) throw new FileStoreError('invalid_response');
    return body['change_id'];
  };
  /** A path's content at a change: a file, a directory, or undefined when there is none. */
  const content = async (path: string, change: string, signal: AbortSignal, depth = 1): Promise<Record<string, unknown> | undefined> => {
    const query = new URLSearchParams({ change_id: change, ...(path ? { path } : {}), depth: String(depth) });
    const response = await send(`/content?${query}`, { method: 'GET', signal });
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
    if (!response.ok) throw fileResponseFailure(response);
    return json(response);
  };
  const describe = (entry: Record<string, unknown>, key: string): FileInfo => {
    if (entry['type'] !== 'file' || typeof entry['sha'] !== 'string' || !entry['sha'] || !Number.isSafeInteger(entry['size']) || (entry['size'] as number) < 0) throw new FileStoreError('invalid_response');
    return { key, size: entry['size'] as number, etag: `"${entry['sha']}"` };
  };
  const read = async (key: string, signal: AbortSignal): Promise<(FileInfo & { data: Uint8Array }) | undefined> => {
    const entry = await content(key, await head(signal), signal);
    if (!entry || entry['type'] !== 'file') return undefined;
    if (entry['encoding'] !== 'base64' || typeof entry['content'] !== 'string') throw new FileStoreError('invalid_response');
    const data = fromBase64(entry['content']);
    const info = describe(entry, key);
    if (data.byteLength !== info.size) throw new FileStoreError('invalid_response');
    return { ...info, data };
  };
  /** Commits one file change on the bookmark's head, rebasing when another writer moved the bookmark first. */
  const commit = async (file: Record<string, unknown>, message: string, signal: AbortSignal): Promise<void> => {
    for (let attempt = 0; attempt <= maxRebases; attempt++) {
      const base = await head(signal);
      const created = await send('/changes', { method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base_change_id: base, message, author, files: [file] }) });
      if (!created.ok) throw fileResponseFailure(created);
      const change = await json(created);
      if (typeof change['id'] !== 'string' || !change['id']) throw new FileStoreError('invalid_response');
      if (change['is_conflicted'] === true) throw new FileStoreError('rejected');
      // Mesa moves a bookmark only forward: a 409 means another change got there first.
      const moved = await send(`/bookmarks/${encodeURIComponent(bookmark)}`, { method: 'PATCH', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ change_id: change['id'], allow_backwards: false }) });
      if (moved.ok) { void moved.body?.cancel().catch(() => undefined); return; }
      if (moved.status !== 409) throw fileResponseFailure(moved);
      void moved.body?.cancel().catch(() => undefined);
    }
    throw new FileStoreError('rate_limited');
  };
  const withoutData = ({ data: _data, ...info }: FileInfo & { data: Uint8Array }): FileInfo => info;

  return Object.freeze({
    id: 'mesa',
    conditionalWrites: false,
    conditionalDelete: false,
    async put(key, data, putOptions) {
      if (Object.keys(putOptions.metadata).length) throw new MayuraError('INVALID_INPUT', 'Mesa keeps no file metadata.');
      if (data.byteLength > mesaMaxFileBytes) throw new MayuraError('LIMIT_EXCEEDED', `Mesa takes files of at most ${mesaMaxFileBytes} bytes over its REST API.`);
      await commit({ path: key, content: toBase64(data), encoding: 'base64', action: 'upsert' }, `Write ${key}`, putOptions.signal);
      const written = await read(key, putOptions.signal);
      if (!written) throw new FileStoreError('invalid_response');
      return { etag: written.etag };
    },
    async get(key, getOptions): Promise<StoredFile | undefined> {
      const file = await read(key, getOptions.signal);
      if (!file) return undefined;
      const offset = Math.min(getOptions.range?.offset ?? 0, file.size);
      const end = getOptions.range?.length === undefined ? file.size : Math.min(file.size, offset + getOptions.range.length);
      if (end - offset > getOptions.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${getOptions.maxBytes} bytes.`);
      return { ...withoutData(file), data: file.data.slice(offset, end) };
    },
    async head(key, headOptions) {
      const entry = await content(key, await head(headOptions.signal), headOptions.signal);
      return entry && entry['type'] === 'file' ? describe(entry, key) : undefined;
    },
    async list(listOptions) {
      const change = await head(listOptions.signal);
      const found: FileInfo[] = [];
      // Directories down to Mesa's depth limit come in one answer; deeper ones are asked for in turn.
      const walk = async (path: string): Promise<void> => {
        const entry = await content(path, change, listOptions.signal, 10);
        if (!entry || entry['type'] !== 'dir') return;
        const visit = async (entries: unknown): Promise<void> => {
          if (!Array.isArray(entries)) return;
          for (const item of entries as Record<string, unknown>[]) {
            if (typeof item?.['path'] !== 'string') throw new FileStoreError('invalid_response');
            if (item['type'] === 'file') {
              if (item['path'].startsWith(listOptions.prefix)) found.push(describe(item, item['path']));
              if (found.length > maxFiles) throw new MayuraError('LIMIT_EXCEEDED', `The repository holds more than ${maxFiles} files to list.`);
            } else if (item['type'] === 'dir' && (listOptions.prefix.startsWith(`${item['path']}/`) || `${item['path']}/`.startsWith(listOptions.prefix) || item['path'].startsWith(listOptions.prefix))) {
              if (Array.isArray(item['entries'])) await visit(item['entries']); else await walk(item['path']);
            }
          }
        };
        await visit(entry['entries']);
      };
      await walk('');
      const keys = found.filter(file => listOptions.cursor === undefined || compareKeys(file.key, listOptions.cursor) > 0).sort((a, b) => compareKeys(a.key, b.key));
      const page = keys.slice(0, listOptions.limit);
      return { files: page, ...(keys.length > page.length ? { cursor: page.at(-1)!.key } : {}) };
    },
    async delete(key, deleteOptions) {
      const entry = await content(key, await head(deleteOptions.signal), deleteOptions.signal);
      if (!entry || entry['type'] !== 'file') return;
      await commit({ path: key, action: 'delete' }, `Delete ${key}`, deleteOptions.signal);
    },
  } satisfies FileBackend);
}
