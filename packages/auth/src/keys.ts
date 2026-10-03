import { MayuraError } from '@mayura/core';
import { fromBase64Url } from '@mayura/core/host';

/** A JWS algorithm a verifier may accept. `none` never is. */
export type JwtAlgorithm = 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512' | 'EdDSA' | 'HS256' | 'HS384' | 'HS512';
export const jwtAlgorithms: readonly JwtAlgorithm[] = Object.freeze(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA', 'HS256', 'HS384', 'HS512']);

/** A public key as a JWKS lists it. */
export interface Jwk {
  readonly kty: string; readonly kid?: string; readonly alg?: string; readonly use?: string; readonly key_ops?: readonly string[];
  readonly n?: string; readonly e?: string; readonly crv?: string; readonly x?: string; readonly y?: string;
  /** Other members a key set may give, such as the `issuer` a key is bound to (Microsoft Entra ID). */
  readonly [member: string]: unknown;
}

/**
 * Narrows the keys a token may be verified with, by its claims, which are not verified yet when keys are chosen: it can
 * only refuse keys, and the signature and issuer are still checked afterwards. For example, a key bound to one issuer.
 */
export type JwtKeyFilter = (key: Jwk, claims: Readonly<Record<string, unknown>>) => boolean;

/** Where a verifier finds the key for a token: by its header's `kid` and `alg`. */
export interface JwtKeySource {
  /** The key to verify a token with this header; undefined when there is none. Throws when keys cannot be reached. */
  key(header: { readonly alg: JwtAlgorithm; readonly kid?: string }, options: { readonly signal: AbortSignal; readonly claims?: Readonly<Record<string, unknown>> }): Promise<CryptoKey | undefined>;
}

interface Family { readonly kty: 'RSA' | 'EC' | 'OKP' | 'oct'; readonly import: RsaHashedImportParams | EcKeyImportParams | Algorithm | HmacImportParams; readonly verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams; readonly curve?: string }
const hash = (bits: 256 | 384 | 512) => `SHA-${bits}`;
const rsa = (bits: 256 | 384 | 512): Family => ({ kty: 'RSA', import: { name: 'RSASSA-PKCS1-v1_5', hash: hash(bits) }, verify: { name: 'RSASSA-PKCS1-v1_5' } });
const pss = (bits: 256 | 384 | 512): Family => ({ kty: 'RSA', import: { name: 'RSA-PSS', hash: hash(bits) }, verify: { name: 'RSA-PSS', saltLength: bits / 8 } });
const ec = (bits: 256 | 384 | 512, curve: string): Family => ({ kty: 'EC', curve, import: { name: 'ECDSA', namedCurve: curve }, verify: { name: 'ECDSA', hash: hash(bits) } });
const hmac = (bits: 256 | 384 | 512): Family => ({ kty: 'oct', import: { name: 'HMAC', hash: hash(bits) }, verify: { name: 'HMAC' } });
/** @internal How each algorithm is verified with WebCrypto. */
export const families: Readonly<Record<JwtAlgorithm, Family>> = Object.freeze({
  RS256: rsa(256), RS384: rsa(384), RS512: rsa(512), PS256: pss(256), PS384: pss(384), PS512: pss(512),
  // JWS ECDSA signatures are the raw r and s, which is what WebCrypto takes.
  ES256: ec(256, 'P-256'), ES384: ec(384, 'P-384'), ES512: ec(512, 'P-521'),
  EdDSA: { kty: 'OKP', curve: 'Ed25519', import: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
  HS256: hmac(256), HS384: hmac(384), HS512: hmac(512),
});

/** Imports a JWK for `alg`, or undefined when it is not a usable public key for that algorithm. */
async function importJwk(jwk: Jwk, alg: JwtAlgorithm): Promise<CryptoKey | undefined> {
  const family = families[alg];
  if (jwk.kty !== family.kty) return undefined;
  if (jwk.alg !== undefined && jwk.alg !== alg) return undefined;
  if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
  if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) return undefined;
  let material: JsonWebKey;
  if (family.kty === 'RSA') {
    const modulus = typeof jwk.n === 'string' ? fromBase64Url(jwk.n) : undefined;
    // RSA keys below 2048 bits are refused.
    if (!modulus || modulus.length < 256 || typeof jwk.e !== 'string' || !fromBase64Url(jwk.e)) return undefined;
    material = { kty: 'RSA', n: jwk.n!, e: jwk.e };
  } else if (family.kty === 'EC') {
    if (jwk.crv !== family.curve || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return undefined;
    material = { kty: 'EC', crv: family.curve!, x: jwk.x, y: jwk.y };
  } else if (family.kty === 'OKP') {
    if (jwk.crv !== family.curve || typeof jwk.x !== 'string') return undefined;
    material = { kty: 'OKP', crv: family.curve!, x: jwk.x };
  } else return undefined; // A JWKS never supplies an HMAC secret.
  try { return await crypto.subtle.importKey('jwk', material, family.import, false, ['verify']); }
  catch { return undefined; }
}

/** The one key of `keys` for this header: by `kid`, or the only one usable for `alg` when the token names none. */
async function pick(keys: readonly Jwk[], header: { readonly alg: JwtAlgorithm; readonly kid?: string }, cache: Map<string, Promise<CryptoKey | undefined>>, filter?: JwtKeyFilter, claims?: Readonly<Record<string, unknown>>): Promise<CryptoKey | undefined> {
  const named = header.kid === undefined ? keys : keys.filter(key => key.kid === header.kid);
  // With a filter, keys the token's claims rule out are not candidates at all; without claims, no key passes it.
  const candidates = filter ? named.filter(key => claims !== undefined && filter(key, claims)) : named;
  const usable: CryptoKey[] = [];
  for (const [index, key] of candidates.entries()) {
    const id = `${header.alg} ${key.kid ?? `#${index}`}`;
    let imported = cache.get(id);
    if (!imported) { imported = importJwk(key, header.alg); cache.set(id, imported); }
    const found = await imported;
    if (found) usable.push(found);
  }
  // Without a kid, a choice between keys would be a guess.
  return usable.length === 1 ? usable[0] : undefined;
}

function checkJwks(value: unknown, maxKeys: number): readonly Jwk[] {
  const keys = Array.isArray(value) ? value : (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > maxKeys || keys.some(key => !key || typeof key !== 'object' || typeof (key as Jwk).kty !== 'string')) {
    throw new MayuraError('INVALID_CONFIG', `A JWKS is { keys: [...] } with at most ${maxKeys} keys, each with a kty.`);
  }
  return Object.freeze(keys.map(key => Object.freeze({ ...key })) as Jwk[]);
}

/** Keys known in advance, such as a provider's published PEM converted to a JWK, for verification without a network. */
export function staticKeys(jwks: { readonly keys: readonly Jwk[] } | readonly Jwk[], options: { readonly keyFilter?: JwtKeyFilter } = {}): JwtKeySource {
  const keys = checkJwks(jwks, 100);
  const filter = checkFilter(options?.keyFilter, 'staticKeys()');
  const cache = new Map<string, Promise<CryptoKey | undefined>>();
  return Object.freeze({ key: async (header: { readonly alg: JwtAlgorithm; readonly kid?: string }, keyOptions?: { readonly claims?: Readonly<Record<string, unknown>> }) => pick(keys, header, cache, filter, keyOptions?.claims) });
}

function checkFilter(value: unknown, owner: string): JwtKeyFilter | undefined {
  if (value !== undefined && typeof value !== 'function') throw new MayuraError('INVALID_CONFIG', `${owner}: keyFilter is a function of a key and the token's claims.`);
  return value as JwtKeyFilter | undefined;
}

/** A shared secret for HS256, HS384 or HS512 tokens: at least 32 bytes. Only for issuers that sign with one. */
export function hmacSecret(secret: string | Uint8Array): JwtKeySource {
  const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) throw new MayuraError('INVALID_CONFIG', 'hmacSecret(): the secret is at least 32 bytes.');
  const copy = new Uint8Array(bytes);
  const cache = new Map<string, Promise<CryptoKey>>();
  return Object.freeze({
    key: async (header: { readonly alg: JwtAlgorithm }) => {
      const family = families[header.alg];
      if (family.kty !== 'oct') return undefined;
      let key = cache.get(header.alg);
      if (!key) { key = crypto.subtle.importKey('raw', copy, family.import, false, ['verify']); cache.set(header.alg, key); }
      return key;
    },
  });
}

export interface RemoteJwksOptions {
  /** The JWKS URL: https, or http only on this machine. */
  readonly url: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The longest wait for the JWKS; 5 s by default (1 s to 30 s). */
  readonly timeoutMs?: number;
  /** The longest the keys are kept, whatever the response's Cache-Control says; 10 minutes by default (1 minute to 24 hours). */
  readonly maxAgeMs?: number;
  /** A token with a key id not in the cached keys refetches them, at most this often; 30 s by default (1 s to 10 minutes). */
  readonly minRefreshMs?: number;
  /** The largest JWKS accepted, in bytes; 256 KiB by default. */
  readonly maxBytes?: number;
  /** The most keys accepted; 100 by default. */
  readonly maxKeys?: number;
  /** Narrows the keys each token may use, by its claims (see `JwtKeyFilter`). */
  readonly keyFilter?: JwtKeyFilter;
}

function bounded(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `remoteJwks(): ${name} is ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`);
  return result;
}
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * An issuer's published keys, fetched from its JWKS URL and kept for the response's `Cache-Control: max-age` (capped
 * by `maxAgeMs`). A token signed by a key not yet in them refetches the keys, no more often than `minRefreshMs`, so
 * rotated keys are found and unknown key ids cannot make it fetch on every request. When the keys cannot be fetched
 * and none are cached (or those cached are more than `maxAgeMs` past their age), verification throws: the server answers
 * that authentication is unavailable, never that the caller is someone.
 */
export function remoteJwks(options: RemoteJwksOptions): JwtKeySource & { readonly url: string } {
  let url: URL;
  try { url = new URL(options?.url); } catch { throw new MayuraError('INVALID_CONFIG', 'remoteJwks(): url is the JWKS URL.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) || url.username || url.password || url.hash) {
    throw new MayuraError('INVALID_CONFIG', 'remoteJwks(): url is an https URL (http only on this machine), without credentials.');
  }
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'remoteJwks(): fetch must be a function.');
  const timeoutMs = bounded(options.timeoutMs, 'timeoutMs', 5_000, 1_000, 30_000);
  const maxAgeMs = bounded(options.maxAgeMs, 'maxAgeMs', 600_000, 60_000, 86_400_000);
  const minRefreshMs = bounded(options.minRefreshMs, 'minRefreshMs', 30_000, 1_000, 600_000);
  const maxBytes = bounded(options.maxBytes, 'maxBytes', 262_144, 1_024, 4_194_304);
  const maxKeys = bounded(options.maxKeys, 'maxKeys', 100, 1, 1_000);
  const filter = checkFilter(options.keyFilter, 'remoteJwks()');
  const fetcher = options.fetch ?? globalThis.fetch;
  let current: { readonly keys: readonly Jwk[]; readonly until: number; readonly cache: Map<string, Promise<CryptoKey | undefined>> } | undefined;
  let lastFetch = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  // One fetch at a time, bounded by its own timeout: a caller that gives up stops waiting, not the fetch others share.
  const load = async (): Promise<void> => {
    lastFetch = Date.now();
    const response = await fetcher(url.href, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new MayuraError('TOOL_FAILED', `The JWKS answered HTTP ${response.status}.`); }
    const text = await readBounded(response, maxBytes);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new MayuraError('TOOL_FAILED', 'The JWKS is not JSON.'); }
    let keys: readonly Jwk[];
    try { keys = checkJwks(parsed, maxKeys); } catch { throw new MayuraError('TOOL_FAILED', 'The JWKS is not a key set Mayura can use.'); }
    const maxAge = /(?:^|,)\s*max-age=(\d{1,9})\s*(?:,|$)/iu.exec(response.headers.get('cache-control') ?? '')?.[1];
    const ageMs = maxAge === undefined ? maxAgeMs : Math.min(maxAgeMs, Math.max(minRefreshMs, Number(maxAge) * 1_000));
    current = { keys, until: Date.now() + ageMs, cache: new Map() };
  };
  const refresh = (signal: AbortSignal): Promise<void> => {
    inFlight ??= load().finally(() => { inFlight = undefined; });
    return abortable(inFlight, signal);
  };

  return Object.freeze({
    url: url.href,
    key: async (header: { readonly alg: JwtAlgorithm; readonly kid?: string }, { signal, claims }: { readonly signal: AbortSignal; readonly claims?: Readonly<Record<string, unknown>> }) => {
      if (families[header.alg].kty === 'oct') return undefined;
      if (!current || Date.now() >= current.until) {
        try { await refresh(signal); }
        catch (error) {
          // Keys past their age stay in use while the JWKS cannot be reached, for one more maxAgeMs at most.
          if (!current || Date.now() >= current.until + maxAgeMs || (error instanceof MayuraError && error.code === 'CANCELLED')) {
            throw error instanceof MayuraError ? error : new MayuraError('TOOL_FAILED', 'The JWKS could not be fetched.');
          }
        }
      }
      const found = await pick(current!.keys, header, current!.cache, filter, claims);
      if (found || Date.now() - lastFetch < minRefreshMs) return found;
      // A key not seen yet: the issuer may have rotated.
      try { await refresh(signal); } catch { return undefined; }
      return pick(current!.keys, header, current!.cache, filter, claims);
    },
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MayuraError('CANCELLED', 'Authentication was cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new MayuraError('CANCELLED', 'Authentication was cancelled.'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); }, error => { signal.removeEventListener('abort', stop); reject(error); });
  });
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) { void response.body?.cancel().catch(() => undefined); throw new MayuraError('TOOL_FAILED', 'The JWKS is too large.'); }
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new MayuraError('TOOL_FAILED', 'The JWKS is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
