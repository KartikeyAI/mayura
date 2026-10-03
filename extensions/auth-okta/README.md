# @mayurajs/auth-okta

[Okta](https://developer.okta.com/docs/guides/validate-access-tokens/) access tokens from a custom authorization server
as Mayura server identities: verified with its published keys, on any runtime, with no dependency.

```bash
npm install mayura @mayurajs/auth-okta
```

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { oktaAuthenticator } from '@mayurajs/auth-okta';

const authenticate = oktaAuthenticator({
  domain: 'acme.okta.com',
  authorizationServer: 'default', // the default; or your custom authorization server's id
  audience: 'api://default',
  identity: session => ({
    principalId: principalId('okta', session.userId ?? session.subject),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: mapCapabilities(session.scopes, { 'agents.use': ['runs:submit', 'runs:read'] }),
  }),
});
// createAgentServer({ ..., authenticate })
```

- **Which tokens.** RS256 access tokens issued by the custom authorization server
  (`https://<domain>/oauth2/<authorizationServer>`) for its audience, checked against `<issuer>/v1/keys`. Tokens from
  the org authorization server (`https://<domain>`) are meant for Okta's own APIs, and are never accepted.
- **Refused.** Machine tokens (client credentials: no `uid`, the client as subject) unless `allowMachines`, tokens
  from clients not in `clientIds` when it is given, and sender-constrained (DPoP) tokens, whose proof of possession
  this does not check.
- **What you get.** `identity` receives the session: `subject` (the user's login, or a machine's client id),
  `userId` (`uid`, the stable key), `clientId`, `machine`, `scopes`, `groups` (when your authorization server adds a
  `groups` claim), and the raw `claims`. Nothing is granted unless `identity` grants it.
- Options: `domain`, `authorizationServer` (`default`), `audience`, `identity`, `clientIds`, `allowMachines`,
  `clockSkewMs` (5 s), `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
