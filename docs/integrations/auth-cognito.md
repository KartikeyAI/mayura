---
title: "Amazon Cognito tokens"
description: "Accept Amazon Cognito user pool access or ID tokens on Mayura's server with @mayurajs/auth-cognito: checks, app clients, machines and errors."
package: "@mayurajs/auth-cognito"
vendor: "Amazon Cognito"
logo: "aws"
website: "https://aws.amazon.com/cognito/"
area: "auth"
---

[Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)
user pools sign users in and issue access and ID tokens to your app clients, and access tokens to machines with client
credentials. `@mayurajs/auth-cognito` turns those tokens into identities for Mayura's server: it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for your pool, and
your `identity` mapping decides what each holder may do. It verifies tokens with `mayura/auth`'s own JWT verifier
(WebCrypto only): no AWS SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-cognito
```

## Credentials

Nothing secret is needed: no AWS credentials, only your **user pool ID** (such as `us-east-1_AbCdEf123`) and the
**client IDs** of the app clients whose tokens you accept, both in the
[Amazon Cognito console](https://console.aws.amazon.com/cognito/) on the user pool's overview and **App clients** pages.

The package reads nothing from the environment: pass the values in yourself, for example from `COGNITO_USER_POOL_ID`
and `COGNITO_CLIENT_ID`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { cognitoAuthenticator } from '@mayurajs/auth-cognito';

export const authenticate = cognitoAuthenticator({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? '', // us-east-1_AbCdEf123
  clientIds: [process.env.COGNITO_CLIENT_ID ?? ''],
  identity: session => ({
    principalId: principalId('cognito', session.subject),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: mapCapabilities(session.groups, { agents: ['runs:submit', 'runs:read'] }),
  }),
});
// createAgentServer({ ..., authenticate })
```

Clients send the access token as the bearer token, as APIs should receive. Key users on `session.subject` (`sub`), the
stable id in the pool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `userPoolId` | required | The user pool's id, `<region>_<id>`. The region is read from it. |
| `clientIds` | required | The app client ids whose tokens are accepted (lowercase letters and digits). |
| `identity` | required | What a token's holder may do, or `null` to refuse. |
| `tokenUse` | `access` | Which tokens are accepted: `access`, or `id` for ID tokens; never both. |
| `allowMachines` | `false` | Accept machine (client credentials) access tokens. |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **Issuer and signature.** Issued by the pool, `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, and signed
  with RS256 by a key from `<issuer>/.well-known/jwks.json`.
- **Times.** The token must carry `exp` and be unexpired, with `clockSkewMs` of leeway.
- **Token use.** `token_use` must be the kind you accept: an access token is never accepted as an ID token, nor the
  other way round.
- **App client.** Access tokens carry no audience: their `client_id` must be one of `clientIds`. An ID token's `aud`
  must be.
- **Machines.** An access token with no user name whose subject is its own client is a machine's, and is refused unless
  `allowMachines`.

Cognito can revoke tokens (on sign-out, or when a refresh token is revoked) that still verify until they expire: keep
access tokens short-lived. Fetched keys are kept as described in
[Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider).

## What `identity` receives

| Field | From |
| --- | --- |
| `tokenUse` | `access` or `id`. |
| `subject` | `sub`: the user's id in the pool, or a machine's app client id. |
| `username` | `username` (access) or `cognito:username` (ID); `null` for a machine. |
| `clientId` | `client_id` (access) or `aud` (ID). |
| `machine` | `true` for a client credentials token. |
| `groups` | `cognito:groups` |
| `scopes` | `scope`, split on spaces (access tokens only). |
| `email`, `emailVerified` | `email` and `email_verified` (ID tokens). |
| `claims` | The verified claims. |

`cognitoSession(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a malformed `userPoolId`, empty or malformed `clientIds`, a `tokenUse` other than `access` or `id`, a non-boolean `allowMachines` | `cognitoAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens and serve the pool's JWKS through a fake `fetch`. They check access tokens and,
  with `tokenUse: 'id'`, ID tokens, that one is never accepted for the other, that other clients, pools and keys are
  refused, and that machines need `allowMachines`.
- A live script, `scripts/live/auth-cognito.mjs`, exists but has not passed against a real user pool yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Okta access tokens](auth-okta.md) and [Microsoft Entra ID access tokens](auth-entra.md): other enterprise issuers.
