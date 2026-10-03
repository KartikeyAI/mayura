import { MayuraError } from '@mayura/core';
import { fromBase64Url } from '@mayura/core/host';
import { families, jwtAlgorithms, type JwtAlgorithm, type JwtKeySource } from './keys.js';

export interface JwtHeader { readonly alg: JwtAlgorithm; readonly kid?: string; readonly typ?: string; readonly [name: string]: unknown }
/** A verified token's claims. */
export interface JwtClaims {
  readonly iss: string; readonly exp: number; readonly sub?: string; readonly aud?: string | readonly string[];
  readonly nbf?: number; readonly iat?: number; readonly jti?: string; readonly [name: string]: unknown;
}
/** Why a token was refused. */
export type JwtRefusal = 'malformed' | 'too_large' | 'algorithm' | 'type' | 'key' | 'signature' | 'issuer' | 'audience' | 'expired' | 'not_yet_valid' | 'lifetime';
export type JwtResult = { readonly ok: true; readonly header: JwtHeader; readonly claims: JwtClaims } | { readonly ok: false; readonly reason: JwtRefusal };

export interface JwtVerifierOptions {
  /** The issuer (`iss`) tokens must name, or the issuers. Compared exactly. */
  readonly issuer: string | readonly string[];
  /**
   * The audience (`aud`) a token must include one of; `false` only for issuers whose tokens carry none (check what
   * stands for it, such as Clerk's `azp`, in your identity mapping).
   */
  readonly audience: string | readonly string[] | false;
  /** The algorithms accepted, which the issuer signs with; nothing else is, and never `none`. */
  readonly algorithms: readonly JwtAlgorithm[];
  /** Where the keys come from: `remoteJwks`, `staticKeys` or `hmacSecret`. */
  readonly keys: JwtKeySource;
  /** The token types (`typ` header) accepted, such as `['at+jwt']`; any by default. */
  readonly types?: readonly string[];
  /** Clock difference allowed when checking `exp`, `nbf` and `iat`; 5 s by default (0 to 60 s). */
  readonly clockSkewMs?: number;
  /** Refuse tokens meant to last longer than this (`exp` - `iat`); no limit by default. */
  readonly maxLifetimeMs?: number;
  /** The largest token accepted, in bytes; 16 KiB by default. */
  readonly maxTokenBytes?: number;
}

export interface JwtVerifier {
  readonly issuers: readonly string[];
  /** Checks a token: its form, algorithm, signature, issuer, audience and times. Throws only when keys cannot be reached. */
  verify(token: string, options?: { readonly signal?: AbortSignal }): Promise<JwtResult>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const refuse = (reason: JwtRefusal): JwtResult => ({ ok: false, reason });
function json(part: string): Record<string, unknown> | undefined {
  const bytes = fromBase64Url(part);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The `iss` a token names, unverified: only to choose which verifier should check it. */
export function peekIssuer(token: string): string | undefined {
  if (typeof token !== 'string' || token.length > 65_536) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const iss = json(parts[1]!)?.['iss'];
  return typeof iss === 'string' ? iss : undefined;
}

/**
 * A JWT verifier for one issuer, on WebCrypto alone (every runtime Mayura supports): RS, PS and ES 256/384/512, EdDSA
 * (Ed25519) and, only with `hmacSecret`, HS 256/384/512. A token passes when its signature is the issuer's, with an
 * algorithm on the list, and its issuer, audience and times hold; `exp` is required.
 */
export function jwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  const issuers = typeof options?.issuer === 'string' ? [options.issuer] : options?.issuer;
  if (!Array.isArray(issuers) || issuers.length === 0 || issuers.length > 32 || issuers.some(issuer => typeof issuer !== 'string' || issuer === '' || issuer.length > 2_048)) {
    throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): issuer is the issuer, or 1 to 32 issuers.');
  }
  const audiences = options.audience === false ? false : typeof options.audience === 'string' ? [options.audience] : options.audience;
  if (audiences !== false && (!Array.isArray(audiences) || audiences.length === 0 || audiences.length > 32 || audiences.some(audience => typeof audience !== 'string' || audience === ''))) {
    throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): audience is the audience, 1 to 32 audiences, or false for issuers whose tokens carry none.');
  }
  if (!Array.isArray(options.algorithms) || options.algorithms.length === 0 || options.algorithms.some(alg => !jwtAlgorithms.includes(alg))) {
    throw new MayuraError('INVALID_CONFIG', `jwtVerifier(): algorithms are some of ${jwtAlgorithms.join(', ')}.`);
  }
  if (!options.keys || typeof options.keys.key !== 'function') throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): keys is remoteJwks(...), staticKeys(...) or hmacSecret(...).');
  if (options.types !== undefined && (!Array.isArray(options.types) || options.types.some(type => typeof type !== 'string'))) throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): types are token types such as at+jwt.');
  const skew = options.clockSkewMs ?? 5_000;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 60_000) throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): clockSkewMs is 0 to 60,000.');
  if (options.maxLifetimeMs !== undefined && (!Number.isSafeInteger(options.maxLifetimeMs) || options.maxLifetimeMs < 1_000)) throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): maxLifetimeMs is at least 1,000.');
  const maxBytes = options.maxTokenBytes ?? 16_384;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 65_536) throw new MayuraError('INVALID_CONFIG', 'jwtVerifier(): maxTokenBytes is 256 to 65,536.');
  const algorithms = new Set(options.algorithms); const types = options.types ? new Set(options.types.map(type => type.toLowerCase())) : undefined;
  const keys = options.keys;

  return Object.freeze({
    issuers: Object.freeze([...issuers]),
    verify: async (token: string, verifyOptions: { readonly signal?: AbortSignal } = {}): Promise<JwtResult> => {
      if (typeof token !== 'string') return refuse('malformed');
      if (token.length > maxBytes) return refuse('too_large');
      const parts = token.split('.');
      if (parts.length !== 3) return refuse('malformed');
      const header = json(parts[0]!); const claims = json(parts[1]!); const signature = fromBase64Url(parts[2]!);
      if (!header || !claims || !signature) return refuse('malformed');
      const alg = header['alg'];
      if (typeof alg !== 'string' || !algorithms.has(alg as JwtAlgorithm)) return refuse('algorithm');
      // Critical extensions this verifier does not know must not be ignored.
      if (header['crit'] !== undefined) return refuse('malformed');
      if (header['kid'] !== undefined && (typeof header['kid'] !== 'string' || header['kid'].length > 256)) return refuse('malformed');
      if (types && (typeof header['typ'] !== 'string' || !types.has(header['typ'].toLowerCase()))) return refuse('type');
      const family = families[alg as JwtAlgorithm];
      const key = await keys.key({ alg: alg as JwtAlgorithm, ...(typeof header['kid'] === 'string' ? { kid: header['kid'] } : {}) }, { signal: verifyOptions.signal ?? new AbortController().signal, claims });
      if (!key) return refuse('key');
      let valid = false;
      try { valid = await crypto.subtle.verify(family.verify, key, signature as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)); } catch { valid = false; }
      if (!valid) return refuse('signature');
      if (typeof claims['iss'] !== 'string' || !issuers.includes(claims['iss'])) return refuse('issuer');
      if (audiences !== false) {
        const aud = claims['aud'];
        const list = typeof aud === 'string' ? [aud] : Array.isArray(aud) && aud.every(item => typeof item === 'string') ? aud as string[] : [];
        if (!list.some(item => audiences.includes(item))) return refuse('audience');
      }
      const now = Date.now();
      if (!time(claims['exp']) || claims['exp'] * 1_000 + skew <= now) return refuse('expired');
      if (claims['nbf'] !== undefined && (!time(claims['nbf']) || claims['nbf'] * 1_000 - skew > now)) return refuse('not_yet_valid');
      if (claims['iat'] !== undefined && (!time(claims['iat']) || claims['iat'] * 1_000 - skew > now)) return refuse('not_yet_valid');
      if (options.maxLifetimeMs !== undefined && (!time(claims['iat']) || (claims['exp'] - claims['iat']) * 1_000 > options.maxLifetimeMs)) return refuse('lifetime');
      return { ok: true, header: Object.freeze(header) as JwtHeader, claims: Object.freeze(claims) as JwtClaims };
    },
  });
}
