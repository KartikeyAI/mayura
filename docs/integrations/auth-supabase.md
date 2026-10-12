---
title: "Supabase Auth tokens"
description: "Accept Supabase Auth access tokens on Mayura's server with @mayurajs/auth-supabase: roles, anonymous users, MFA, legacy secrets and errors."
package: "@mayurajs/auth-supabase"
vendor: "Supabase"
logo: "supabase"
website: "https://supabase.com"
area: "auth"
---

[Supabase Auth](https://supabase.com/docs/guides/auth) signs users in to your Supabase project and gives each session an
access token, a JWT. `@mayurajs/auth-supabase` turns those access tokens into identities for Mayura's server: it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for your project, and
your `identity` mapping decides what each user may do. It verifies tokens with `mayura/auth`'s own JWT verifier
(WebCrypto only): no Supabase SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-supabase
```

## Credentials

Nothing secret is needed for projects that sign with asymmetric keys: only your project URL
(`https://<ref>.supabase.co`, or its custom domain), shown in the [Supabase dashboard](https://supabase.com/dashboard)
under **Project Settings > Data API**.

While tokens may still be signed with your project's legacy JWT secret (HS256), also pass that secret as `jwtSecret`;
it is under **Project Settings > JWT Keys** and must be at least 32 bytes. The package reads nothing from the
environment: pass the values in yourself, for example from `SUPABASE_URL`.

## Use it

```ts
import { principalId } from 'mayura/auth';
import { supabaseAuthenticator } from '@mayurajs/auth-supabase';

export const authenticate = supabaseAuthenticator({
  projectUrl: process.env.SUPABASE_URL ?? '', // https://abcdefghijklmnopqrst.supabase.co
  identity: session => session.appMetadata['plan'] === 'pro' ? {
    principalId: principalId('supabase', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate })
```

Clients send `session.access_token` from `supabase-js` as the bearer token. Grant from `appMetadata`, which only your
server (and Supabase) can set, never from `userMetadata`, which users can change themselves.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `projectUrl` | required | Your project's URL: an https origin, with no path. |
| `identity` | required | What a signed-in user may do, or `null` to refuse. |
| `jwtSecret` | none | Your project's legacy JWT secret, only while tokens may still be signed with it. The asymmetric keys keep working alongside it. |
| `roles` | `['authenticated']` | The Postgres roles (`role` claim) accepted. |
| `audience` | `authenticated` | The audience tokens must have, or several. |
| `allowAnonymous` | `false` | Accept anonymous users (`is_anonymous`). |
| `requireAal2` | `false` | Accept only users who signed in with a second factor (`aal2`). |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **Issuer.** `<projectUrl>/auth/v1`.
- **Signature.** ES256 or RS256 with a key from `<projectUrl>/auth/v1/.well-known/jwks.json`, kept at most 10 minutes
  as Supabase asks. HS256 only with `jwtSecret`; a JWKS never supplies an HMAC secret.
- **Audience and times.** `aud` must be `authenticated` (or yours), and the token must carry `exp` and be unexpired,
  with `clockSkewMs` of leeway.
- **Role.** Only roles in `roles` pass, so the public anon or publishable key and `service_role` tokens never act as a
  user. A token without `sub` or `role` is refused.
- **Anonymous users and MFA.** `is_anonymous` users are refused unless `allowAnonymous`; with `requireAal2`, only `aal2`
  sessions pass.

A Supabase access token stays valid until it expires (an hour by default), even after the user signs out. Where that
matters, check `session.sessionId` against `auth.sessions` in `identity`, or keep tokens short.

## What `identity` receives

| Field | From |
| --- | --- |
| `userId` | `sub` |
| `email`, `phone` | `email` and `phone`, or `null`. |
| `role` | `role`: `authenticated` for signed-in users. |
| `aal` | `aal`: `aal1`, or `aal2` with a second factor; `null` if absent. |
| `sessionId` | `session_id`, or `null`. |
| `anonymous` | `true` only when `is_anonymous` is `true`. |
| `appMetadata` | `app_metadata`: safe to grant from. |
| `userMetadata` | `user_metadata`: editable by the user, never grant from it. |
| `claims` | The verified claims. |

`supabaseSession(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a `projectUrl` that is not an https origin, empty `roles`, non-boolean flags, a `jwtSecret` that is not a string or is under 32 bytes | `supabaseAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real ES256, RS256 and HS256 tokens and serve a JWKS through a fake `fetch`. They check that anon,
  `service_role`, anonymous and other-audience tokens are refused by default, that `requireAal2` needs `aal2`, that
  HS256 passes only with the right secret while asymmetric keys keep working, and that a legacy anon key signed with the
  secret is still not a user.
- `scripts/live/auth-supabase.mjs` signed in a test user of a real Supabase project and verified its real access token
  on October 6, 2026; it also checks that the project's publishable key is never accepted as a user.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Firebase Authentication ID tokens](auth-firebase.md) and [Neon Auth tokens](auth-neon.md): other app sign-in.
