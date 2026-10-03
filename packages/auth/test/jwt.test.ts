import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@mayura/core/host';
import { hmacSecret, jwtVerifier, peekIssuer, remoteJwks, staticKeys, type JwtAlgorithm } from '../src/index.js';
import { testIssuer } from '../src/testing.js';

const signAlgorithms: JwtAlgorithm[] = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const base = (issuer: Awaited<ReturnType<typeof testIssuer>>, extra: Partial<Parameters<typeof jwtVerifier>[0]> = {}) =>
  jwtVerifier({ issuer: issuer.issuer, audience: 'api', algorithms: [issuer.algorithm], keys: staticKeys(issuer.jwks), ...extra });
const parts = (token: string) => token.split('.') as [string, string, string];
const forge = (header: object, claims: object, signature = 'AAAA') => `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(claims))}.${signature}`;

describe('jwtVerifier', () => {
  it('refuses configuration that would accept too much', () => {
    const keys = staticKeys([]);
    for (const [options, pattern] of [
      [{ issuer: '', audience: 'a', algorithms: ['RS256'], keys }, /issuer/u],
      [{ issuer: 'i', audience: [], algorithms: ['RS256'], keys }, /audience/u],
      [{ issuer: 'i', audience: 'a', algorithms: [], keys }, /algorithms/u],
      [{ issuer: 'i', audience: 'a', algorithms: ['none'], keys }, /algorithms/u],
      [{ issuer: 'i', audience: 'a', algorithms: ['RS256'], keys: {} }, /keys/u],
      [{ issuer: 'i', audience: 'a', algorithms: ['RS256'], keys, clockSkewMs: 120_000 }, /clockSkewMs/u],
      [{ issuer: 'i', audience: 'a', algorithms: ['RS256'], keys, maxTokenBytes: 10 }, /maxTokenBytes/u],
      [{ issuer: 'i', audience: 'a', algorithms: ['RS256'], keys, maxLifetimeMs: 1 }, /maxLifetimeMs/u],
      [{ issuer: 'i', audience: 'a', algorithms: ['RS256'], keys, types: [1] }, /types/u],
    ] as const) expect(() => jwtVerifier(options as never), JSON.stringify(options)).toThrow(pattern);
    expect(() => hmacSecret('short')).toThrow(/32 bytes/u);
  });

  for (const algorithm of signAlgorithms) {
    it(`verifies ${algorithm} tokens signed by the issuer, and nothing tampered with`, async () => {
      const issuer = await testIssuer({ algorithm });
      const verifier = base(issuer);
      const token = await issuer.sign({ sub: 'user-1', aud: 'api' });
      expect(await verifier.verify(token)).toMatchObject({ ok: true, header: { alg: algorithm }, claims: { sub: 'user-1', iss: issuer.issuer } });
      const [header, , signature] = parts(token);
      const tampered = `${header}.${toBase64Url(JSON.stringify({ iss: issuer.issuer, sub: 'admin', aud: 'api', exp: Math.floor(Date.now() / 1_000) + 600 }))}.${signature}`;
      expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: 'signature' });
      // Another issuer's key, under the same key id, is not this issuer's.
      const other = await testIssuer({ algorithm, issuer: issuer.issuer });
      expect(await verifier.verify(await other.sign({ aud: 'api' }))).toEqual({ ok: false, reason: 'signature' });
    });
  }

  it('accepts only the algorithms listed, never none, and never a public key as an HMAC secret', async () => {
    const issuer = await testIssuer({ algorithm: 'RS256' });
    const claims = { iss: issuer.issuer, aud: 'api', exp: Math.floor(Date.now() / 1_000) + 600 };
    expect(await base(issuer).verify(forge({ alg: 'none' }, claims, 'AA'))).toEqual({ ok: false, reason: 'algorithm' });
    expect(await base(issuer, { algorithms: ['RS256', 'HS256'] }).verify(forge({ alg: 'HS256', kid: 'test-key-1' }, claims))).toEqual({ ok: false, reason: 'key' });
    expect(await base(issuer, { algorithms: ['ES256'] }).verify(await issuer.sign({ aud: 'api' }))).toEqual({ ok: false, reason: 'algorithm' });
    // The issuer's RSA public key used as an HMAC secret (the classic confusion) finds no key to check it with.
    const secretFromPublicKey = JSON.stringify(issuer.jwks.keys[0]);
    const input = `${toBase64Url(JSON.stringify({ alg: 'HS256', kid: 'test-key-1' }))}.${toBase64Url(JSON.stringify(claims))}`;
    const mac = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(secretFromPublicKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(input));
    expect(await base(issuer, { algorithms: ['RS256', 'HS256'] }).verify(`${input}.${toBase64Url(new Uint8Array(mac))}`)).toEqual({ ok: false, reason: 'key' });
  });

  it('never takes a key for one family from a source for another: no HMAC secret from a JWKS, no RSA key from a secret', async () => {
    const issuer = await testIssuer({ algorithm: 'RS256' });
    const claims = { iss: issuer.issuer, aud: 'api', exp: Math.floor(Date.now() / 1_000) + 600 };
    // A JWKS that lists a symmetric key: an HS256 token signed with it is still refused.
    const secret = 'a-shared-secret-of-at-least-32-bytes!!';
    const input = `${toBase64Url(JSON.stringify({ alg: 'HS256', kid: 'oct-1' }))}.${toBase64Url(JSON.stringify(claims))}`;
    const mac = toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(input))));
    const withOct = staticKeys([...issuer.jwks.keys, { kty: 'oct', kid: 'oct-1', k: toBase64Url(secret) } as never]);
    expect(await base(issuer, { algorithms: ['RS256', 'HS256'], keys: withOct }).verify(`${input}.${mac}`)).toEqual({ ok: false, reason: 'key' });
    // An HMAC secret is no key for an RS256 token: refused, not an error.
    expect(await base(issuer, { algorithms: ['RS256', 'HS256'], keys: hmacSecret(secret) }).verify(await issuer.sign({ aud: 'api' }))).toEqual({ ok: false, reason: 'key' });
  });

  it('verifies HS256 only with a configured secret', async () => {
    const secret = 'a-shared-secret-of-at-least-32-bytes!!';
    const verifier = jwtVerifier({ issuer: 'https://hs.test', audience: 'api', algorithms: ['HS256'], keys: hmacSecret(secret) });
    const input = `${toBase64Url(JSON.stringify({ alg: 'HS256' }))}.${toBase64Url(JSON.stringify({ iss: 'https://hs.test', aud: 'api', exp: Math.floor(Date.now() / 1_000) + 60 }))}`;
    const sign = async (key: string) => toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(input))));
    expect(await verifier.verify(`${input}.${await sign(secret)}`)).toMatchObject({ ok: true });
    expect(await verifier.verify(`${input}.${await sign(`${secret}x`)}`)).toEqual({ ok: false, reason: 'signature' });
  });

  it('checks issuer, audience, expiry, not-before, issued-at, lifetime and type', async () => {
    const issuer = await testIssuer();
    const now = Math.floor(Date.now() / 1_000);
    const verifier = base(issuer);
    const check = async (claims: Record<string, unknown>, extra: Partial<Parameters<typeof jwtVerifier>[0]> = {}, header: Record<string, unknown> = {}) =>
      (extra === undefined ? verifier : base(issuer, extra)).verify(await issuer.sign(claims, { header }));
    expect(await check({ aud: 'api', iss: 'https://other.test' })).toEqual({ ok: false, reason: 'issuer' });
    expect(await check({ aud: 'other' })).toEqual({ ok: false, reason: 'audience' });
    expect(await check({})).toEqual({ ok: false, reason: 'audience' });
    expect(await check({ aud: ['other', 'api'] })).toMatchObject({ ok: true });
    expect(await check({ aud: 'anything' }, { audience: false })).toMatchObject({ ok: true });
    expect(await check({ aud: 'api', exp: now - 10 })).toEqual({ ok: false, reason: 'expired' });
    expect(await check({ aud: 'api', exp: now - 2 })).toMatchObject({ ok: true });
    expect(await check({ aud: 'api', exp: now - 2 }, { clockSkewMs: 0 })).toEqual({ ok: false, reason: 'expired' });
    expect(await check({ aud: 'api', exp: undefined })).toEqual({ ok: false, reason: 'expired' });
    expect(await check({ aud: 'api', exp: '9999999999' })).toEqual({ ok: false, reason: 'expired' });
    expect(await check({ aud: 'api', nbf: now + 60 })).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(await check({ aud: 'api', iat: now + 60 })).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(await check({ aud: 'api' }, { maxLifetimeMs: 60_000 })).toEqual({ ok: false, reason: 'lifetime' });
    expect(await check({ aud: 'api', iat: undefined }, { maxLifetimeMs: 7_200_000 })).toEqual({ ok: false, reason: 'lifetime' });
    expect(await check({ aud: 'api' }, { maxLifetimeMs: 7_200_000 })).toMatchObject({ ok: true });
    expect(await check({ aud: 'api' }, { types: ['at+jwt'] })).toEqual({ ok: false, reason: 'type' });
    expect(await check({ aud: 'api' }, { types: ['at+jwt'] }, { typ: 'AT+JWT' })).toMatchObject({ ok: true });
  });

  it('refuses tokens that are not well formed, too large, or name keys it does not know', async () => {
    const issuer = await testIssuer();
    const verifier = base(issuer);
    const token = await issuer.sign({ aud: 'api' });
    const [header, claims, signature] = parts(token);
    for (const bad of ['', 'a.b', `${header}.${claims}`, `${header}.${claims}.${signature}.x`, `${header}..${signature}`, `${header}.${claims}.!!`, `e30.${claims}.${signature}`, `${toBase64Url('[1]')}.${claims}.${signature}`, 42]) {
      expect(await verifier.verify(bad as string), String(bad)).toEqual({ ok: false, reason: expect.stringMatching(/malformed|algorithm/u) });
    }
    expect(await base(issuer, { maxTokenBytes: 256 }).verify(`${token}${'A'.repeat(300)}`)).toEqual({ ok: false, reason: 'too_large' });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }, { header: { kid: 'unknown' } }))).toEqual({ ok: false, reason: 'key' });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }, { header: { crit: ['b64'] } }))).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }, { header: { kid: 7 } }))).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifier.verify(`${header}.${claims}.${toBase64Url(new Uint8Array(70))}`)).toEqual({ ok: false, reason: 'signature' });
  });

  it('chooses a key without a key id only when exactly one fits', async () => {
    const issuer = await testIssuer();
    const token = await issuer.sign({ aud: 'api' }, { header: { kid: undefined } });
    expect(await base(issuer).verify(token)).toMatchObject({ ok: true });
    await issuer.rotate();
    expect(await base(issuer).verify(token)).toEqual({ ok: false, reason: 'key' });
  });

  it('refuses keys unfit for the algorithm: weak RSA, wrong curve, encryption keys, other algorithms', async () => {
    const issuer = await testIssuer({ algorithm: 'RS256' });
    const key = issuer.jwks.keys[0]!;
    const token = await issuer.sign({ aud: 'api' });
    const withKey = (changed: object) => base(issuer, { keys: staticKeys([{ ...key, ...changed }]) }).verify(token);
    expect(await withKey({})).toMatchObject({ ok: true });
    expect(await withKey({ n: toBase64Url(new Uint8Array(128).fill(7)) })).toEqual({ ok: false, reason: 'key' });
    expect(await withKey({ use: 'enc' })).toEqual({ ok: false, reason: 'key' });
    expect(await withKey({ alg: 'RS512' })).toEqual({ ok: false, reason: 'key' });
    expect(await withKey({ key_ops: ['encrypt'] })).toEqual({ ok: false, reason: 'key' });
    expect(await withKey({ kty: 'EC' })).toEqual({ ok: false, reason: 'key' });
    const ec = await testIssuer({ algorithm: 'ES256' });
    const ecToken = await ec.sign({ aud: 'api' });
    expect(await base(ec, { keys: staticKeys([{ ...ec.jwks.keys[0]!, crv: 'P-384' }]) }).verify(ecToken)).toEqual({ ok: false, reason: 'key' });
    expect(() => staticKeys([{ nope: true } as never])).toThrow(/kty/u);
  });

  it('test issuers may be named without a URL, with their keys on a stand-in host', async () => {
    const bare = await testIssuer({ issuer: 'accounts.example.com' });
    expect(bare.jwksUrl).toBe('https://issuer.test/.well-known/jwks.json');
    expect(await jwtVerifier({ issuer: 'accounts.example.com', audience: 'api', algorithms: ['ES256'], keys: staticKeys(bare.jwks) }).verify(await bare.sign({ aud: 'api' }))).toMatchObject({ ok: true });
  });

  it("narrows the keys a token may use by its claims, so a key bound to one issuer verifies only that issuer's tokens", async () => {
    const tenantA = await testIssuer({ issuer: 'https://login.example/a' });
    const tenantB = await testIssuer({ issuer: 'https://login.example/b' });
    await tenantB.rotate();
    // One key set, as a multi-tenant provider publishes it: each key says which issuer it is for.
    const keys = [{ ...tenantA.jwks.keys[0]!, kid: 'a', issuer: 'https://login.example/a' }, { ...tenantB.jwks.keys[1]!, kid: 'b', issuer: 'https://login.example/b' }];
    const bound = staticKeys(keys, { keyFilter: (key, claims) => key['issuer'] === claims['iss'] });
    const verifier = jwtVerifier({ issuer: ['https://login.example/a', 'https://login.example/b'], audience: 'api', algorithms: ['ES256'], keys: bound });
    expect(await verifier.verify(await tenantA.sign({ aud: 'api' }, { header: { kid: 'a' } }))).toMatchObject({ ok: true });
    expect(await verifier.verify(await tenantB.sign({ aud: 'api' }, { header: { kid: 'b' } }))).toMatchObject({ ok: true });
    // Tenant B's key never verifies a token claiming to be tenant A's, even one B signed itself.
    expect(await verifier.verify(await tenantB.sign({ aud: 'api', iss: 'https://login.example/a' }, { header: { kid: 'b' } }))).toEqual({ ok: false, reason: 'key' });
    // A filter given no claims passes no key.
    expect(await bound.key({ alg: 'ES256', kid: 'a' }, { signal: new AbortController().signal })).toBeUndefined();
    expect(await staticKeys(keys, { keyFilter: () => true }).key({ alg: 'ES256', kid: 'a' }, { signal: new AbortController().signal })).toBeUndefined();
    const remote = remoteJwks({ url: tenantA.jwksUrl, fetch: tenantA.fetch, keyFilter: () => false });
    expect(await jwtVerifier({ issuer: tenantA.issuer, audience: 'api', algorithms: ['ES256'], keys: remote }).verify(await tenantA.sign({ aud: 'api' }))).toEqual({ ok: false, reason: 'key' });
    expect(() => staticKeys([], { keyFilter: 'x' as never })).toThrow(/keyFilter/u);
    expect(() => remoteJwks({ url: tenantA.jwksUrl, keyFilter: 7 as never })).toThrow(/keyFilter/u);
  });

  it('peeks at the issuer only to route a token, without trusting it', async () => {
    const issuer = await testIssuer();
    expect(peekIssuer(await issuer.sign({}))).toBe(issuer.issuer);
    expect(peekIssuer('not.a.jwt')).toBeUndefined();
    expect(peekIssuer('mk_live_abc')).toBeUndefined();
    // Not worth decoding: far larger than any token.
    expect(peekIssuer(await issuer.sign({ pad: 'x'.repeat(70_000) }))).toBeUndefined();
  });
});
