---
title: "Neon Auth tokens"
description: "Accept Neon Auth (Neon's managed better-auth) JWTs on Mayura's server with @mayurajs/auth-neon: checks, banned users, options and errors."
package: "@mayurajs/auth-neon"
vendor: "Neon"
logo: "neon"
website: "https://neon.com"
area: "auth"
---

[Neon Auth](https://neon.com/docs/auth/overview) is Neon's managed
[better-auth](../guides/authentication.md#sign-in-with-better-auth): users sign in to your application, and their
accounts live in your Neon database. `@mayurajs/auth-neon` turns the JWTs
Neon Auth issues into identities for Mayura's server: it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for your project, and
your `identity` mapping decides what each user may do. It verifies tokens with `mayura/auth`'s own JWT verifier
(WebCrypto only): no Neon SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-neon
```

## Credentials

Nothing secret is needed: only your project's **Neon Auth URL**, which the [Neon console](https://console.neon.tech)
shows on the project's **Auth** page (Neon names it `NEON_AUTH_BASE_URL`), such as
`https://ep-xxx.neonauth.us-east-1.aws.neon.tech/neondb/auth`. The package reads nothing from the environment: pass it
in yourself, for example from `NEON_AUTH_BASE_URL`.

## Use it

```ts
import { principalId } from 'mayura/auth';
import { neonAuthAuthenticator } from '@mayurajs/auth-neon';

export const authenticate = neonAuthAuthenticator({
  authUrl: process.env.NEON_AUTH_BASE_URL ?? '',
  identity: session => session.emailVerified ? {
    principalId: principalId('neon', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: session.role === 'admin' ? ['runs:submit', 'runs:read', 'runs:cancel'] : ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate })
```

In your app, Neon's client gives the JWT as `data.token` from `authClient.token()`, or in the `set-auth-jwt` header of
`getSession()`; send it to Mayura's server as the bearer token. The tokens last 15 minutes.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `authUrl` | required | Your Neon Auth URL: https, with no query, fragment or credentials. A trailing slash is dropped. |
| `identity` | required | What a signed-in user may do, or `null` to refuse. |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **Signature.** EdDSA (Ed25519) only, with a key from `<authUrl>/.well-known/jwks.json`.
- **Issuer and audience.** Both must be your Neon Auth URL's origin (such as
  `https://ep-xxx.neonauth.us-east-1.aws.neon.tech`), as Neon issues them.
- **Times.** The token must carry `exp` and be unexpired, with `clockSkewMs` of leeway.
- **User.** A token without `sub` is refused, and so is a banned user: `banned` is `true` and `banExpires` is absent,
  unreadable or still ahead. A ban whose `banExpires` has passed no longer refuses.

Fetched keys are kept as described in
[Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider).

## What `identity` receives

| Field | From |
| --- | --- |
| `userId` | `sub` |
| `email` | `email`, or `null`. |
| `emailVerified` | `true` only when `emailVerified` is `true`. |
| `name` | `name`, or `null`. |
| `role` | `role`, such as `authenticated`, or one better-auth's admin plugin set; `null` if absent. |
| `claims` | The verified claims. |

`neonAuthSession(claims)` and `neonAuthBanned(claims)` are exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: an `authUrl` that is not an https URL, or has a query, fragment or credentials | `neonAuthAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, the user is banned, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real EdDSA tokens with `testIssuer` and serve its JWKS under the auth URL's path through a fake
  `fetch`. They check that tokens for another audience or issuer, from other keys or signed with RS256 are refused, that
  banned users are refused until their ban expires (in seconds, milliseconds or an ISO date), and that the user is read
  defensively.
- A live script, `scripts/live/auth-neon.mjs`, exists but has not passed against a real Neon project yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Sign-in with better-auth](../guides/authentication.md#sign-in-with-better-auth): better-auth on your own database.
- [Supabase Auth tokens](auth-supabase.md): another database-backed sign-in.
