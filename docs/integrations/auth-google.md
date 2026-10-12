---
title: "Google sign-in"
description: "Accept Google ID tokens on Mayura's server, or sign users in with better-auth, using @mayurajs/auth-google: checks, Workspace domains and errors."
package: "@mayurajs/auth-google"
vendor: "Google"
logo: "google"
website: "https://developers.google.com/identity"
area: "auth"
---

[Sign in with Google](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) gives your app an ID
token, a JWT signed by Google, for each account that signs in. `@mayurajs/auth-google` offers two ways to use it with
Mayura:

- `googleAuthenticator`: ID tokens sent straight to Mayura's server as bearer tokens, checked as Google advises. It is a
  [`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) set up for your client IDs, and
  your `identity` mapping decides what each account may do.
- `googleSignIn`: Google as a social login for [better-auth](../guides/authentication.md#sign-in-with-better-auth),
  asking no more than signing in needs.

It verifies tokens with `mayura/auth`'s own JWT verifier (WebCrypto only): no Google SDK, no dependency, and it runs on
every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-google
```

## Credentials

Create an **OAuth client ID** in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) under
**APIs & Services > Credentials**. `googleAuthenticator` needs only the client ID (or several, for web and mobile
clients), which is not secret. `googleSignIn` also needs the client's secret, which stays on your server.

The package reads nothing from the environment: pass the values in yourself, for example from `GOOGLE_CLIENT_ID`.

## Use it

```ts
import { principalId } from 'mayura/auth';
import { googleAuthenticator } from '@mayurajs/auth-google';

export const authenticate = googleAuthenticator({
  clientIds: [process.env.GOOGLE_CLIENT_ID ?? ''], // 1234567890-abc.apps.googleusercontent.com
  hostedDomain: 'acme.com',                          // only Workspace accounts of acme.com
  identity: session => session.emailVerified ? {
    principalId: principalId('google', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate })
```

Clients send the ID token (the `credential` from Google Identity Services, or a mobile app's Google sign-in) as the
bearer token. Key users on `session.userId`, the stable account id; Google advises against keying users on email.

To have users sign in to your own application with better-auth instead, pass `googleSignIn` as its Google provider:

```ts
import { betterAuth } from 'better-auth';
import { googleSignIn } from '@mayurajs/auth-google';

export const auth = betterAuth({
  socialProviders: {
    google: googleSignIn({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      hostedDomain: 'acme.com',
    }),
  },
});
```

## Options

`googleAuthenticator`:

| Option | Default | Meaning |
| --- | --- | --- |
| `clientIds` | required | Your OAuth client IDs (ending in `.apps.googleusercontent.com`), one or several. A token's audience must be one. |
| `identity` | required | What a Google account may do, or `null` to refuse. |
| `hostedDomain` | none | Only accounts of this Workspace domain (`hd`, compared case-insensitively), or `*` for any Workspace account. |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). ID tokens last an hour. |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for Google's keys. |

`googleSignIn`:

| Option | Default | Meaning |
| --- | --- | --- |
| `clientId` | required | Your OAuth client ID, or several. |
| `clientSecret` | required | Your OAuth client's secret. |
| `hostedDomain` | none | Only accounts of this Workspace domain, or `*`; sent as `hd`, which better-auth checks against the returned token. |
| `offline` | `false` | Ask for offline access (a refresh token). Online access otherwise. |
| `scopes` | none | Extra OAuth scopes, such as `https://www.googleapis.com/auth/calendar.readonly`. |

`googleSignIn` always sets `includeGrantedScopes: false`, so a sign-in asks only for this sign-in's scopes.

## What is checked

- **Signature.** RS256 with Google's keys from `https://www.googleapis.com/oauth2/v3/certs` (exported as
  `googleJwksUrl`), kept for the response's `max-age`, at most 10 minutes.
- **Issuer.** `https://accounts.google.com` or `accounts.google.com`: Google writes it both ways.
- **Audience.** One of your `clientIds`.
- **Times.** The token must carry `exp` and be unexpired, with `clockSkewMs` of leeway.
- **Account.** A token without `sub` is refused. With `hostedDomain`, a token without `hd` (a consumer account) or with
  another domain is refused.

See [Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider) for the key cache,
timeouts and size limits.

## What `identity` receives

| Field | From |
| --- | --- |
| `userId` | `sub`: the stable account id. |
| `email` | `email`, or `null`. |
| `emailVerified` | `true` only when `email_verified` is `true`. |
| `hostedDomain` | `hd`: the Workspace domain, or `null` for a consumer account. |
| `name`, `picture` | `name` and `picture`, or `null`. |
| `authorizedParty` | `azp`: the client the token was issued through, or `null`. |
| `claims` | The verified claims. |

`googleSession(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a client ID not ending in `.apps.googleusercontent.com`, a `hostedDomain` that is not a domain or `*`, an empty `clientSecret`, a non-boolean `offline`, a scope with spaces | `googleAuthenticator()` or `googleSignIn()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| Google's keys cannot be fetched and none are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens and serve their JWKS at Google's URL through a fake `fetch`. They check both issuer
  spellings, several client IDs, that tokens for another client, issuer or key are refused, that `hostedDomain` keeps
  to one domain (or any Workspace domain with `*`), and that `googleSignIn` asks for online access and no granted
  scopes unless told otherwise.
- `scripts/live/auth-google.mjs` fetched and checked Google's published signing keys on October 6, 2026. A real ID
  token has not been verified with it yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Sign-in with better-auth](../guides/authentication.md#sign-in-with-better-auth): sign-in on your own database.
- [Firebase Authentication ID tokens](auth-firebase.md) and [Facebook Login](auth-facebook.md): other consumer sign-in.
