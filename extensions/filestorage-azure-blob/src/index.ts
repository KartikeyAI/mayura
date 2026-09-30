import { MayuraError } from 'mayura';
import { fileBody, fileConflict, FileStoreError, fileResponseFailure, type FileBackend, type FileInfo, type StoredFile } from 'mayura/files';

export interface AzureBlobFilesOptions {
  /** The storage account's name. */
  readonly account: string;
  /** The container. */
  readonly container: string;
  /** The account key, base64, for Shared Key signing. Give this, `token` or `sas`. Nothing is read from the environment. */
  readonly accountKey?: string;
  /** A Microsoft Entra ID token source for `https://storage.azure.com/`, called for each request. Give this, `accountKey` or `sas`. */
  readonly token?: () => string | Promise<string>;
  /** A shared access signature: the query string Azure gave, without a leading `?`. Give this, `accountKey` or `token`. */
  readonly sas?: string;
  /**
   * Another endpoint instead of `https://<account>.blob.core.windows.net`: https, or http on this machine for Azurite,
   * whose endpoint names the account in its path (`http://127.0.0.1:10000/devstoreaccount1`).
   */
  readonly endpoint?: string;
  /** The largest list response read; 16 MiB by default. */
  readonly maxListResponseBytes?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The Blob service version every request asks for. */
export const azureBlobVersion = '2024-11-04';

const loopback = ['localhost', '127.0.0.1', '[::1]'];
const encoder = new TextEncoder();
const xmlEntities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(value: string): string {
  return value.replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gu, (_, entity: string) => entity.startsWith('#x') ? String.fromCodePoint(parseInt(entity.slice(2), 16))
    : entity.startsWith('#') ? String.fromCodePoint(Number(entity.slice(1))) : xmlEntities[entity]!);
}
function xmlTag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, 'u').exec(xml);
  return match ? xmlText(match[1]!) : undefined;
}
/** ETags as headers carry them, quoted: listings give them bare. */
const quoted = (etag: string) => (etag.startsWith('"') ? etag : `"${etag}"`);
/**
 * Metadata names Azure accepts are C# identifiers, without `-`: a file store key such as `run-id` is stored as
 * `m_run_id`, and read back.
 */
const metadataName = (key: string) => `m_${key.replace(/-/gu, '_')}`;
const metadataKey = (name: string) => (name.startsWith('m_') ? name.slice(2).replace(/_/gu, '-') : name);
const toBase64 = (bytes: Uint8Array) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
function fromBase64(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text) || text.length % 4 !== 0) return undefined;
  const binary = atob(text); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Files in an Azure Blob Storage container, over the Blob REST API with fetch and no dependencies:
 * `createFileStore(azureBlobFiles({ account, container, accountKey }), { maxFileBytes })`. Blobs are block blobs
 * written in one request; `ifMatch`, `ifNoneMatch` and conditional deletes are Azure's own conditional headers.
 */
export function azureBlobFiles(options: AzureBlobFilesOptions): FileBackend {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles() needs an account, a container and credentials.');
  const { account, container, accountKey, token, sas } = options;
  if (typeof account !== 'string' || !/^[a-z0-9]{3,24}$/u.test(account)) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): account must be a storage account name.');
  if (typeof container !== 'string' || !/^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/u.test(container) || container.includes('--')) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): container must be a container name.');
  if ([accountKey, token, sas].filter(item => item !== undefined).length !== 1) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles() needs one of accountKey, token or sas.');
  const key = accountKey === undefined ? undefined : typeof accountKey === 'string' ? fromBase64(accountKey) : undefined;
  if (accountKey !== undefined && (key === undefined || key.byteLength === 0)) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): accountKey must be the base64 account key.');
  if (token !== undefined && typeof token !== 'function') throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): token must be a function returning an access token.');
  let sasParameters: [string, string][] = [];
  if (sas !== undefined) {
    if (typeof sas !== 'string' || !sas || sas.startsWith('?') || sas.length > 4_096 || /[\s#]/u.test(sas)) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): sas must be the signature query string, without a leading ?.');
    sasParameters = [...new URLSearchParams(sas)];
    if (!sasParameters.some(([name]) => name === 'sig')) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): sas must contain a signature (sig).');
  }
  let origin: URL;
  try { origin = new URL(options.endpoint ?? `https://${account}.blob.core.windows.net`); } catch { throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): endpoint must be a URL.'); }
  const local = origin.protocol === 'http:' && loopback.includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !local) || origin.username || origin.password || origin.search || origin.hash || (origin.pathname !== '/' && origin.pathname !== `/${account}`)) {
    throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): endpoint must be an https origin (or an http one on this machine), optionally with the account as its path.');
  }
  const maxListResponseBytes = options.maxListResponseBytes ?? 16 * 1_048_576;
  if (!Number.isSafeInteger(maxListResponseBytes) || maxListResponseBytes <= 0) throw new MayuraError('INVALID_CONFIG', 'azureBlobFiles(): maxListResponseBytes must be a positive integer.');
  const base = `${origin.protocol}//${origin.host}${origin.pathname === '/' ? '' : origin.pathname}/${container}`;
  const transport = options.fetch ?? globalThis.fetch;
  const signingKey = key === undefined ? undefined : crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  /** Shared Key: the canonical request, signed with the account key. */
  const sharedKey = async (method: string, url: URL, headers: Record<string, string>, contentLength: number): Promise<string> => {
    const canonicalHeaders = Object.keys(headers).filter(name => name.startsWith('x-ms-')).sort()
      .map(name => `${name}:${headers[name]!.trim().replace(/\s+/gu, ' ')}\n`).join('');
    const parameters = new Map<string, string[]>();
    url.searchParams.forEach((value, name) => { const lower = name.toLowerCase(); parameters.set(lower, [...(parameters.get(lower) ?? []), value]); });
    const canonicalResource = `/${account}${url.pathname}` + [...parameters.keys()].sort().map(name => `\n${name}:${parameters.get(name)!.sort().join(',')}`).join('');
    const stringToSign = [method, headers['content-encoding'] ?? '', headers['content-language'] ?? '', contentLength > 0 ? String(contentLength) : '', '', headers['content-type'] ?? '', '',
      '', headers['if-match'] ?? '', headers['if-none-match'] ?? '', '', '', canonicalHeaders + canonicalResource].join('\n');
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey!, encoder.encode(stringToSign)));
    return `SharedKey ${account}:${toBase64(signature)}`;
  };
  const credential = async (method: string, url: URL, headers: Record<string, string>, contentLength: number): Promise<Record<string, string>> => {
    if (signingKey) return { authorization: await sharedKey(method, url, headers, contentLength) };
    if (!token) return {};
    let value: unknown;
    try { value = await token(); } catch { throw new FileStoreError('authentication'); }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 16_384) throw new FileStoreError('authentication');
    return { authorization: `Bearer ${value}` };
  };
  const send = async (method: string, blob: string | undefined, init: { query?: [string, string][]; headers?: Record<string, string>; body?: Uint8Array; signal: AbortSignal }) => {
    const path = blob === undefined ? '' : `/${blob.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(`${base}${path}`);
    for (const [name, value] of [...(init.query ?? []), ...sasParameters]) url.searchParams.append(name, value);
    const headers: Record<string, string> = { ...init.headers, 'x-ms-date': new Date().toUTCString(), 'x-ms-version': azureBlobVersion };
    const auth = await credential(method, url, headers, init.body?.byteLength ?? 0);
    return transport(url, { method, redirect: 'error', signal: init.signal, headers: { ...headers, ...auth }, ...(init.body ? { body: init.body as BodyInit } : {}) });
  };
  const describe = (blob: string, response: Response, size: number): FileInfo => {
    const etag = response.headers.get('etag');
    if (!etag) throw new FileStoreError('invalid_response');
    const metadata: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (name.startsWith('x-ms-meta-')) metadata[metadataKey(name.slice(10))] = value; });
    const type = response.headers.get('content-type'); const modified = Date.parse(response.headers.get('last-modified') ?? '');
    return { key: blob, size, etag: quoted(etag), ...(type ? { contentType: type } : {}), ...(Number.isFinite(modified) ? { lastModified: modified } : {}), ...(Object.keys(metadata).length ? { metadata } : {}) };
  };
  const head = async (blob: string, signal: AbortSignal): Promise<FileInfo | undefined> => {
    const response = await send('HEAD', blob, { signal });
    if (response.status === 404) return undefined;
    if (!response.ok) throw fileResponseFailure(response);
    const length = response.headers.get('content-length');
    if (length === null || !/^\d{1,16}$/u.test(length)) throw new FileStoreError('invalid_response');
    return describe(blob, response, Number(length));
  };
  const cancel = (response: Response) => { void response.body?.cancel().catch(() => undefined); };

  return Object.freeze({
    id: 'azure-blob',
    conditionalWrites: true,
    conditionalDelete: true,
    async put(blob, data, putOptions) {
      const headers: Record<string, string> = { 'x-ms-blob-type': 'BlockBlob', 'content-type': putOptions.contentType };
      for (const [name, value] of Object.entries(putOptions.metadata)) headers[`x-ms-meta-${metadataName(name)}`] = value;
      if (putOptions.ifNoneMatch) headers['if-none-match'] = '*';
      if (putOptions.ifMatch !== undefined) headers['if-match'] = putOptions.ifMatch;
      const response = await send('PUT', blob, { headers, body: data, signal: putOptions.signal });
      // Azure answers a create-only write to an existing blob with 409 BlobAlreadyExists, and If-Match on a missing one with 404.
      if ((putOptions.ifNoneMatch && response.status === 409) || (putOptions.ifMatch !== undefined && response.status === 404)) { cancel(response); throw fileConflict(); }
      if (!response.ok) throw fileResponseFailure(response);
      cancel(response);
      const etag = response.headers.get('etag');
      if (!etag) throw new FileStoreError('invalid_response');
      const modified = Date.parse(response.headers.get('last-modified') ?? '');
      return { etag: quoted(etag), ...(Number.isFinite(modified) ? { lastModified: modified } : {}) };
    },
    async get(blob, getOptions): Promise<StoredFile | undefined> {
      const headers: Record<string, string> = {};
      const range = getOptions.range;
      if (range && (range.offset > 0 || range.length !== undefined)) headers['x-ms-range'] = `bytes=${range.offset}-${range.length === undefined ? '' : range.offset + range.length - 1}`;
      if (getOptions.ifMatch !== undefined) headers['if-match'] = getOptions.ifMatch;
      const response = await send('GET', blob, { headers, signal: getOptions.signal });
      if (response.status === 404) { cancel(response); return undefined; }
      if (response.status === 416) {
        // A range that starts at or past the end: the file is there, and the range holds nothing.
        cancel(response);
        const file = await head(blob, getOptions.signal);
        if (file && getOptions.ifMatch !== undefined && file.etag !== quoted(getOptions.ifMatch)) throw fileConflict();
        return file ? { ...file, data: new Uint8Array(0) } : undefined;
      }
      if (!response.ok) throw fileResponseFailure(response);
      let size = -1;
      if (response.status === 206) {
        const match = /^bytes \d+-\d+\/(\d{1,16})$/u.exec(response.headers.get('content-range') ?? '');
        if (!match) { cancel(response); throw new FileStoreError('invalid_response'); }
        size = Number(match[1]);
      }
      const data = await fileBody(response, getOptions.maxBytes);
      return { ...describe(blob, response, size === -1 ? data.byteLength : size), data };
    },
    head: (blob, headOptions) => head(blob, headOptions.signal),
    async list(listOptions) {
      const query: [string, string][] = [['restype', 'container'], ['comp', 'list'], ['maxresults', String(listOptions.limit)]];
      if (listOptions.prefix) query.push(['prefix', listOptions.prefix]);
      if (listOptions.cursor !== undefined) query.push(['marker', listOptions.cursor]);
      const response = await send('GET', undefined, { query, signal: listOptions.signal });
      if (!response.ok) throw fileResponseFailure(response);
      let xml: string;
      try { xml = new TextDecoder('utf-8', { fatal: true }).decode(await fileBody(response, maxListResponseBytes)); } catch { throw new FileStoreError('invalid_response'); }
      if (!/<EnumerationResults[\s>]/u.test(xml)) throw new FileStoreError('invalid_response');
      const files: FileInfo[] = [];
      for (const [, entry] of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/gu)) {
        const encoded = /<Name\s+Encoded="true"\s*>/u.test(entry!);
        const rawName = xmlTag(entry!, 'Name'); const size = xmlTag(entry!, 'Content-Length'); const etag = xmlTag(entry!, 'Etag');
        if (rawName === undefined || size === undefined || !/^\d{1,16}$/u.test(size) || !etag) throw new FileStoreError('invalid_response');
        let name = rawName;
        if (encoded) { try { name = decodeURIComponent(rawName); } catch { throw new FileStoreError('invalid_response'); } }
        const modified = Date.parse(xmlTag(entry!, 'Last-Modified') ?? ''); const type = xmlTag(entry!, 'Content-Type');
        files.push({ key: name, size: Number(size), etag: quoted(etag), ...(type ? { contentType: type } : {}), ...(Number.isFinite(modified) ? { lastModified: modified } : {}) });
      }
      const next = xmlTag(xml, 'NextMarker');
      return { files, ...(next ? { cursor: next } : {}) };
    },
    async delete(blob, deleteOptions) {
      const headers: Record<string, string> = { 'x-ms-delete-snapshots': 'include', ...(deleteOptions.ifMatch === undefined ? {} : { 'if-match': deleteOptions.ifMatch }) };
      const response = await send('DELETE', blob, { headers, signal: deleteOptions.signal });
      cancel(response);
      if (response.status === 404) { if (deleteOptions.ifMatch !== undefined) throw fileConflict(); return; }
      if (!response.ok) throw fileResponseFailure(response);
    },
  } satisfies FileBackend);
}
