---
title: "Clerk session tokens"
description: "Let Clerk-signed-in users call Mayura's server with @mayurajs/auth-clerk: token checks, organizations and permissions, options and errors."
package: "@mayurajs/auth-clerk"
vendor: "Clerk"
logo: "clerk"
website: "https://clerk.com"
area: "auth"
---

[Clerk](https://clerk.com) signs users in to your application and gives each session a short-lived JWT.
`@mayurajs/auth-clerk` turns those session tokens into identities for Mayura's server: it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for your Clerk
instance, and your `identity` mapping decides what each user may do. It verifies tokens with `mayura/auth`'s own JWT
verifier (WebCrypto only): no Clerk SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-clerk
```

## Credentials

Nothing secret is needed. Copy your instance's **publishable key** (`pk_live_...` or `pk_test_...`) from the
**API keys** page of the [Clerk dashboard](https://dashboard.clerk.com); your Frontend API URL, which issues the tokens
and publishes their keys, is read from it. To verify with no network at all, also copy the **JWKS public key** (PEM)
from the same page and pass it as `jwtKey`.

The package reads nothing from the environment: pass the values in yourself, for example from `CLERK_PUBLISHABLE_KEY`
and `CLERK_AUTHORIZED_PARTY`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { clerkAuthenticator } from '@mayurajs/auth-clerk';

export const authenticate = clerkAuthenticator({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
  authorizedParties: ['https://app.example.com'], // the origins your users sign in from
  identity: session => session.orgId ? {
    principalId: principalId('clerk', session.userId),
    projectId: session.orgId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.orgPermissions, {
      'org:agents:use': ['runs:submit', 'runs:read'],
      'org:agents:operate': ['workflows:read', 'workflows:control'],
    }),
  } : null,
});
// createAgentServer({ ..., authenticate })
```

Your frontend sends the session token as the bearer token, for example `await window.Clerk.session.getToken()`. A user
outside an organization gets nothing here, and a permission missing from the table grants nothing. See
[Authentication and API keys](../guides/authentication.md) for chaining this with API keys and other providers.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `publishableKey` | one of these two | Your publishable key. The Frontend API URL is decoded from it. |
| `frontendApi` | read from `publishableKey` | Your Frontend API as an https origin, such as `https://clerk.example.com`. If you give both, they must name the same instance. |
| `authorizedParties` | required | The origins (`https://app.example.com`, or `http://localhost:3000`) a token's `azp` must be one of. `false` turns the check off; use it only where no browser is involved. |
| `identity` | required | What a signed-in user may do, or `null` to refuse. |
| `jwtKey` | none: keys are fetched | Your instance's PEM public key (RSA, `-----BEGIN PUBLIC KEY-----`), to verify with no network. |
| `allowPending` | `false` | Accept sessions Clerk marks `pending` (tasks such as choosing an organization not done yet). |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`, as Clerk's SDK allows. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **Signature and issuer.** RS256 only, issued by your Frontend API, signed by a key from
  `<frontendApi>/.well-known/jwks.json` (or by `jwtKey`). Keys of any other kind in the set are never used.
- **Times.** The token must carry `exp` and be unexpired, with `clockSkewMs` of leeway.
- **Authorized party.** Clerk tokens carry no audience. The origin a token was made for (`azp`) stands in for it, as
  Clerk advises against CSRF: a token without `azp`, or for another origin, is refused.
- **Session.** A token needs `sub` and `sid`. Sessions with status `pending` are refused unless `allowPending`.

Fetched keys are kept for the JWKS response's `max-age`, at most 10 minutes; a token with an unknown key id refetches
them at most every 30 s. See
[Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider) for the cache,
timeouts and size limits.

## What `identity` receives

| Field | From |
| --- | --- |
| `userId` | `sub` |
| `sessionId` | `sid` |
| `status` | `sts`, such as `active` or `pending`; `null` if absent. |
| `orgId`, `orgSlug` | The active organization, or `null`. |
| `orgRole` | The user's role there, as Clerk names roles: `org:admin`. |
| `orgPermissions` | The user's permissions there, such as `org:invoices:read`. |
| `actor` | The `act` claim when someone is impersonating the user, else `null`. |
| `claims` | The verified claims. |

Version 2 tokens carry permissions as feature bitmasks (`fea`, `o.per`, `o.fpm`); the package decodes them as Clerk's
SDK does, reading only organization features, and a malformed feature list grants nothing. Version 1 tokens
(`org_id`, `org_role`, `org_permissions`) are read too. `clerkPermissions(claims)`, `clerkSession(claims)` and
`clerkFrontendApi(publishableKey)` are exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: no `publishableKey` or `frontendApi`, a malformed key, an http or non-origin `frontendApi`, the two naming different instances, empty or malformed `authorizedParties`, a `jwtKey` that is not a PEM public key | `clerkAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `jwtKey` is a PEM key but not an RSA key | `MayuraError` `INVALID_CONFIG` when a token is checked; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens with `testIssuer` from `mayura/auth/testing` and serve its JWKS through a fake
  `fetch`. They check that the Frontend API is read from publishable keys, that tokens for other origins, other
  instances, other keys, ES256, `pending` sessions and tokens without `sid` are refused, that keys are fetched once,
  that the PEM key verifies with no network, and that version 2 permission bitmasks decode as Clerk documents them.
- `scripts/live/auth-clerk.mjs` fetched and checked Clerk's published signing keys for a real instance on October 6,
  2026. A real session token has not been verified with it yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [WorkOS AuthKit and Connect tokens](auth-workos.md) and [Auth0 access tokens](auth-auth0.md): other hosted sign-in.
