---
title: "WorkOS AuthKit and Connect tokens"
description: "Accept WorkOS AuthKit session tokens and Connect access tokens on Mayura's server with @mayurajs/auth-workos: checks, machines and errors."
package: "@mayurajs/auth-workos"
vendor: "WorkOS"
logo: "workos"
website: "https://workos.com"
area: "auth"
---

[WorkOS](https://workos.com) AuthKit signs users in to your application, with organizations, roles and enterprise SSO,
and Connect issues OAuth access tokens, also to machines. `@mayurajs/auth-workos` turns AuthKit session tokens, and
optionally Connect access tokens, into identities for Mayura's server; your `identity` mapping decides what each holder
may do. It verifies tokens with `mayura/auth`'s own JWT verifier (WebCrypto only): no WorkOS SDK, no dependency, and
it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-workos
```

## Credentials

Nothing secret is needed: only your environment's **client ID** (`client_...`), shown in the
[WorkOS dashboard](https://dashboard.workos.com) under **API Keys**. To accept Connect tokens too, also give your
**AuthKit domain**, such as `https://acme.authkit.app`, shown on the dashboard's AuthKit settings. The package reads
nothing from the environment: pass the values in yourself, for example from `WORKOS_CLIENT_ID` and
`WORKOS_AUTHKIT_DOMAIN`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { workosAuthenticator } from '@mayurajs/auth-workos';

export const authenticate = workosAuthenticator({
  clientId: process.env.WORKOS_CLIENT_ID ?? '',
  connect: { domain: process.env.WORKOS_AUTHKIT_DOMAIN ?? '' }, // optional: Connect tokens too
  identity: session => session.orgId ? {
    principalId: principalId('workos', session.subject),
    projectId: session.orgId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.kind === 'authkit' ? session.permissions : session.scopes, {
      'agents:use': ['runs:submit', 'runs:read'],
    }),
  } : null,
});
// createAgentServer({ ..., authenticate })
```

Your frontend sends the AuthKit access token (or a client sends its Connect access token) as the bearer token.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `clientId` | required | Your WorkOS client ID, `client_` and 6 to 64 letters or digits. |
| `identity` | required | What a token's holder may do, or `null` to refuse. |
| `issuer` | `https://api.workos.com/` | The issuer of AuthKit session tokens: your custom auth domain, if you set one (an https URL, compared as given). |
| `connect` | none | `{ domain, audience }`: also accept Connect access tokens from your AuthKit domain (https). `audience` is your client ID by default, or your resource indicators. |
| `allowMachines` | `false` | Accept Connect tokens a machine holds (client credentials). |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for the JWKS. |

## What is checked

- **AuthKit session tokens.** RS256, issued by `issuer` (with the trailing slash AuthKit writes on
  `https://api.workos.com/`), verified only with the keys WorkOS publishes for your client at
  `https://api.workos.com/sso/jwks/<clientId>`. They carry no audience.
- **Connect tokens** (with `connect`). RS256, issued by your AuthKit domain's origin for `audience`, verified with the
  keys at `<domain>/oauth2/jwks`. A token with no consent (`sid`) whose subject is its own `client_id` is a machine's,
  and is refused unless `allowMachines`.
- **Times and subject.** Every token must carry `exp` and be unexpired, with `clockSkewMs` of leeway, and have a `sub`.
- Only the keys of a token's own issuer are fetched, so a token naming another issuer never makes it fetch. When your
  custom auth domain is also your AuthKit domain, a token is checked as an AuthKit token first, then as a Connect token.

Fetched keys are kept as described in
[Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider).

## What `identity` receives

| Field | From |
| --- | --- |
| `kind` | `authkit` for a session token, `connect` for a Connect token. |
| `subject` | `sub`: the user, or a machine's client ID. |
| `machine` | `true` for a Connect client credentials token. |
| `sessionId` | `sid`: the AuthKit session, or the Connect consent; `null` if absent. |
| `clientId` | `client_id` (Connect), or `null`. |
| `orgId` | `org_id`: the organization selected at sign-in, or a machine's; `null` if absent. |
| `role`, `roles` | `role`, and `roles` (or `[role]` when only `role` is given). |
| `permissions` | `permissions` (AuthKit). |
| `scopes` | `scope`, split on spaces (Connect). |
| `claims` | The verified claims. |

`workosSession(claims, kind)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: a malformed `clientId`, an `issuer` or `connect.domain` that is not an https URL, a non-boolean `allowMachines`, `maxIdentityMs` out of range | `workosAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, is a machine's without `allowMachines`, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| The JWKS cannot be fetched and no keys are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens for both kinds and serve both JWKS URLs through a fake `fetch`. They check that
  AuthKit tokens read the organization, role and permissions, that other issuers and keys are refused, that Connect
  tokens are refused unless `connect` is set, that only the token's own issuer's keys are fetched, that machines need
  `allowMachines`, and that a shared custom domain accepts both kinds.
- `scripts/live/auth-workos.mjs` fetched and checked WorkOS's published signing keys on October 6, 2026. A real token
  has not been verified with it yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Clerk session tokens](auth-clerk.md) and [Okta access tokens](auth-okta.md): other hosted sign-in.
