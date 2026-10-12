---
title: "Firebase Authentication ID tokens"
description: "Accept Firebase Authentication ID tokens on Mayura's server with @mayurajs/auth-firebase: checks, tenants, anonymous users and errors."
package: "@mayurajs/auth-firebase"
vendor: "Firebase"
logo: "firebase"
website: "https://firebase.google.com"
area: "auth"
---

[Firebase Authentication](https://firebase.google.com/docs/auth) signs users in to your app and gives each one an ID
token, a JWT signed by Google. `@mayurajs/auth-firebase` turns those ID tokens into identities for Mayura's server,
checked as [Firebase specifies](https://firebase.google.com/docs/auth/admin/verify-id-tokens): it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for your project, and
your `identity` mapping decides what each user may do. It verifies tokens with `mayura/auth`'s own JWT verifier
(WebCrypto only): no Admin SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-firebase
```

## Credentials

Nothing secret is needed: only your **project ID**, shown in the [Firebase console](https://console.firebase.google.com)
under **Project settings > General**. The package reads nothing from the environment: pass it in yourself, for example
from `FIREBASE_PROJECT_ID`.

## Use it

```ts
import { principalId } from 'mayura/auth';
import { firebaseAuthenticator } from '@mayurajs/auth-firebase';

export const authenticate = firebaseAuthenticator({
  projectId: process.env.FIREBASE_PROJECT_ID ?? '', // acme-app-1234
  identity: session => session.emailVerified && session.claims['agents'] === true ? {
    principalId: principalId('firebase', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate })
```

Clients send `await user.getIdToken()` as the bearer token. Custom claims your server set with the Admin SDK (such as
`agents` above) are among `session.claims` and are safe to grant from.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `projectId` | required | Your Firebase project ID: 6 to 30 lowercase letters, digits and `-`. |
| `identity` | required | What a signed-in user may do, or `null` to refuse. |
| `tenants` | none | The Identity Platform tenant ids accepted. With it set, only users of those tenants pass. |
| `allowAnonymous` | `false` | Accept anonymous users (`sign_in_provider: anonymous`). |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf`, `iat` and `auth_time`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). ID tokens last an hour. |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for Google's keys. |

## What is checked

- **Signature.** RS256 with Google's keys for Firebase ID tokens, fetched as a JWKS from
  `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` (exported as
  `firebaseJwksUrl`): the same keys as the X.509 certificates Firebase's docs name.
- **Issuer and audience.** `https://securetoken.google.com/<projectId>`, for your project ID.
- **Times.** The token must carry `exp` and be unexpired, and `auth_time` must be a number in the past, with
  `clockSkewMs` of leeway.
- **Subject.** `sub` (the uid) must be 1 to 128 characters.
- **Tenants.** A user of an Identity Platform tenant is refused unless the tenant is in `tenants`; with `tenants` set,
  users with no tenant are refused too.
- **Anonymous users** are refused unless `allowAnonymous`.

An ID token stays valid until it expires, even after its user is disabled or their tokens are revoked; checking that
needs a call to Firebase per request, which this package does not make. Where it matters, compare
`session.authTimeMs` with the revocation time you store when you revoke.

## What `identity` receives

| Field | From |
| --- | --- |
| `userId` | `sub`: the uid. |
| `email` | `email`, or `null`. |
| `emailVerified` | `true` only when `email_verified` is `true`. |
| `phoneNumber`, `name` | `phone_number` and `name`, or `null`. |
| `signInProvider` | `firebase.sign_in_provider`: `password`, `google.com`, `phone`, `anonymous`, `custom`, ... |
| `tenant` | `firebase.tenant`, or `null`. |
| `authTimeMs` | `auth_time`, in milliseconds. |
| `claims` | The verified claims, custom claims among them. |

`firebaseSession(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a malformed `projectId`, empty `tenants`, a non-boolean `allowAnonymous` | `firebaseAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| Google's keys cannot be fetched and none are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens and serve their JWKS at Google's URL through a fake `fetch`. They check that only
  that URL is fetched, that tokens for another project, from another issuer or key, with `auth_time` missing or in the
  future, or from anonymous users are refused, and that tenants are kept apart.
- `scripts/live/auth-firebase.mjs` signed in a test user of a real Firebase project and verified its real ID token on
  October 6, 2026.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Google sign-in](auth-google.md) and [Supabase Auth tokens](auth-supabase.md): other app sign-in.
