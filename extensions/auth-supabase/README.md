# @mayurajs/auth-supabase

[Supabase Auth](https://supabase.com/docs/guides/auth) access tokens as Mayura server identities: verified with your
project's published keys, on any runtime, with no dependency.

```bash
npm install mayura @mayurajs/auth-supabase
```

```ts
import { principalId } from 'mayura/auth';
import { supabaseAuthenticator } from '@mayurajs/auth-supabase';

const authenticate = supabaseAuthenticator({
  projectUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  identity: session => session.appMetadata['plan'] === 'pro' ? {
    principalId: principalId('supabase', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  } : null,
});
// createAgentServer({ ..., authenticate }); clients send `session.access_token` as the bearer token
```

- **What is checked.** Tokens issued by your project (`<projectUrl>/auth/v1`) for signed-in users (audience
  `authenticated`), signed with its asymmetric keys (ES256 or RS256) from `/auth/v1/.well-known/jwks.json`, kept at
  most 10 minutes as Supabase asks. Give `jwtSecret` only while tokens may still be signed with your project's legacy
  secret (HS256); the asymmetric keys keep working alongside it.
- **Roles.** Only `authenticated` tokens pass by default (`roles`), so the public anon key and `service_role` tokens
  never act as a user. Anonymous users (`is_anonymous`) are refused unless `allowAnonymous`; `requireAal2` accepts only
  users who signed in with a second factor.
- **What you get.** `identity` receives the user: `userId`, `email`, `phone`, `role`, `aal`, `sessionId`, `anonymous`,
  `appMetadata`, `userMetadata`, and the raw `claims`. Grant from `appMetadata` (set by your server), never from
  `userMetadata`, which users can change themselves. Nothing is granted unless `identity` grants it.
- **Signing out.** A Supabase access token stays valid until it expires (an hour by default), even after the user signs
  out. Where that matters, check `session.sessionId` against `auth.sessions` in `identity`, or keep tokens short.
- Options: `projectUrl`, `identity`, `jwtSecret`, `roles`, `audience`, `allowAnonymous`, `requireAal2`, `clockSkewMs`
  (5 s), `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
