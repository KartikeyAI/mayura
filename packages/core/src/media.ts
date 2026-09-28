import { MayuraError } from './errors.js';

// Media a model can see: images and PDFs, given to an agent with its input or returned by a tool. Media never travels
// inside JSON: it has its own channel, its own byte limits, and its bytes are never shown to hooks or events.

/** The media types Mayura accepts. Each is checked against the file's own leading bytes, not only its label. */
export const MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'] as const);
export type MediaType = typeof MEDIA_TYPES[number];

/** An image or PDF: its bytes, or an HTTPS URL the model provider fetches itself. Create it with `media` or `mediaUrl`. */
export type Media =
  | { readonly type: 'media'; readonly mediaType: MediaType; readonly data: Uint8Array; readonly name?: string }
  | { readonly type: 'media'; readonly mediaType: MediaType; readonly url: string; readonly name?: string };

/** What hooks, events and logs see of a piece of media: never its bytes. */
export interface MediaSummary {
  readonly mediaType: MediaType;
  readonly source: 'bytes' | 'url';
  /** The size of inline bytes; absent for a URL. */
  readonly bytes?: number;
  readonly name?: string;
}

/**
 * Which media an agent accepts with its input, or a tool may return. Nothing is accepted unless it is declared.
 * - `accept`: the media types allowed.
 * - `maxItems`: how many at once (default 4, at most 32).
 * - `maxBytes`: the largest single item, in bytes (default 10 MB, at most 64 MiB).
 * - `urls`: HTTPS URL prefixes a URL source must start with, such as `'https://cdn.example.com/'`. Without it, only
 *   bytes are accepted. The model provider fetches the URL, so list only addresses you trust it to read.
 */
export interface MediaPolicy {
  readonly accept: readonly MediaType[];
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly urls?: readonly string[];
}
/** A policy with its defaults filled in. */
export interface ResolvedMediaPolicy {
  readonly accept: readonly MediaType[];
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly urls: readonly string[];
}

const MAX_ITEM_BYTES = 67_108_864;
const nameText = /^[^\u0000-\u001f\u007f/\\]{1,255}$/u;

function isMediaType(value: unknown): value is MediaType { return (MEDIA_TYPES as readonly unknown[]).includes(value); }
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string): number[] => [...text].map(character => character.charCodeAt(0));

/** The media type the bytes really are, from their leading bytes; undefined when they are none of `MEDIA_TYPES`. */
export function sniffMediaType(bytes: Uint8Array): MediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return undefined;
}

function checkName(name: unknown): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || !nameText.test(name)) throw new MayuraError('INVALID_INPUT', 'A media name must be 1–255 characters, without slashes or control characters.');
  return name;
}

/**
 * Media from bytes. The bytes are copied, and must really be the given type: a PNG labelled `image/jpeg` is refused
 * here rather than by the provider.
 */
export function media(data: Uint8Array | ArrayBuffer, mediaType: MediaType, options: { readonly name?: string } = {}): Media {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (!(bytes instanceof Uint8Array)) throw new MayuraError('INVALID_INPUT', 'Media bytes must be a Uint8Array or ArrayBuffer.');
  if (!isMediaType(mediaType)) throw new MayuraError('INVALID_INPUT', `Unsupported media type; use one of ${MEDIA_TYPES.join(', ')}.`);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ITEM_BYTES) throw new MayuraError('INVALID_INPUT', 'Media must hold between 1 byte and 64 MiB.');
  const actual = sniffMediaType(bytes);
  if (actual !== mediaType) {
    throw new MayuraError('INVALID_INPUT', actual ? `These bytes are ${actual}, not ${mediaType}.` : `These bytes are not a ${mediaType} file.`);
  }
  const name = checkName(options.name);
  return Object.freeze({ type: 'media', mediaType, data: bytes.slice(), ...(name === undefined ? {} : { name }) });
}

/** Media the model provider fetches from an HTTPS URL. The agent must list the URL's prefix in `media.urls`. */
export function mediaUrl(url: string, mediaType: MediaType, options: { readonly name?: string } = {}): Media {
  if (!isMediaType(mediaType)) throw new MayuraError('INVALID_INPUT', `Unsupported media type; use one of ${MEDIA_TYPES.join(', ')}.`);
  const href = checkUrl(url);
  const name = checkName(options.name);
  return Object.freeze({ type: 'media', mediaType, url: href, ...(name === undefined ? {} : { name }) });
}

/** Media from base64 text, as it arrives in JSON (for example over HTTP). */
export function mediaFromBase64(text: string, mediaType: MediaType, options: { readonly name?: string } = {}): Media {
  return media(base64ToBytes(text), mediaType, options);
}

function checkUrl(url: unknown): string {
  let parsed: URL;
  try { parsed = new URL(typeof url === 'string' ? url : ''); } catch { throw new MayuraError('INVALID_INPUT', 'A media URL must be an absolute https:// URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href.length > 2_048) {
    throw new MayuraError('INVALID_INPUT', 'A media URL must be an https:// URL of at most 2,048 characters, without credentials.');
  }
  return parsed.href;
}

/** The summary hooks and events see. */
export function mediaSummary(item: Media): MediaSummary {
  return Object.freeze({ mediaType: item.mediaType, source: 'data' in item ? 'bytes' as const : 'url' as const,
    ...('data' in item ? { bytes: item.data.byteLength } : {}), ...(item.name === undefined ? {} : { name: item.name }) });
}

/** Validate a declared policy, filling in its defaults. `where` names it in the error, such as `Agent support`. */
export function mediaPolicy(value: MediaPolicy, where: string): ResolvedMediaPolicy {
  const fail = (why: string): never => { throw new MayuraError('INVALID_CONFIG', `${where}: media ${why}`); };
  if (!value || typeof value !== 'object') return fail('must be an object such as { accept: [\'image/png\'] }.');
  const accept = value.accept;
  if (!Array.isArray(accept) || accept.length === 0 || accept.some(type => !isMediaType(type)) || new Set(accept).size !== accept.length) {
    return fail(`accept must list distinct media types from ${MEDIA_TYPES.join(', ')}.`);
  }
  const maxItems = value.maxItems ?? 4; const maxBytes = value.maxBytes ?? 10_000_000;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 32) fail('maxItems must be between 1 and 32.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ITEM_BYTES) fail('maxBytes must be between 1 and 67,108,864.');
  const urls = value.urls ?? [];
  if (!Array.isArray(urls) || urls.length > 32) fail('urls must be a list of at most 32 https:// prefixes.');
  for (const prefix of urls) {
    let parsed: URL | undefined;
    try { parsed = new URL(prefix); } catch { /* reported below */ }
    // A prefix must end at a path boundary, so https://cdn.example.com cannot also admit https://cdn.example.com.evil.
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !prefix.endsWith('/') || parsed.href !== prefix) {
      fail(`url prefix ${JSON.stringify(String(prefix).slice(0, 80))} must be a plain https:// URL ending in /.`);
    }
  }
  return Object.freeze({ accept: Object.freeze([...accept]), maxItems, maxBytes, urls: Object.freeze([...urls]) });
}

/**
 * Check media against a policy and a byte allowance, and copy it: the result holds private copies of the bytes, so
 * a caller changing its array afterwards changes nothing. `code` is the error code for a refusal (`INVALID_INPUT` for
 * what a caller sent, `INVALID_OUTPUT` for what a tool returned); `where` names the source in the message.
 */
export function admitMedia(items: unknown, policy: ResolvedMediaPolicy | undefined, allowanceBytes: number,
  code: 'INVALID_INPUT' | 'INVALID_OUTPUT', where: string): { readonly media: readonly Media[]; readonly bytes: number } {
  const fail = (why: string): never => { throw new MayuraError(code, `${where}: ${why}`); };
  if (!Array.isArray(items)) return fail('media must be a list.');
  if (items.length === 0) return { media: Object.freeze([]), bytes: 0 };
  if (!policy) return fail('media is not accepted here; declare which types are accepted with `media: { accept: [...] }`.');
  if (items.length > policy.maxItems) fail(`at most ${policy.maxItems} media items are accepted, not ${items.length}.`);
  const admitted: Media[] = []; let total = 0;
  for (const [index, raw] of items.entries()) {
    const item = raw as Partial<Record<'type' | 'mediaType' | 'data' | 'url' | 'name', unknown>> | null;
    const label = `media ${index + 1}`;
    if (!item || typeof item !== 'object' || item.type !== 'media' || !isMediaType(item.mediaType)) return fail(`${label} is not media; create it with media() or mediaUrl().`);
    if (!policy.accept.includes(item.mediaType)) fail(`${label} is ${item.mediaType}, which is not accepted (accepted: ${policy.accept.join(', ')}).`);
    let name: string | undefined;
    try { name = checkName(item.name); } catch (error) { fail(`${label}: ${(error as Error).message}`); }
    if (item.data !== undefined) {
      if (!(item.data instanceof Uint8Array) || item.url !== undefined) return fail(`${label} must hold either bytes or a URL.`);
      const bytes = item.data.slice(); // a private copy, taken before any check
      if (bytes.byteLength === 0 || bytes.byteLength > policy.maxBytes) fail(`${label} is ${bytes.byteLength} bytes; the limit is ${policy.maxBytes}.`);
      const actual = sniffMediaType(bytes);
      if (actual !== item.mediaType) fail(actual ? `${label} is labelled ${item.mediaType} but its bytes are ${actual}.` : `${label} is labelled ${item.mediaType} but its bytes are not that type.`);
      total += bytes.byteLength;
      if (total > allowanceBytes) fail(`the media is ${total} bytes or more, above the ${allowanceBytes} bytes left under limits.maxMediaBytes.`);
      admitted.push(Object.freeze({ type: 'media', mediaType: item.mediaType, data: bytes, ...(name === undefined ? {} : { name }) }));
    } else {
      let href = '';
      try { href = checkUrl(item.url); } catch (error) { fail(`${label}: ${(error as Error).message}`); }
      if (!policy.urls.some(prefix => href.startsWith(prefix))) {
        fail(policy.urls.length === 0 ? `${label} is a URL, but no URL prefixes are allowed (media.urls); send the bytes instead.`
          : `${label} is not under an allowed URL prefix (media.urls).`);
      }
      admitted.push(Object.freeze({ type: 'media', mediaType: item.mediaType, url: href, ...(name === undefined ? {} : { name }) }));
    }
  }
  return { media: Object.freeze(admitted), bytes: total };
}

const resultMedia = new WeakMap<object, { readonly output: unknown; readonly media: readonly Media[] }>();
/**
 * A tool result with media for the model to see, such as a screenshot: return `withMedia(output, [media(...)])` from
 * the tool's `execute`. `output` is checked against the tool's output schema as usual; the tool must declare `media`.
 */
export function withMedia<T>(output: T, items: readonly Media[]): T {
  if (!Array.isArray(items)) throw new MayuraError('INVALID_OUTPUT', 'withMedia needs a list of media.');
  const wrapper = Object.freeze({ '~mayuraMedia': true });
  resultMedia.set(wrapper, Object.freeze({ output, media: Object.freeze([...items]) }));
  return wrapper as unknown as T;
}
/** The output and media of a `withMedia` result, or undefined for an ordinary result. For tool brokers. */
export function readMediaResult(value: unknown): { readonly output: unknown; readonly media: readonly Media[] } | undefined {
  return value && typeof value === 'object' ? resultMedia.get(value) : undefined;
}

/** Base64 of bytes, in browsers and Node.js alike. */
export function bytesToBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (buffer) return buffer.from(bytes).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(binary);
}
/** Bytes of base64 text; refuses anything that is not canonical base64. */
export function base64ToBytes(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
    throw new MayuraError('INVALID_INPUT', 'Media data must be base64 text.');
  }
  const binary = atob(text); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
/**
 * The most bytes the media of these messages adds to a provider request once encoded (base64, or a URL), with room
 * for each item's wrapping. Adapters allow this on top of their JSON request limit.
 */
export function encodedMediaBytes(messages: readonly object[]): number {
  let total = 0;
  for (const message of messages) for (const item of ('media' in message ? message.media as readonly Media[] | undefined : undefined) ?? []) {
    total += ('data' in item ? Math.ceil(item.data.byteLength / 3) * 4 : item.url.length) + 512 + (item.name?.length ?? 0) * 2;
  }
  return total;
}
/** A `data:` URL of inline media, as several providers take images. */
export function mediaDataUrl(item: Media & { readonly data: Uint8Array }): string {
  return `data:${item.mediaType};base64,${bytesToBase64(item.data)}`;
}
