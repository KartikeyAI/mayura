import { MayuraError } from '@mayura/core';
import { toBase64Url } from '@mayura/core/host';
import { families, type Jwk, type JwtAlgorithm } from './keys.js';

export interface TestIssuer {
  readonly issuer: string;
  readonly algorithm: JwtAlgorithm;
  /** The public keys, as the issuer would publish them. */
  readonly jwks: { readonly keys: readonly Jwk[] };
  /** Where the fetch below serves `jwks`. */
  readonly jwksUrl: string;
  /** A fetch serving `jwks` at `jwksUrl` (and nothing else), counting requests: give it to `remoteJwks`. */
  readonly fetch: typeof fetch & { readonly requests: number };
  /** A token with these claims, signed by the issuer: `iss`, `iat` and `exp` (in an hour) unless given. */
  sign(claims: Record<string, unknown>, options?: { readonly header?: Record<string, unknown>; readonly expiresInMs?: number }): Promise<string>;
  /** A new signing key, published alongside the old one under a new key id, as an issuer rotates. */
  rotate(): Promise<void>;
}

const generators: Readonly<Record<string, RsaHashedKeyGenParams | EcKeyGenParams | Algorithm>> = {
  RSA: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
};

async function keyPair(alg: JwtAlgorithm): Promise<CryptoKeyPair> {
  const family = families[alg];
  if (family.kty === 'oct') throw new MayuraError('INVALID_CONFIG', 'testIssuer() signs with a key pair: use an RS, PS, ES or EdDSA algorithm.');
  const params = family.kty === 'RSA' ? { ...generators['RSA'], ...(family.import as RsaHashedImportParams) } as RsaHashedKeyGenParams
    : family.kty === 'EC' ? family.import as EcKeyGenParams : family.import as Algorithm;
  return crypto.subtle.generateKey(params, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

/**
 * An identity provider for tests: it signs tokens with keys it makes, and serves its JWKS through `fetch`, so verifiers
 * run against real signatures with no network. Never use it outside tests.
 */
export async function testIssuer(options: { readonly issuer?: string; readonly algorithm?: JwtAlgorithm; readonly jwksPath?: string } = {}): Promise<TestIssuer> {
  const issuer = options.issuer ?? 'https://issuer.test';
  const algorithm = options.algorithm ?? 'ES256';
  const jwksUrl = new URL(options.jwksPath ?? '/.well-known/jwks.json', issuer.endsWith('/') ? issuer : `${issuer}/`).href;
  const keys: Jwk[] = []; let signing: { readonly kid: string; readonly key: CryptoKey } | undefined; let count = 0;
  const rotate = async () => {
    const pair = await keyPair(algorithm);
    const kid = `test-key-${++count}`;
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey) as Record<string, unknown>;
    const { key_ops: _ops, ext: _ext, ...publicJwk } = exported;
    keys.push(Object.freeze({ ...publicJwk, kid, alg: algorithm, use: 'sig' }) as unknown as Jwk);
    signing = { kid, key: pair.privateKey };
  };
  await rotate();
  let requests = 0;
  const served = (async (input: RequestInfo | URL) => {
    requests++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== jwksUrl) return new Response('not found', { status: 404 });
    return Response.json({ keys }, { headers: { 'cache-control': 'public, max-age=300' } });
  }) as typeof fetch;
  const fetchCounting = Object.defineProperty(served, 'requests', { get: () => requests }) as typeof fetch & { readonly requests: number };
  return {
    issuer, algorithm, jwksUrl, fetch: fetchCounting,
    get jwks() { return { keys: [...keys] }; },
    rotate,
    sign: async (claims, signOptions = {}) => {
      const now = Math.floor(Date.now() / 1_000);
      const header = { alg: algorithm, typ: 'JWT', kid: signing!.kid, ...signOptions.header };
      const payload = { iss: issuer, iat: now, exp: now + Math.floor((signOptions.expiresInMs ?? 3_600_000) / 1_000), ...claims };
      const input = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
      const family = families[algorithm];
      const signature = new Uint8Array(await crypto.subtle.sign(family.verify, signing!.key, new TextEncoder().encode(input)));
      return `${input}.${toBase64Url(signature)}`;
    },
  };
}
