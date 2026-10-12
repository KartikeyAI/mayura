---
title: "Facebook Login"
description: "Accept Facebook Login access tokens and iOS Limited Login tokens on Mayura's server with @mayurajs/auth-facebook, or sign in with better-auth."
package: "@mayurajs/auth-facebook"
vendor: "Facebook"
logo: "facebook"
website: "https://developers.facebook.com"
area: "auth"
---

[Facebook Login](https://developers.facebook.com/docs/facebook-login/) signs people in to your app with their Facebook
account. `@mayurajs/auth-facebook` offers two ways to use it with Mayura:

- `facebookAuthenticator`: Facebook Login user access tokens sent straight to Mayura's server, checked with Facebook's
  [`debug_token`](https://developers.facebook.com/docs/graph-api/reference/debug_token/) endpoint, and optionally iOS
  Limited Login tokens, checked with Facebook's published keys. Your `identity` mapping decides what each user may do.
- `facebookSignIn`: Facebook as a social login for [better-auth](../guides/authentication.md#sign-in-with-better-auth),
  reading no more of the profile than signing in needs.

It talks to Facebook with `fetch` and verifies Limited Login tokens with `mayura/auth`'s own JWT verifier (WebCrypto
only): no Facebook SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-facebook
```

## Credentials

Your **App ID** and **App Secret** are on your app's **App settings > Basic** page in
[Meta for Developers](https://developers.facebook.com/apps). `facebookAuthenticator` needs both: access tokens are
opaque, so it asks Facebook about each one with your app's token (`<appId>|<appSecret>`). The secret stays on your
server and never appears in an error.

The package reads nothing from the environment: pass the values in yourself, for example from `FACEBOOK_APP_ID` and
`FACEBOOK_APP_SECRET`.

## Use it

```ts
import { principalId } from 'mayura/auth';
import { facebookAuthenticator } from '@mayurajs/auth-facebook';

export const authenticate = facebookAuthenticator({
  appId: process.env.FACEBOOK_APP_ID ?? '',
  appSecret: process.env.FACEBOOK_APP_SECRET ?? '',
  requiredScopes: ['email'],
  identity: session => ({
    principalId: principalId('facebook', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  }),
});
// createAgentServer({ ..., authenticate })
```

Clients send the user access token from the Facebook SDK as the bearer token. `session.userId` is app-scoped: the same
person has a different id in each of your apps.

To have users sign in to your own application with better-auth instead, pass `facebookSignIn` as its Facebook provider:

```ts
import { betterAuth } from 'better-auth';
import { facebookSignIn } from '@mayurajs/auth-facebook';

export const auth = betterAuth({
  socialProviders: {
    facebook: facebookSignIn({
      clientId: process.env.FACEBOOK_APP_ID ?? '',
      clientSecret: process.env.FACEBOOK_APP_SECRET ?? '',
    }),
  },
});
```

## Options

`facebookAuthenticator`:

| Option | Default | Meaning |
| --- | --- | --- |
| `appId` | required | Your app's ID: 5 to 20 digits. |
| `appSecret` | required | Your app's secret: 16 to 128 letters and digits. |
| `identity` | required | What a Facebook user may do, or `null` to refuse. |
| `requiredScopes` | none | Permissions the user must have granted your app, such as `email`. |
| `limitedLogin` | `false` | Also accept iOS Limited Login tokens. |
| `cacheTtlMs` | 0 | Keep Facebook's answer about an access token this long (at most 5 minutes). |
| `timeoutMs` | 5 s | The longest wait for Facebook (1 s to 30 s). |
| `graphVersion` | `v26.0` | The Graph API version, such as `v26.0`. |
| `clockSkewMs` | 5 s | Clock difference allowed for Limited Login tokens. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

`facebookSignIn`:

| Option | Default | Meaning |
| --- | --- | --- |
| `clientId` | required | Your app's ID. |
| `clientSecret` | required | Your app's secret. |
| `picture` | `false` | Also read the profile picture. |
| `scopes` | none | Extra permissions, such as `user_birthday`. |

`facebookSignIn` reads only the `id`, `name` and `email` fields (`picture` if asked), and asks for no permissions
beyond better-auth's `email` and `public_profile` unless you add `scopes`.

## Access tokens

A token that looks like a Facebook Login user access token (`EA` and letters and digits) is sent to
`https://graph.facebook.com/<graphVersion>/debug_token` with your app token. It passes only when Facebook says it is
valid, a user's (`type` `USER`), for your app, not expired, and holds every permission in `requiredScopes`.

- **What leaves your server.** The user's token and your app token, in the query string of the call to
  `graph.facebook.com`. Nothing else is sent.
- **A call per request.** With `cacheTtlMs` at 0, each request asks Facebook, so a token the user revokes stops at once.
  A higher `cacheTtlMs` keeps Facebook's answer, refusals too, for that long (in up to 10,000 entries keyed by the
  token's SHA-256), and a revoked token then works for that long more.
- **Expiry.** The identity ends with the token's `expires_at`. A token Facebook says never expires still lasts no
  longer than `maxIdentityMs` before it is checked again.

## Limited Login

With `limitedLogin: true`, tokens from iOS Limited Login, which are OIDC JWTs, are checked with no call per request:
RS256 with Facebook's keys from `https://www.facebook.com/.well-known/oauth/openid/jwks/`, issued by
`https://www.facebook.com`, for your app ID, with `exp` required and `clockSkewMs` of leeway, and with a `sub`. Check
the token's `nonce` in your app, which made it. Without `limitedLogin`, these tokens are not accepted and never make it
fetch keys.

## What `identity` receives

| Field | From |
| --- | --- |
| `kind` | `access_token` or `limited_login`. |
| `userId` | The app-scoped user id (`user_id`, or `sub` for Limited Login). |
| `scopes` | The permissions the user granted (access tokens); empty for Limited Login. |
| `email`, `name` | From Limited Login tokens; `null` for access tokens. |
| `expiresAtMs` | When the token expires, or `null` when Facebook gives none. |

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a malformed `appId`, `appSecret`, scope or `graphVersion`, a non-boolean flag, `cacheTtlMs`, `timeoutMs` or `maxIdentityMs` out of range | `facebookAuthenticator()` or `facebookSignIn()` throws `MayuraError` `INVALID_CONFIG`. |
| Facebook says the token is not valid for your app, or it lacks a required permission, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| Facebook cannot be reached, times out, answers with an HTTP error, or answers in a shape Mayura does not know | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| The request is cancelled while Facebook is asked | `MayuraError` `CANCELLED`. |
| Facebook's Limited Login keys cannot be fetched and none are cached | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests run the package against a fake `debug_token` endpoint that checks the app token on every call. They check
  that invalid, other-app, non-user, expired and under-permissioned tokens are refused, that answers are kept only with
  `cacheTtlMs`, that unreachable, failing and malformed answers become `TOOL_FAILED` without the app secret in any
  message, that cancellation and `timeoutMs` stop the call, and that Limited Login tokens are verified with signed test
  tokens only when `limitedLogin` is on.
- `scripts/live/auth-facebook.mjs` fetched and checked Facebook's published Limited Login signing keys on October 6,
  2026. A real token has not been verified with it yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Sign-in with better-auth](../guides/authentication.md#sign-in-with-better-auth): sign-in on your own database.
- [Google sign-in](auth-google.md): another consumer sign-in, with a better-auth preset.
