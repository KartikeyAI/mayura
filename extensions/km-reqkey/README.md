# @mayurajs/km-reqkey

API keys issued by [ReqKey](https://reqkey.com/docs/api/keys) as Mayura server identities: each key is validated with
ReqKey's API, on any runtime, with no dependency (no ReqKey SDK).

```bash
npm install mayura @mayurajs/km-reqkey
```

```ts
import { keyAuthenticator } from 'mayura/keys';
import { reqkeyVerifier } from '@mayurajs/km-reqkey';

const keys = reqkeyVerifier({
  rootKey: process.env.REQKEY_ROOT_KEY!,
  prefix: 'prod_',
  apiId: 'api_agents', // the API, registered in ReqKey, that requests are for
  identity: key => ({
    principalId: `reqkey/${key.consumerId}`,
    projectId: typeof key.metadata?.['org'] === 'string' ? key.metadata['org'] : key.consumerId,
    agentIds: ['support'],
    capabilities: ['runs:submit', 'runs:read'],
  }),
});
// createAgentServer({ ..., authenticate: keyAuthenticator(keys, { cost: 1 }) })
```

- **Which keys.** Only tokens shaped like your keys (starting with `prefix`) are sent to ReqKey; anything else is
  refused without a request. Each key is validated for `apiId` (`/key/validate`), so keys not allowed to call that API
  are refused, and the request's cost is spent from the key's consumer's credits. Its details (`/key/details`) are read
  at the same time for the key and consumer ids, and used only when the key is valid.
- **Refusals.** A key ReqKey does not know is `not_found`; out of credits (402) is `exhausted`; disabled or not allowed
  this API (403) is `forbidden`; rate limited (429) is `rate_limited`, with ReqKey's `Retry-After`. A key validated for
  another API than asked is refused.
- **No cache.** Every request asks ReqKey, so a key disabled there is refused at once. When ReqKey cannot be reached or
  answers with an error (such as a root key it refuses), the server answers that authentication is unavailable;
  neither the root key nor the caller's key is ever in an error.
- **What you get.** `identity` receives the key: `keyId`, `consumerId` (credits and rate limits are the consumer's,
  shared by its keys), `apiId`, `allowedApis`, `tag`, `metadata`, `expiresAtMs`, and the consumer's `remaining`
  credits and `limit`. Nothing is granted unless `identity` grants it. The grant lasts no longer than the key.
- Options: `rootKey`, `prefix`, `apiId`, `identity`, `timeoutMs` (5 s), `baseUrl`, `fetch`.

ReqKey is young (its first release was in July 2026); check its terms before depending on it. See
[Authentication and API keys](https://mayurajs.com/docs/guides/authentication/). Apache-2.0.
