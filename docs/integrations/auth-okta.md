---
title: "Okta access tokens"
description: "Accept Okta access tokens from a custom authorization server on Mayura's server with @mayurajs/auth-okta: checks, machines, DPoP and errors."
package: "@mayurajs/auth-okta"
vendor: "Okta"
logo: "okta"
website: "https://www.okta.com"
area: "auth"
---

[Okta](https://developer.okta.com/docs/guides/validate-access-tokens/) issues access tokens to users and machines from
authorization servers in your Okta org. `@mayurajs/auth-okta` turns access tokens from a custom authorization server
into identities for Mayura's server: it is a
[`jwtAuthenticator`](../guides/authentication.md#tokens-from-an-identity-provider) already set up for that server, and
your `identity` mapping decides what each holder may do. It verifies tokens with `mayura/auth`'s own JWT verifier
(WebCrypto only): no Okta SDK, no dependency, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-okta
```

## Credentials

Nothing secret is needed. In the Okta Admin Console of your org ([sign up](https://developer.okta.com/signup/) for one),
under **Security > API > Authorization Servers**, pick the custom authorization server your applications get tokens
from (`default` or another). You need your Okta domain (such as `acme.okta.com`, or your custom domain), the server's
id, and its **Audience** (such as `api://default`).

The package reads nothing from the environment: pass the values in yourself, for example from `OKTA_DOMAIN`,
`OKTA_AUTH_SERVER` and `OKTA_AUDIENCE`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { oktaAuthenticator } from '@mayurajs/auth-okta';

export const authenticate = oktaAuthenticator({
  domain: process.env.OKTA_DOMAIN ?? '',                 // acme.okta.com
  authorizationServer: process.env.OKTA_AUTH_SERVER ?? 'default',
  audience: process.env.OKTA_AUDIENCE ?? 'api://default',
  identity: session => ({
    principalId: principalId('okta', session.userId ?? session.subject),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: mapCapabilities(session.scopes, { 'agents.use': ['runs:submit', 'runs:read'] }),
  }),
});
// createAgentServer({ ..., authenticate })
```

Key users on `session.userId` (`uid`, such as `00u...`): `session.subject` is the user's login, often an email, which
can change.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `domain` | required | Your Okta domain or custom domain. `https://` and a trailing slash are accepted and dropped. |
| `authorizationServer` | `default` | The custom authorization server's id: 1 to 64 letters and digits. |
| `audience` | required | The authorization server's audience, or several. A token's `aud` must include one. |
| `identity` | required | What a token's holder may do, or `null` to refuse. |
| `clientIds` | any | The client applications (`cid`) whose tokens are accepted. |
| `allowMachines` | `false` | Accept machine (client credentials) tokens. |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **Issuer.** `https://<domain>/oauth2/<authorizationServer>`. Tokens from the org authorization server
  (`https://<domain>`) are meant for Okta's own APIs, and this package cannot be configured to accept them.
- **Signature.** RS256 with a key from `<issuer>/v1/keys`.
- **Audience and times.** `aud` must include one of yours, and the token must carry `exp` and be unexpired, with
  `clockSkewMs` of leeway.
- **Client and subject.** A token needs `sub` and `cid`; with `clientIds`, `cid` must be one of them.
- **Machines.** A token with no `uid` whose subject is its own client is a machine's, and is refused unless
  `allowMachines`.
- **DPoP.** A sender-constrained token (one with a `cnf` claim) is refused: it is only its holder's with a proof of the
  key, which this package does not check.

Fetched keys are kept as described in
[Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider).

## What `identity` receives

| Field | From |
| --- | --- |
| `subject` | `sub`: the user's login, or a machine's client id. |
| `userId` | `uid`: the user's Okta id; `null` for a machine. |
| `clientId` | `cid` |
| `machine` | `true` for a client credentials token. |
| `scopes` | `scp` |
| `groups` | `groups`, when your authorization server is set up to add that claim. |
| `claims` | The verified claims. |

`oktaSession(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a domain that is not a host name, a malformed `authorizationServer`, an empty audience or `clientIds`, a non-boolean `allowMachines` | `oktaAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens and serve the authorization server's JWKS through a fake `fetch`. They check every
  form of `domain`, a named custom authorization server, that other audiences, issuers (the org authorization server's
  among them), keys and clients are refused, that DPoP-bound tokens are refused, and that machines need
  `allowMachines`.
- A live script, `scripts/live/auth-okta.mjs`, exists but has not passed against a real Okta org yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Microsoft Entra ID access tokens](auth-entra.md) and [Auth0 access tokens](auth-auth0.md): other API token issuers.
