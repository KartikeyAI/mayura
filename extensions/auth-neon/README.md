# @mayurajs/auth-neon

[Neon Auth](https://neon.com/docs/auth/overview) (Neon's managed better-auth) JWTs as Mayura server identities:
verified with your project's published keys, on any runtime, with no dependency.

```bash
npm install mayura @mayurajs/auth-neon
```

```ts
import { principalId } from 'mayura/auth';
import { neonAuthAuthenticator } from '@mayurajs/auth-neon';

const authenticate = neonAuthAuthenticator({
  authUrl: process.env.NEON_AUTH_BASE_URL!, // https://ep-xxx.neonauth.us-east-1.aws.neon.tech/neondb/auth
  identity: session => session.emailVerified ? {
    principalId: principalId('neon', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate })
```

- **What is checked.** EdDSA (Ed25519) tokens whose issuer and audience are your Neon Auth URL's origin, as Neon
  issues them, signed with the keys at `<authUrl>/.well-known/jwks.json`. A user who is banned (`banned`, with no
  `banExpires` or one still ahead) is refused.
- **What you get.** `identity` receives the user: `userId`, `email`, `emailVerified`, `name`, `role`, and the raw
  `claims`. Nothing is granted unless `identity` grants it.
- **Getting a token.** In your app, Neon's client gives the JWT with `authClient.token()`, or in the `set-auth-jwt`
  header of `getSession()`; send it to Mayura's server as a bearer token. Tokens last 15 minutes.
- Applications still on the earlier Stack Auth-based Neon Auth use `@mayurajs/auth-hexclave`.
- Options: `authUrl`, `identity`, `clockSkewMs` (5 s), `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
