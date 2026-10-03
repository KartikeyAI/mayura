# @mayurajs/auth-clerk

[Clerk](https://clerk.com) session tokens as Mayura server identities: verified with your instance's published keys
(or its PEM key, with no network), on any runtime, with no dependency.

```bash
npm install mayura @mayurajs/auth-clerk
```

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { clerkAuthenticator } from '@mayurajs/auth-clerk';

const authenticate = clerkAuthenticator({
  publishableKey: 'pk_live_...',                    // or frontendApi: 'https://clerk.example.com'
  authorizedParties: ['https://app.example.com'],   // the origins your users sign in from
  identity: session => session.orgId ? {
    principalId: principalId('clerk', session.userId),
    projectId: session.orgId,
    agentIds: ['support'],
    capabilities: mapCapabilities(session.orgPermissions, {
      'org:agents:use': ['runs:submit', 'runs:read'],
      'org:agents:operate': ['workflows:read', 'workflows:control'],
    }),
  } : null,
});
// createAgentServer({ ..., authenticate })
```

- **What is checked.** RS256 tokens issued by your Frontend API (read from the publishable key), signed with its keys
  from `/.well-known/jwks.json` (or `jwtKey`, your PEM public key, with no network), within their 60-second lifetime
  (5 s of clock skew, as Clerk's SDK). Their `azp` must be one of `authorizedParties` (Clerk tokens carry no audience;
  this is what stands for it, against CSRF); `false` turns that off only where no browser is involved. Sessions Clerk
  marks `pending` are refused unless `allowPending`.
- **What you get.** `identity` receives the session: `userId`, `sessionId`, `status`, the active organization
  (`orgId`, `orgSlug`, `orgRole` as `org:admin`) and the user's `orgPermissions` there (`org:<feature>:<permission>`),
  decoded from version 2 tokens' feature bitmasks exactly as Clerk's SDK decodes them, or read from version 1 tokens;
  `actor` when someone is impersonating the user; and the raw `claims`. Nothing is granted unless `identity` grants it.
- `clerkFrontendApi(publishableKey)`, `clerkSession(claims)` and `clerkPermissions(claims)` are exported for your own
  checks.
- Clerk API keys are verified by `@mayurajs/km-clerk`.
- Options: `publishableKey` or `frontendApi`, `jwtKey`, `authorizedParties`, `identity`, `allowPending`, `clockSkewMs`,
  `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
