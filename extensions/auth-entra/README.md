# @mayurajs/auth-entra

[Microsoft Entra ID](https://learn.microsoft.com/entra/identity-platform/access-tokens) access tokens for your API as
Mayura server identities: verified with Microsoft's published keys, on any runtime, with no dependency (no MSAL).

```bash
npm install mayura @mayurajs/auth-entra
```

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { entraAuthenticator } from '@mayurajs/auth-entra';

const authenticate = entraAuthenticator({
  tenants: ['11111111-1111-4111-8111-111111111111'], // or 'any' for a multi-tenant application
  audience: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'api://agents'], // your API's client id and app ID URI
  identity: session => ({
    principalId: principalId('entra', session.objectId),
    projectId: session.tenantId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.roles, { 'Agents.Use': ['runs:submit', 'runs:read'] }),
  }),
});
// createAgentServer({ ..., authenticate })
```

- **Which tokens.** RS256 access tokens issued for your API (`aud`) by a tenant you list, with the issuer substituted
  for that tenant (`https://login.microsoftonline.com/<tenant>/v2.0`), never matched by pattern. With `tenants: 'any'`
  each token's issuer is still its own tenant's, and `identity` decides which tenants get anything.
- **Microsoft's keys.** v2.0 tokens are checked against `https://login.microsoftonline.com/common/discovery/v2.0/keys`.
  A key that names its issuer verifies only that issuer's tokens, so a key bound to one tenant never verifies another's.
  v1.0 tokens (`https://sts.windows.net/<tenant>/`, with `versions: ['1.0', '2.0']`) use the v1.0 key set. Tokens from
  tenants not accepted never make it fetch.
- **Refused.** App-only tokens (client credentials, no `scp`) unless `allowApps`, tokens whose `tid` is not their
  issuer's tenant, and tokens with no object id. It refuses to be configured for Microsoft Graph's audience: tokens for
  Graph are Graph's to check.
- **What you get.** `identity` receives the session: `objectId` (the stable key, the same across your applications),
  `tenantId`, `subject` (pairwise), `app`, `clientId`, `roles`, `scopes`, `name`, `username` (never a key), `version`
  and the raw `claims`. Nothing is granted unless `identity` grants it.
- Options: `tenants`, `audience`, `identity`, `allowApps`, `versions` (`['2.0']`), `clockSkewMs` (5 s),
  `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
