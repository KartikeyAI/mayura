# @mayurajs/auth-cognito

[Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html)
user pool tokens as Mayura server identities: verified with the pool's published keys, on any runtime, with no
dependency (no AWS SDK).

```bash
npm install mayura @mayurajs/auth-cognito
```

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { cognitoAuthenticator } from '@mayurajs/auth-cognito';

const authenticate = cognitoAuthenticator({
  userPoolId: 'us-east-1_AbCdEf123',
  clientIds: ['1example23456789abcdefghij'],
  identity: session => ({
    principalId: principalId('cognito', session.subject),
    projectId: 'acme',
    agentIds: ['support'],
    capabilities: mapCapabilities(session.groups, { agents: ['runs:submit', 'runs:read'] }),
  }),
});
// createAgentServer({ ..., authenticate })
```

- **Which tokens.** RS256 tokens issued by the pool (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, the
  region read from the pool id), checked against its `/.well-known/jwks.json`, for one of your app clients. Access
  tokens by default (`token_use` `access`, the client in `client_id`); with `tokenUse: 'id'`, ID tokens instead (the
  client in `aud`). One is never accepted for the other.
- **Refused.** Machine tokens (client credentials: no user name, the client as subject) unless `allowMachines`.
  Cognito can revoke tokens (sign-out, revoked refresh tokens) that still verify until they expire: keep access tokens
  short-lived.
- **What you get.** `identity` receives the session: `tokenUse`, `subject` (`sub`, the stable key), `username`,
  `clientId`, `machine`, `groups` (`cognito:groups`), `scopes` (access tokens), `email` and `emailVerified` (ID
  tokens), and the raw `claims`. Nothing is granted unless `identity` grants it.
- Options: `userPoolId`, `clientIds`, `identity`, `tokenUse` (`access`), `allowMachines`, `clockSkewMs` (5 s),
  `maxIdentityMs` (60 s), `fetch`.

See [Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
