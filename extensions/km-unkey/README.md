# @mayurajs/km-unkey

API keys issued by [Unkey](https://www.unkey.com/docs/api-management/keys/verifying-keys) as Mayura server identities:
each key is verified with Unkey's API, on any runtime, with no dependency (no Unkey SDK).

```bash
npm install mayura @mayurajs/km-unkey
```

```ts
import { mapCapabilities } from 'mayura/auth';
import { keyAuthenticator } from 'mayura/keys';
import { unkeyVerifier } from '@mayurajs/km-unkey';

const keys = unkeyVerifier({
  rootKey: process.env.UNKEY_ROOT_KEY!, // allowed api.*.verify_key, or api.<id>.verify_key
  prefix: 'sk',
  keyspaces: ['ks_...'], // your API's keyspace
  permissions: 'agents.use', // optional: checked by Unkey before rate limits and credits
  identity: key => key.identity ? {
    principalId: `unkey/${key.identity.externalId}`,
    projectId: key.identity.externalId,
    agentIds: ['support'],
    capabilities: mapCapabilities(key.permissions, { 'agents.use': ['runs:submit', 'runs:read'] }),
  } : null,
});
// createAgentServer({ ..., authenticate: keyAuthenticator(keys, { cost: 1 }) })
```

- **Which keys.** Only tokens shaped like your keys (`<prefix>_...`) are sent to Unkey; anything else (a JWT, another
  provider's key) is refused without a request. Unkey checks the key with `keys.verifyKey`, limited to `keyspaces`, so
  keys of your other APIs are refused, and spends the request's cost in credits.
- **Refusals.** Unkey's outcomes become Mayura's: `NOT_FOUND` is `not_found`; `DISABLED` and `EXPIRED` keep their names;
  `FORBIDDEN` and `INSUFFICIENT_PERMISSIONS` are `forbidden`; `RATE_LIMITED` is `rate_limited`, with the time until the
  soonest exceeded limit resets; `USAGE_EXCEEDED` is `exhausted`. Any outcome Mayura does not know is refused.
- **Spending.** Unkey checks permissions before rate limits and credits, so with `permissions` a key without them
  spends nothing. A key that `identity` refuses has already spent its cost.
- **No cache.** Every request asks Unkey, so a key revoked or disabled there is refused at once. When Unkey cannot be
  reached or answers with an error (such as a root key it refuses), the server answers that authentication is
  unavailable; neither the root key nor the caller's key is ever in an error.
- **What you get.** `identity` receives the key: `keyId`, `keyspaceId`, `name`, `meta`, `permissions`, `roles`,
  `identity` (`id`, `externalId`, `meta`), `expiresAtMs` and `remaining` credits. Nothing is granted unless
  `identity` grants it. The grant lasts no longer than the key.
- Options: `rootKey`, `prefix`, `keyspaces`, `identity`, `permissions`, `timeoutMs` (5 s), `baseUrl` (for a
  self-hosted Unkey), `fetch`.

Mayura's own keys (`mayura/keys`) are stored as Unkey stores them (SHA-256), so they can move to Unkey later. See
[Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
