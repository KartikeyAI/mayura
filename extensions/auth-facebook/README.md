# @mayurajs/auth-facebook

Facebook sign-in for Mayura, on any runtime, with no dependency:

- `facebookAuthenticator`: Facebook Login user access tokens sent straight to Mayura's server, checked with Facebook,
  and iOS Limited Login tokens, checked with Facebook's keys;
- `facebookSignIn`: Facebook as a better-auth social login (with `mayura/auth/better-auth`), reading no more of the
  profile than signing in needs.

```bash
npm install mayura @mayurajs/auth-facebook
```

```ts
import { principalId } from 'mayura/auth';
import { facebookAuthenticator, facebookSignIn } from '@mayurajs/auth-facebook';

const authenticate = facebookAuthenticator({
  appId: process.env.FACEBOOK_APP_ID!,
  appSecret: process.env.FACEBOOK_APP_SECRET!,
  requiredScopes: ['email'],
  identity: session => ({
    principalId: principalId('facebook', session.userId),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  }),
});

// Or sign people in with better-auth:
// betterAuth({ socialProviders: { facebook: facebookSignIn({ clientId, clientSecret }) }, ... })
```

- **Access tokens are opaque**, so each one is checked with Facebook's `debug_token` (Graph API `v26.0` unless
  `graphVersion`), using your app's token (`appId|appSecret`, which never leaves your server and never appears in an
  error). A token passes only when Facebook says it is valid, a user's, for your app, unexpired, and holds every
  `requiredScopes` permission. That is a call to Facebook per request: `cacheTtlMs` (up to 5 minutes, 0 by default)
  keeps Facebook's answer for that long, so a token the user revokes then works for that long more. A call takes at
  most `timeoutMs` (5 s); when Facebook cannot answer, the server answers that authentication is unavailable.
- **Limited Login** (with `limitedLogin: true`): iOS Limited Login tokens are OIDC JWTs, checked with no call per
  request: RS256 with Facebook's keys, issued by `https://www.facebook.com`, for your app. Check the token's `nonce`
  in your app, which made it.
- **What you get.** `identity` receives `kind` (`access_token` or `limited_login`), `userId` (app-scoped: the same
  person has a different id in each of your apps), `scopes`, `email` and `name` (Limited Login), and `expiresAtMs`.
  Nothing is granted unless `identity` grants it.
- **`facebookSignIn`** gives better-auth's `socialProviders.facebook` reading only `id`, `name` and `email` (`picture`
  if asked), with no permissions beyond better-auth's `email` and `public_profile` unless you add `scopes`.
- Options: `facebookAuthenticator({ appId, appSecret, identity, requiredScopes, limitedLogin, cacheTtlMs, timeoutMs,
  graphVersion, clockSkewMs, maxIdentityMs, fetch })`, `facebookSignIn({ clientId, clientSecret, picture, scopes })`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
