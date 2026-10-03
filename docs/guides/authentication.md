---
title: "Authentication and API keys"
description: "Who may call Mayura's server: tokens from identity providers verified with their published keys, and API keys issued and checked on your own storage, each mapped explicitly to what the caller may do."
---

Mayura's server asks your `authenticate` callback who each request's bearer token belongs to and what it may do (see
[Server and client](server-and-client.md)). `mayura/auth` and `mayura/keys` give you that callback for the two common
kinds of caller:

- people and services signed in with an identity provider, whose tokens are JWTs (`mayura/auth`), and
- programs holding an API key you issued (`mayura/keys`), kept in any Mayura store.

Both run on every runtime Mayura supports, with no dependency. Neither grants anything by default: a valid token
proves who someone is, and your mapping decides what they may do here.

```ts
import { chainAuthenticators, jwtAuthenticator, jwtVerifier, mapCapabilities, principalId, remoteJwks } from 'mayura/auth';
import { createKeyManager, keyAuthenticator } from 'mayura/keys';
import type { AggregateStore } from 'mayura/storage-contracts';

declare const store: AggregateStore; // any Mayura store, initialized

const people = jwtAuthenticator({
  verifier: jwtVerifier({
    issuer: 'https://auth.example.com',
    audience: 'https://agents.example.com',
    algorithms: ['RS256'],
    keys: remoteJwks({ url: 'https://auth.example.com/.well-known/jwks.json' }),
  }),
  identity: claims => typeof claims.sub === 'string' ? {
    principalId: principalId('example', claims.sub),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: mapCapabilities(claims['permissions'], { 'agents:use': ['runs:submit', 'runs:read'] }),
  } : null,
});

const keys = createKeyManager({ store, prefix: 'acme' });
export const authenticate = chainAuthenticators(people, keyAuthenticator(keys));
// createAgentServer({ ..., authenticate })
```

## Tokens from an identity provider

`jwtVerifier` checks a JWT with WebCrypto alone: RS, PS and ES 256/384/512 and EdDSA (Ed25519), and HS 256/384/512
only with `hmacSecret`.

| Option | Notes |
| --- | --- |
| `issuer` | The `iss` tokens must name, or a list. Compared exactly. |
| `audience` | The `aud` a token must include one of. `false` only for issuers whose tokens carry none; check what stands for it in your mapping. |
| `algorithms` | The algorithms the issuer signs with. Nothing else is accepted, and never `none`. |
| `keys` | `remoteJwks({ url })`, `staticKeys(jwks)` or `hmacSecret(secret)`. |
| `types` | Token types accepted (`typ`), such as `['at+jwt']`. Any by default. |
| `clockSkewMs` | Allowed clock difference for `exp`, `nbf` and `iat`. 5 s by default, at most 60 s. |
| `maxLifetimeMs` | Refuse tokens meant to last longer (`exp` - `iat`). |
| `maxTokenBytes` | 16 KiB by default. |

A token passes only when its signature is the issuer's, its algorithm is listed, its `iss`, `aud` and times hold, and it
has an `exp`. `verify` answers `{ ok: true, header, claims }` or `{ ok: false, reason }`, where `reason` is one of
`malformed`, `too_large`, `algorithm`, `type`, `key`, `signature`, `issuer`, `audience`, `expired`, `not_yet_valid` and
`lifetime`. It throws only when keys cannot be reached, and the server then answers that authentication is unavailable,
never that the caller is someone.

`remoteJwks` fetches the issuer's keys and keeps them for the response's `Cache-Control: max-age`, capped by `maxAgeMs`
(10 minutes by default). A token signed by a key it has not seen refetches them, at most every `minRefreshMs` (30 s), so
rotated keys are found and made-up key ids cannot make it fetch on every request. One fetch serves every request
waiting for it, bounded by `timeoutMs` (5 s) and `maxBytes` (256 KiB). While the JWKS cannot be reached, keys past
their age stay in use for one more `maxAgeMs`, then verification fails. Redirects are not followed, and only https
URLs are accepted (http only on this machine). A key is never taken for an algorithm it does not fit: RSA keys under
2048 bits, keys for encryption, keys for another algorithm, and symmetric keys in a JWKS are all refused.

`jwtAuthenticator({ verifier, identity })` is the server callback. It only looks at tokens naming its issuer (so it
never fetches keys for anyone else's tokens), and turns what `identity` returns into the server's identity:

- `principalId` and `projectId` must be ids the server accepts. `principalId(namespace, subject)` makes one from any
  subject: `example/user_123`, or for a subject with other characters (such as Auth0's `auth0|123`) a stable SHA-256
  form, `example/_<base64url>`.
- `capabilities` are the server's permissions. `mapCapabilities(values, table)` maps a provider's permissions or roles
  through a table you write; anything not in it grants nothing.
- The identity lasts no longer than the token, and no longer than `maxIdentityMs` (60 s by default), after which the
  token is checked again.
- A mapping that returns something the server cannot use is a configuration error, never a caller let in.

`chainAuthenticators(...)` combines several: each token goes to the first that accepts it (by its issuer or key
prefix), and a token none accepts is refused. `serverIdentity(grant, { credentialExpiresAtMs })` checks and bounds an
identity for authenticators of your own.

### Testing

`mayura/auth/testing` has `testIssuer({ issuer, algorithm })`: it makes keys, signs tokens with `sign(claims)`, serves
its JWKS through `fetch` (give it to `remoteJwks`), and can `rotate()`. Use it to test your mapping with real signatures
and no network.

## API keys

`createKeyManager({ store, prefix })` issues and checks API keys in any Mayura store: Postgres, SQLite, libSQL, MySQL,
MongoDB, D1 or DynamoDB, or `memoryAggregateStore()` from `mayura/keys/testing` while trying it out.

```ts
import { createKeyManager } from 'mayura/keys';
import type { AggregateStore } from 'mayura/storage-contracts';

declare const store: AggregateStore;
const keys = createKeyManager({ store, prefix: 'acme' });

const { key, record } = await keys.create({
  projectId: 'acme',
  ownerId: 'service/billing',
  agentIds: ['invoices'],
  capabilities: ['runs:submit', 'runs:read'],
  name: 'billing worker',
  expiresInMs: 90 * 24 * 60 * 60_000,
  rateLimit: { limit: 60, windowMs: 60_000 },
  credits: { remaining: 10_000, refill: { amount: 10_000, intervalMs: 30 * 24 * 60 * 60_000 } },
});
console.log(key);            // shown once: acme_<43 random characters><6-character checksum>
console.log(record.display); // acme_4f…9Xk2

await keys.revoke(record.keyId);
```

- **The secret is shown once.** A key is `<prefix>_<random><checksum>`, 256 random bits by default, with a CRC-32
  checksum as GitHub's tokens have, so mistyped and made-up keys are refused before any storage read. Only the key's
  SHA-256 is stored, as base64 (the form Unkey also accepts, should you move keys there). Records hold an id
  (`key_...`) and a display form, never the secret.
- **Each key carries its grant:** the project, the owner (its principal), agents and capabilities. With
  `create(input, { grantor: identity })`, a key holds no more than whoever makes it.
- **Limits.** `expiresInMs` (and the manager's `maxExpiresInMs`), a fixed-window `rateLimit`, and `credits` spent per
  verification (`cost`, 1 by default) that `refill` sets back to its amount each interval. Credits are spent only after
  every other check passes, exactly, even when requests race; a rate-limited request spends none.
- **Lifecycle.** `update`, `disable` and `enable`, `revoke` (for good), and `rotate(keyId, { overlapMs })`: a new key
  with the same grant and credits, while the old one keeps working for the overlap (up to `maxRotationOverlapMs`, 7
  days), or stops at once. `get`, `list({ projectId, ownerId })` and `audit(keyId)` (every change, never the secret).
  An owner holds at most `maxKeysPerOwner` keys (100) that still work.
- **Revocation is immediate.** Each verification reads storage. `cacheTtlMs` (up to 60 s) keeps keys read for that long
  instead, and a revoked key then works for that long more in each process.
- **Where a store's writes conflict, the manager retries a few times, then fails** rather than guess. When a key was
  last used is written at most once per `lastUsedIntervalMs` (5 minutes) per process, and never fails a request.
- `namespace` keeps several key sets apart in one store, such as `live` and `test`.

`keyAuthenticator(keys, { cost, maxIdentityMs })` is the server callback: it accepts tokens with the manager's prefix,
spends `cost` credits, and makes the key's grant the identity, for no longer than the key or `maxIdentityMs`. It works
with any `KeyVerifier`, such as a key service's.

`mayura/keys/testing` has `keyManagerConformance`, the manager's behaviour that depends on its store, which Mayura runs
over every store it ships; run it over a store of your own the same way.
