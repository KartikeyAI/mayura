---
title: "Auth0 access tokens"
description: "Accept Auth0 access tokens for your API on Mayura's server with @mayurajs/auth-auth0: checks, users and machines, options and errors."
package: "@mayurajs/auth-auth0"
vendor: "Auth0"
logo: "auth0"
website: "https://auth0.com"
area: "auth"
---

[Auth0](https://auth0.com) issues access tokens to users and machines for the APIs you register in your tenant.
`@mayurajs/auth-auth0` turns access tokens for your API into identities for Mayura's server: it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for your tenant, and
your `identity` mapping decides what each holder may do. It verifies tokens with `mayura/auth`'s own JWT verifier
(WebCrypto only): no Auth0 SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-auth0
```

## Credentials

Register an API in the [Auth0 dashboard](https://manage.auth0.com) under **Applications > APIs**. You need its
**Identifier** (the audience tokens are issued for) and your tenant's domain, such as `acme.us.auth0.com`, or the custom
domain your applications get tokens from. Nothing secret is needed while the API signs with RS256, Auth0's default.

Only if the API signs with HS256 do you need its signing secret (in the API's settings), passed as `signingSecret`; it
must be at least 32 bytes. The package reads nothing from the environment: pass the values in yourself, for example from
`AUTH0_DOMAIN` and `AUTH0_AUDIENCE`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { auth0Authenticator } from '@mayurajs/auth-auth0';

export const authenticate = auth0Authenticator({
  domain: process.env.AUTH0_DOMAIN ?? '',     // acme.us.auth0.com
  audience: process.env.AUTH0_AUDIENCE ?? '', // your API's identifier, such as https://agents.acme.com
  identity: session => session.orgId && !session.machine ? {
    principalId: principalId('auth0', session.subject),
    projectId: session.orgId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.permissions, { 'use:agents': ['runs:submit', 'runs:read'] }),
  } : null,
});
// createAgentServer({ ..., authenticate })
```

Auth0 subjects such as `auth0|123` hold a character Mayura's ids do not, so `principalId('auth0', subject)` gives a
stable hashed id for them. Auth0 asks APIs to check `org_id` when organizations are used; mapping it to the project, as
above, does that. Turn on RBAC and **Add Permissions in the Access Token** for your API to get `permissions`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `domain` | required | Your tenant's domain or custom domain. `https://` and a trailing slash are accepted and dropped. |
| `audience` | required | Your API's identifier, or several. A token's `aud` must include one. |
| `identity` | required | What a token's holder may do, or `null` to refuse. |
| `signingSecret` | none | Your API's HS256 signing secret. With it, only HS256 is accepted and the tenant's keys are never fetched. |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **Issuer.** `https://<domain>/`, with the trailing slash Auth0 writes; a token naming the issuer without it is
  refused.
- **Audience.** The token's `aud` (a string or a list, as with `openid` tokens that also name `/userinfo`) must include
  one of yours.
- **Signature.** RS256 with a key from `https://<domain>/.well-known/jwks.json`, or HS256 with `signingSecret`; never
  both, so a token signed one way cannot pass as the other.
- **Times.** The token must carry `exp` and be unexpired, with `clockSkewMs` of leeway.
- **Subject.** A token without `sub` is refused.

Machine tokens (client credentials) are **not** refused by this package: `session.machine` tells you which they are,
and your `identity` decides. Fetched keys are kept as described in
[Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider).

## What `identity` receives

Both access token profiles are read: Auth0's and RFC 9068.

| Field | From |
| --- | --- |
| `subject` | `sub`: the user (`auth0\|...`, `google-oauth2\|...`), or a machine's `<client id>@clients`. |
| `clientId` | `azp`, or `client_id` in the RFC 9068 profile; `null` if neither. |
| `machine` | `true` when `gty` is `client-credentials` or the subject ends in `@clients`. |
| `scopes` | `scope`, split on spaces. |
| `permissions` | `permissions` (with RBAC on). |
| `orgId`, `orgName` | `org_id` and `org_name`, or `null`. |
| `claims` | The verified claims. |

`auth0Session(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a domain that is not a host name, an empty audience, a `signingSecret` that is not a string or is under 32 bytes | `auth0Authenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 and HS256 tokens and serve a JWKS through a fake `fetch`. They check every form of
  `domain`, that tokens for another API, another tenant, without the trailing slash or from other keys are refused,
  that both token profiles are read (users, machines, scopes, permissions, organizations), and that with
  `signingSecret` only HS256 passes and no keys are fetched.
- A live script, `scripts/live/auth-auth0.mjs`, exists but has not passed against a real Auth0 tenant yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Okta access tokens](auth-okta.md) and [Microsoft Entra ID access tokens](auth-entra.md): other API token issuers.
