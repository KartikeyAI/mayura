---
title: "Microsoft Entra ID access tokens"
description: "Accept Microsoft Entra ID access tokens for your API on Mayura's server with @mayurajs/auth-entra: tenants, app-only tokens and errors."
package: "@mayurajs/auth-entra"
vendor: "Microsoft Entra ID"
logo: "microsoft"
website: "https://learn.microsoft.com/entra/identity-platform/"
area: "auth"
---

[Microsoft Entra ID](https://learn.microsoft.com/entra/identity-platform/access-tokens) issues access tokens to users
and applications for the APIs registered in a tenant. `@mayurajs/auth-entra` turns access tokens for your API into
identities for Mayura's server, single-tenant or multi-tenant; your `identity` mapping decides what each holder may do.
It verifies tokens with `mayura/auth`'s own JWT verifier (WebCrypto only): no MSAL, no dependency, and it runs on every
runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/auth-entra
```

## Credentials

Nothing secret is needed. In the [Microsoft Entra admin center](https://entra.microsoft.com), register your API under
**App registrations** and expose it (**Expose an API**). You need its **Application (client) ID**, and its **Application
ID URI** (such as `api://agents`) if tokens name that instead, plus the **Directory (tenant) ID** of each tenant you
accept, all on the registration's **Overview** page. Define app roles there to grant through `session.roles`.

The package reads nothing from the environment: pass the values in yourself, for example from `ENTRA_TENANT_ID` and
`ENTRA_CLIENT_ID`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { entraAuthenticator } from '@mayurajs/auth-entra';

export const authenticate = entraAuthenticator({
  tenants: [process.env.ENTRA_TENANT_ID ?? ''],                 // or 'any' for a multi-tenant application
  audience: [process.env.ENTRA_CLIENT_ID ?? '', 'api://agents'], // your API's client id and app ID URI
  identity: session => ({
    principalId: principalId('entra', session.objectId),
    projectId: session.tenantId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.roles, { 'Agents.Use': ['runs:submit', 'runs:read'] }),
  }),
});
// createAgentServer({ ..., authenticate })
```

Key users on `session.objectId`, which is the same across your applications; `session.username` can change and is never
a key. With `tenants: 'any'`, `identity` decides which tenants get anything.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `tenants` | required | The tenant (directory) ids accepted, as GUIDs, or `'any'` for a multi-tenant application. |
| `audience` | required | Your API's application id, and its app ID URI if tokens name that instead. Microsoft Graph's audience is refused. |
| `identity` | required | What a token's holder may do, or `null` to refuse. |
| `allowApps` | `false` | Accept app-only tokens (client credentials, no user). |
| `versions` | `['2.0']` | The access token versions accepted: `'2.0'`, `'1.0'` or both, as your API's `accessTokenAcceptedVersion` sets. |
| `clockSkewMs` | 5 s | Clock difference allowed for `exp`, `nbf` and `iat`. At most 60 s. |
| `maxIdentityMs` | 60 s | The longest an identity lasts before the token is checked again (1 s to 1 hour). |
| `fetch` | `globalThis.fetch` | For tests and proxies: the fetch used for Microsoft's keys. |

## What is checked

- **Issuer.** `https://login.microsoftonline.com/<tenant>/v2.0` for v2.0 tokens, and `https://sts.windows.net/<tenant>/`
  for v1.0 tokens when `versions` includes `'1.0'`. The issuer is substituted for each tenant, never matched by
  pattern, and with `'any'` each token's issuer must still name a tenant id.
- **Audience.** One of yours. The package refuses to be configured for Microsoft Graph's audience
  (`00000003-0000-0000-c000-000000000000` or `https://graph.microsoft.com`): tokens for Graph are Graph's to check.
- **Signature.** RS256 with Microsoft's keys: `https://login.microsoftonline.com/common/discovery/v2.0/keys` for v2.0
  tokens, `https://login.microsoftonline.com/common/discovery/keys` for v1.0. A key that names its issuer (a
  `{tenantid}` template, or one tenant) verifies only that issuer's tokens, through `keyFilter`, so a key bound to one
  tenant never verifies another's.
- **Times.** The token must carry `exp` and be unexpired, with `clockSkewMs` of leeway.
- **Claims.** `tid` must be the issuer's tenant, `oid` a GUID, and `sub` present. A token with no `scp` (delegated
  scopes) is an application's own and is refused unless `allowApps`.

Tokens from tenants or versions you do not accept are refused before any key is fetched. Fetched keys are kept as
described in [Tokens from an identity provider](../guides/authentication.md#tokens-from-an-identity-provider).

## What `identity` receives

| Field | From |
| --- | --- |
| `objectId` | `oid`: the user or service principal, the same across your applications. |
| `tenantId` | `tid` |
| `subject` | `sub`: pairwise, different for each application. |
| `app` | `true` for an app-only token (no `scp`). |
| `clientId` | `azp` (v2.0) or `appid` (v1.0), or `null`. |
| `roles` | `roles`: a user's assigned app roles, or an application's granted permissions. |
| `scopes` | `scp`, split on spaces: delegated permissions. |
| `name` | `name`, or `null`. |
| `username` | `preferred_username` (v2.0), or `upn` or `unique_name` (v1.0); never a stable key. |
| `version` | `'1.0'` or `'2.0'`, from the issuer. |
| `claims` | The verified claims. |

`entraSession(claims)` is exported for checks of your own.

## Errors

| What happens | Result |
| --- | --- |
| A configuration mistake: tenants that are not GUIDs or `'any'`, an empty audience, Microsoft Graph's audience, unknown `versions`, a non-boolean `allowApps`, `maxIdentityMs` out of range | `entraAuthenticator()` throws `MayuraError` `INVALID_CONFIG`. |
| The token fails any check, is app-only without `allowApps`, or `identity` returns `null` | `authenticate` returns `null`; the server answers 401 `AUTH_INVALID`. |
| Microsoft's keys cannot be fetched and none are cached (or they are over 10 minutes past their age) | `MayuraError` `TOOL_FAILED`; the server answers 503 `AUTH_UNAVAILABLE`. |
| `identity` returns ids or capabilities the server cannot use | `MayuraError` `INVALID_CONFIG`; the server answers 503 `AUTH_UNAVAILABLE`, never lets the caller in. |

## How it is tested

- Unit tests sign real RS256 tokens and serve both of Microsoft's key sets through a fake `fetch`, with v2.0 keys bound
  to tenants by their issuer template. They check that other tenants, audiences (Graph's among them), tenant
  mismatches, app-only tokens and v1.0 tokens are refused unless allowed, that refused tenants and versions fetch no
  keys, that v1.0 tokens use the v1.0 keys, and that with `'any'` a key bound to one tenant never verifies another's.
- `scripts/live/auth-entra.mjs` fetched and checked Microsoft's published discovery documents and signing keys (v2.0
  and v1.0) on October 6, 2026. A real token has not been verified with it yet.

## Related

- [Authentication and API keys](../guides/authentication.md): the verifier, key caching and identity mapping.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): capabilities and auth errors.
- [Okta access tokens](auth-okta.md) and [Amazon Cognito tokens](auth-cognito.md): other enterprise token issuers.
