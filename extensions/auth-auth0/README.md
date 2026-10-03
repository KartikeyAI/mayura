# @mayurajs/auth-auth0

[Auth0](https://auth0.com) access tokens as Mayura server identities: verified with your tenant's published keys, on
any runtime, with no dependency.

```bash
npm install mayura @mayurajs/auth-auth0
```

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { auth0Authenticator } from '@mayurajs/auth-auth0';

const authenticate = auth0Authenticator({
  domain: 'acme.us.auth0.com',          // or the custom domain your applications get tokens from
  audience: 'https://agents.acme.com',  // your API's identifier
  identity: session => session.orgId ? {
    principalId: principalId('auth0', session.subject),
    projectId: session.orgId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.permissions, { 'use:agents': ['runs:submit', 'runs:read'] }),
  } : null,
});
// createAgentServer({ ..., authenticate })
```

- **What is checked.** Tokens issued by your tenant (`https://<domain>/`, with the trailing slash Auth0 writes) for your
  API (`audience`, one or several), signed with RS256 by the keys at `https://<domain>/.well-known/jwks.json`. If your
  API signs with HS256 instead, give its `signingSecret`: then only HS256 is accepted, never the tenant's keys.
- **What you get.** `identity` receives the token as a session, from either access token profile (Auth0's, or RFC
  9068): `subject`, `clientId` (`azp` or `client_id`), `machine` (client credentials: `gty`, or a subject ending in
  `@clients`), `scopes`, `permissions` (with RBAC on), the organization (`orgId`, `orgName`), and the raw `claims`.
  Auth0 asks APIs to check `org_id` when organizations are used; map it to the project, as above. Nothing is granted
  unless `identity` grants it.
- Auth0 subjects such as `auth0|123` hold a character Mayura's ids do not, so `principalId('auth0', subject)` gives a
  stable hashed id for them.
- Options: `domain`, `audience`, `identity`, `signingSecret`, `clockSkewMs` (5 s), `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
