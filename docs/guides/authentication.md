---
title: "Authentication and API keys"
description: "Who may call Mayura's server: tokens from identity providers verified with their published keys, and API keys issued and checked on your own storage, each mapped explicitly to what the caller may do."
---

Mayura's server asks your `authenticate` callback who each request's bearer token belongs to and what it may do (see
[Server and client](server-and-client.md)). `mayura/auth` and `mayura/keys` give you that callback for the common
kinds of caller:

- people and services signed in with an identity provider, whose tokens are JWTs (`mayura/auth`);
- users who sign in to your own application with better-auth (`mayura/auth/better-auth`);
- programs holding an API key you issued (`mayura/keys`), kept in any Mayura store.

They run on every runtime Mayura supports, with no dependency. None grants anything by default: a valid token
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
2048 bits, keys for encryption, keys for another algorithm, and symmetric keys in a JWKS are all refused. `keyFilter` (on `remoteJwks` and `staticKeys`) narrows the keys a token
may use by its claims, for example to keys bound to its issuer; it can only refuse keys.

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

## Identity provider packages

Each `@mayurajs/auth-*` package is a `jwtAuthenticator` already set up for one provider: its issuer, keys and
algorithms, the checks it advises, and its claims read into a session object your `identity` mapping receives. None
uses the provider's SDK, and none grants anything your mapping does not.

| Package | Provider | What `identity` receives |
| --- | --- | --- |
| `@mayurajs/auth-clerk` | [Clerk](https://clerk.com/docs) session tokens: RS256 from your Frontend API, `azp` checked against your origins, `pending` sessions refused; PEM key for no network | user, session, active organization, role and permissions (decoded from version 2 feature bitmasks), impersonator |
| `@mayurajs/auth-auth0` | [Auth0](https://auth0.com/docs) access tokens: RS256 from your tenant for your API (or HS256 with its signing secret) | subject, application, user or machine, scopes, permissions, organization |
| `@mayurajs/auth-neon` | [Neon Auth](https://neon.com/docs/auth/overview) (managed better-auth) JWTs: EdDSA, issuer and audience your auth URL's origin; banned users refused | user, email and whether verified, name, role |
| `@mayurajs/auth-supabase` | [Supabase Auth](https://supabase.com/docs/guides/auth/jwts) access tokens: ES256 or RS256 from your project (legacy HS256 only with its secret); only the `authenticated` role, no anonymous users unless allowed, `aal2` if required | user, email, phone, role, assurance level, session, app and user metadata |
| `@mayurajs/auth-firebase` | [Firebase Authentication](https://firebase.google.com/docs/auth/admin/verify-id-tokens) ID tokens, checked as Firebase specifies with Google's keys; anonymous users and unlisted tenants refused | uid, email and whether verified, phone, name, sign-in provider, tenant, sign-in time, custom claims |
| `@mayurajs/auth-workos` | [WorkOS](https://workos.com/docs/authkit/sessions) AuthKit session tokens, and with `connect` Connect access tokens from your AuthKit domain; machine tokens only with `allowMachines` | kind, user or machine, session, application, organization, role and roles, permissions, scopes |
| `@mayurajs/auth-google` | [Google](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) ID tokens for your client IDs, optionally one Workspace domain; and `googleSignIn` for better-auth's Google login | account id, email and whether verified, Workspace domain, name, picture |
| `@mayurajs/auth-entra` | [Microsoft Entra ID](https://learn.microsoft.com/entra/identity-platform/access-tokens) access tokens for your API from the tenants you list (or any), with Microsoft's keys, tenant-bound keys kept to their tenant; app-only tokens only with `allowApps`, v1.0 tokens only when asked | object id, tenant, application, user or app, roles, scopes, name, username |
| `@mayurajs/auth-okta` | [Okta](https://developer.okta.com/docs/guides/validate-access-tokens/) access tokens from a custom authorization server for its audience (never the org authorization server's); machine tokens only with `allowMachines`, DPoP-bound tokens refused | login, user id, client, user or machine, scopes, groups |
| `@mayurajs/auth-cognito` | [Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html) user pool access tokens for your app clients (ID tokens instead with `tokenUse: 'id'`, never both); machine tokens only with `allowMachines` | user id, user name, client, user or machine, groups, scopes, email (ID tokens) |
| `@mayurajs/auth-facebook` | [Facebook Login](https://developers.facebook.com/docs/graph-api/reference/debug_token/) access tokens, checked with Facebook per request (opaque; `cacheTtlMs` to keep answers), and iOS Limited Login tokens with Facebook's keys; and `facebookSignIn` for better-auth | kind, app-scoped user id, granted permissions, email and name (Limited Login), expiry |

## Sign-in with better-auth

To have users sign in to your own application, with their accounts in your own database, use
[better-auth](https://www.better-auth.com) (1.7). `mayura/auth/better-auth` connects your better-auth instance to
Mayura's server. It imports nothing from better-auth, so your instance, database and plugins are what run, on any
runtime better-auth runs on.

```ts
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { bearer, jwt, organization } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { createAgentServer } from 'mayura/server';
import { chainAuthenticators, mapCapabilities } from 'mayura/auth';
import { betterAuthApiKeyAuthenticator, betterAuthAuthenticator, betterAuthPermissions, withBetterAuth } from 'mayura/auth/better-auth';

const auth = betterAuth({
  database: new DatabaseSync('auth.sqlite'), // or a pg Pool, a mysql2 pool, mongodbAdapter(db), ...
  emailAndPassword: { enabled: true },
  plugins: [bearer(), jwt(), organization(), apiKey({ defaultPrefix: 'acme_' })],
});

const authenticate = chainAuthenticators(
  betterAuthAuthenticator(auth, {
    identity: ({ user, session }) => session.activeOrganizationId ? {
      principalId: `user/${user.id}`,
      projectId: session.activeOrganizationId,
      agentIds: ['support'],
      capabilities: ['runs:submit', 'runs:read'],
    } : null,
  }),
  betterAuthApiKeyAuthenticator(auth, {
    prefix: 'acme_',
    identity: key => ({
      principalId: `user/${key.referenceId}`,
      projectId: 'acme',
      agentIds: ['support'],
      capabilities: mapCapabilities(betterAuthPermissions(key.permissions), { 'runs:submit': ['runs:submit'], 'runs:read': ['runs:read'] }),
    }),
  }),
);

declare const options: Omit<Parameters<typeof createAgentServer>[0], 'authenticate'>;
const server = createAgentServer({ ...options, authenticate });
export const fetchHandler = withBetterAuth(auth, request => server.fetch(request));
```

- **Sessions.** `betterAuthAuthenticator` takes better-auth session tokens as bearer tokens (its `bearer` plugin gives
  clients one in the `set-auth-token` header). Each request asks better-auth for the session, so signing out or
  revoking a session stops it at once, and an identity lasts no longer than the session. `identity` decides what the
  user may do, for example from their role in the active organization.
- **API keys.** `betterAuthApiKeyAuthenticator` checks keys from better-auth's apiKey plugin, which applies each key's
  rate limit, remaining uses and expiry. Give the plugin a `defaultPrefix`, and the same `prefix` here, so only those
  tokens are checked. `betterAuthPermissions` turns better-auth's `{ runs: ['read'] }` into `runs:read` for
  `mapCapabilities`. Mayura's own keys (`mayura/keys`, below) do the same on any Mayura store without better-auth.
- **JWTs.** `betterAuthJwtVerifier({ baseURL })` checks tokens from better-auth's `jwt` plugin against its JWKS, with no
  call to better-auth per request; give it to `jwtAuthenticator`.
- **One handler.** `withBetterAuth(auth, next)` sends requests under `/api/auth` (better-auth's own path) to
  better-auth: sign-up, sign-in, sessions, organizations, keys and JWKS. Everything else goes to `next`, such as
  Mayura's server.
- What better-auth returns is checked when it arrives: a session or key in a shape Mayura does not know is refused, and
  an error from better-auth (such as its database being down) makes the server answer that authentication is
  unavailable.
- With pnpm, if better-auth's types refuse its own apiKey plugin, two copies of `@better-auth/core` were installed:
  `@better-auth/api-key` 1.7.7 asks for `@better-auth/utils` 0.4.2, which better-auth uses, while pnpm may install a
  newer one for it. Adding `@better-auth/utils@0.4.2` to your dependencies leaves one copy.

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

Keys issued by a key service are checked with these packages, each a `KeyVerifier` for `keyAuthenticator`. Each sends
only tokens with your keys' prefix to the service, never caches its answers (so a key revoked there is refused at
once), spends the request's cost there, and grants only what your `identity` callback returns from what the service
knows about the key. When the service cannot answer, the server answers that authentication is unavailable.

| Package | Service | What `identity` receives |
| --- | --- | --- |
| `@mayurajs/km-unkey` | [Unkey](https://www.unkey.com/docs/api-management/keys/verifying-keys) `keys.verifyKey`, limited to your keyspaces, with an optional permission query checked before rate limits and credits; self-hosted Unkey too | key id, keyspace, name, metadata, permissions, roles, linked identity, expiry, credits left |

`mayura/keys/testing` has `keyManagerConformance`, the manager's behaviour that depends on its store, which Mayura runs
over every store it ships; run it over a store of your own the same way.
