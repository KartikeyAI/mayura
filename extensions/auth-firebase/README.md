# @mayurajs/auth-firebase

[Firebase Authentication](https://firebase.google.com/docs/auth) ID tokens as Mayura server identities: verified as
Firebase specifies, with Google's published keys, on any runtime, with no dependency (no Admin SDK).

```bash
npm install mayura @mayurajs/auth-firebase
```

```ts
import { firebaseAuthenticator } from '@mayurajs/auth-firebase';

const authenticate = firebaseAuthenticator({
  projectId: 'acme-app-1234',
  identity: session => session.emailVerified && session.claims['agents'] === true ? {
    principalId: `firebase/${session.userId}`,
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate }); clients send `await user.getIdToken()` as the bearer token
```

- **What is checked.** As Firebase specifies: RS256, signed by Google's keys for Firebase ID tokens (fetched as a JWKS
  from `service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`, the same keys as the X.509 certificates
  Firebase's docs name, and kept for their max-age), issued by `https://securetoken.google.com/<projectId>` for your
  project, with `auth_time` in the past.
- **Users refused by default.** Anonymous users (`allowAnonymous` to accept them), and users of an Identity Platform
  tenant unless the tenant is in `tenants`; with `tenants` set, only users of those tenants.
- **What you get.** `identity` receives the user: `userId` (the uid), `email`, `emailVerified`, `phoneNumber`, `name`,
  `signInProvider`, `tenant`, `authTimeMs`, and the raw `claims`, among them custom claims your server set with the
  Admin SDK, which are safe to grant from. Nothing is granted unless `identity` grants it.
- **Revocation.** An ID token stays valid until it expires (an hour), even after its user is disabled or their tokens
  are revoked; checking that needs a call to Firebase per request, which this package does not make. Where it matters,
  compare `session.authTimeMs` with the revocation time you store when you revoke.
- Options: `projectId`, `identity`, `tenants`, `allowAnonymous`, `clockSkewMs` (5 s), `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
