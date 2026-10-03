# @mayurajs/auth-workos

[WorkOS](https://workos.com) AuthKit session tokens, and Connect access tokens (OAuth and machine-to-machine), as Mayura
server identities: verified with WorkOS's published keys, on any runtime, with no dependency.

```bash
npm install mayura @mayurajs/auth-workos
```

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { workosAuthenticator } from '@mayurajs/auth-workos';

const authenticate = workosAuthenticator({
  clientId: 'client_01H...',
  connect: { domain: 'https://acme.authkit.app' }, // optional: Connect tokens too
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

- **AuthKit session tokens.** RS256 access tokens issued by `https://api.workos.com/` (or your custom auth domain, as
  `issuer`), checked against `https://api.workos.com/sso/jwks/<clientId>`. They carry no audience.
- **Connect tokens** (with `connect`). RS256 access tokens issued by your AuthKit domain for `audience` (your client ID
  by default, or your resource indicators), checked against `<domain>/oauth2/jwks`. Tokens a machine holds (client
  credentials: no consent, and its own client as subject) are refused unless `allowMachines`. When your custom auth
  domain is also your AuthKit domain, a token is checked as either kind.
- Only the keys of a token's own issuer are fetched.
- **What you get.** `identity` receives the session: `kind` (`authkit` or `connect`), `subject` (the user, or a
  machine's client ID), `machine`, `sessionId`, `clientId`, `orgId`, `role` and `roles`, `permissions` (AuthKit),
  `scopes` (Connect), and the raw `claims`. Nothing is granted unless `identity` grants it.
- WorkOS API keys are verified by `@mayurajs/km-workos`.
- Options: `clientId`, `identity`, `issuer`, `connect: { domain, audience }`, `allowMachines`, `clockSkewMs` (5 s),
  `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
