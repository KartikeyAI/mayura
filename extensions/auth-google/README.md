# @mayurajs/auth-google

Google sign-in for Mayura, two ways, on any runtime, with no dependency:

- `googleAuthenticator`: Google ID tokens sent straight to Mayura's server, checked as Google advises;
- `googleSignIn`: Google as a better-auth social login (with `mayura/auth/better-auth`), asking no more than signing in
  needs.

```bash
npm install mayura @mayurajs/auth-google
```

```ts
import { principalId } from 'mayura/auth';
import { googleAuthenticator, googleSignIn } from '@mayurajs/auth-google';

// ID tokens sent as bearer tokens (from Google Identity Services, or a mobile app's Google sign-in):
const authenticate = googleAuthenticator({
  clientIds: ['1234567890-abc.apps.googleusercontent.com'],
  hostedDomain: 'acme.com', // only Workspace accounts of acme.com
  identity: session => ({
    principalId: principalId('google', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  }),
});

// Or sign people in with better-auth:
// betterAuth({ socialProviders: { google: googleSignIn({ clientId, clientSecret, hostedDomain: 'acme.com' }) }, ... })
```

- **ID tokens.** RS256 with Google's keys (`oauth2/v3/certs`, kept for their max-age), issued by `accounts.google.com`
  (Google writes it with and without `https://`) for one of your `clientIds`. With `hostedDomain`, only accounts of
  that Workspace domain (`hd`) pass, or with `*` any Workspace account; consumer accounts carry no `hd`.
- **What you get.** `identity` receives the account: `userId` (`sub`, the stable id: Google advises against keying
  users on email), `email`, `emailVerified`, `hostedDomain`, `name`, `picture`, `authorizedParty`, and the raw
  `claims`. Nothing is granted unless `identity` grants it.
- **`googleSignIn`** gives better-auth's `socialProviders.google` with online access (no refresh token) unless
  `offline`, only this sign-in's scopes (`includeGrantedScopes: false`) plus any `scopes` you add, and `hd` from
  `hostedDomain`, which better-auth enforces against the returned token.
- Options: `googleAuthenticator({ clientIds, identity, hostedDomain, clockSkewMs, maxIdentityMs, fetch })`,
  `googleSignIn({ clientId, clientSecret, hostedDomain, offline, scopes })`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
