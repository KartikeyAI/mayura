---
title: "ReqKey API keys"
description: "Accept API keys issued by ReqKey as Mayura server identities with @mayurajs/km-reqkey: every request validated with ReqKey, no cache, explicit grants."
package: "@mayurajs/km-reqkey"
vendor: "ReqKey"
logo: "reqkey"
website: "https://reqkey.com"
area: "keys"
---

[ReqKey](https://reqkey.com) issues API keys to your consumers, with credits and rate limits shared by each consumer's
keys and a list of the APIs each key may call. `@mayurajs/km-reqkey` lets Mayura's server accept those keys. It is a
`KeyVerifier` for `keyAuthenticator` from [`mayura/keys`](../guides/authentication.md#api-keys): each request's key is
validated with ReqKey for your API, and your `identity` callback decides what the key may do on your server. It talks to
ReqKey's HTTP API with `fetch`: no ReqKey SDK, no other dependencies, and it runs on every runtime Mayura runs on.

ReqKey is young (its first release was in July 2026); check its terms before depending on it.

## Install

```bash
npm install mayura @mayurajs/km-reqkey
```

## Credentials

The package needs two things from ReqKey (see [ReqKey's key API](https://reqkey.com/docs/api/keys)):

- **Your project's root key.** It is sent only to ReqKey, as a bearer token.
- **The id of the API**, registered in your ReqKey project, that requests to your server are for. Keys not allowed to
  call it are refused.

The package reads nothing from the environment: pass them in yourself, for example from `REQKEY_ROOT_KEY` and
`REQKEY_API_ID`.

## Use it

```ts
import { principalId } from 'mayura/auth';
import { keyAuthenticator } from 'mayura/keys';
import { reqkeyVerifier } from '@mayurajs/km-reqkey';

const keys = reqkeyVerifier({
  rootKey: process.env.REQKEY_ROOT_KEY ?? '',
  prefix: 'prod_', // your keys look like prod_...
  apiId: process.env.REQKEY_API_ID ?? '',
  identity: key => ({
    principalId: principalId('reqkey', key.consumerId),
    projectId: typeof key.metadata?.['org'] === 'string' ? key.metadata['org'] : 'default',
    agentIds: ['support'],
    capabilities: key.tag === 'read-only' ? ['runs:read'] : ['runs:submit', 'runs:read'],
  }),
});

export const authenticate = keyAuthenticator(keys, { cost: 1 });
// createAgentServer({ ..., authenticate })
```

Nothing is granted unless `identity` grants it. Here the key's consumer becomes the principal, an `org` in the key's
metadata becomes the project, and the key's tag decides its capabilities. A project id must use the server's allowed
characters (letters, digits, `.`, `_`, `/` and `-`); `principalId()` maps any subject to them. Combine it with other
callers' tokens with `chainAuthenticators`, as the [authentication guide](../guides/authentication.md) shows.

When ReqKey makes a key with a prefix, it adds `_` after it: keys created with prefix `prod` start with `prod_`, so pass
`prefix: 'prod_'`.

To see why a key is refused, call the verifier yourself:

```ts
import { reqkeyVerifier } from '@mayurajs/km-reqkey';

declare const keys: ReturnType<typeof reqkeyVerifier>;
const result = await keys.verify('prod_A1B2C3D4E5F6G7H8I9J0K1L2', { cost: 0 });
if (!result.ok) console.log(result.reason, result.retryAfterMs);
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `rootKey` | required | Your ReqKey project's root key. |
| `prefix` | required | The start of your keys, such as `prod_`: up to 32 letters, digits, `_` or `-`. Only tokens with it are sent to ReqKey. |
| `apiId` | required | The API, registered in ReqKey, that requests are for. |
| `identity` | required | Turns a validated key into a grant (`principalId`, `projectId`, `agentIds`, `capabilities`, optional `expiresAtMs`), or `null` to refuse it. May be async. |
| `timeoutMs` | 5 s | How long ReqKey may take to answer, 1 to 30 s. |
| `baseUrl` | `https://api.reqkey.com` | ReqKey's API: an `https` origin, or `http` only on `localhost`, `127.0.0.1` or `[::1]`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

`keyAuthenticator(keys, { cost, maxIdentityMs })` takes `cost`, the credits each request spends (1 by default, 0 to
check without spending), and `maxIdentityMs`, the longest an identity lasts (60 s by default).

## What is checked per request

1. **The token's shape.** Only a token that is your `prefix` followed by 16 to 256 letters and digits is sent to ReqKey.
   Anything else is `malformed` without a request, and `keyAuthenticator` passes it on to the next authenticator in a
   chain.
2. **ReqKey's validation and details, at the same time.** `POST /key/validate` with the key, your `apiId` and the
   request's `cost` in credits answers whether the key may call your API, spending the credits from its consumer.
   `POST /key/details` with the key reads its key and consumer ids. The details are used only when the key is valid;
   otherwise they are discarded unread. Redirects are not followed.
3. **Mayura's own checks.** A key ReqKey validated for another API than yours is refused, and the details must name the
   key and its consumer.
4. **Your `identity` callback** receives what ReqKey knows about the key and returns a grant or `null`.

The identity's expiry is the soonest of the key's expiry, the grant's `expiresAtMs` and `maxIdentityMs` from now. An
event stream never outlives it.

### What `identity` receives

| Field | Meaning |
| --- | --- |
| `keyId` | The key's ReqKey id. |
| `consumerId` | The consumer the key belongs to. Its credits and rate limits are shared by its keys. |
| `apiId` | The API the key was validated for: your `apiId`. |
| `allowedApis` | Every API the key may call. |
| `tag` | The key's tag, or `null`. |
| `metadata` | The key's metadata, or `null`. |
| `expiresAtMs` | When the key expires, or `null`. |
| `remaining` | The consumer's credits left after this validation, or `null` for unlimited consumers. |
| `limit` | The consumer's credit limit, or `null`. |

## Caching

There is no cache: every request asks ReqKey, so a key disabled or deleted there is refused on the next request. Each
authenticated request makes two calls to ReqKey, side by side, within your `timeoutMs`.

## Refusals

A refused key is not an error: `verify` returns `{ ok: false, reason }`, and `keyAuthenticator` makes the server answer
401 `AUTH_INVALID`.

| `reason` | When |
| --- | --- |
| `malformed` | The token does not look like one of your keys. No request is made. |
| `not_found` | ReqKey answered that the key is not valid. |
| `exhausted` | ReqKey answered 402: the consumer is out of credits. |
| `forbidden` | ReqKey answered 403 (the key is disabled or not allowed to call your API), or validated it for another API, or `identity` returned `null`. |
| `rate_limited` | ReqKey answered 429. `retryAfterMs` comes from its `Retry-After` header, when that is a number of seconds. |

## When ReqKey cannot answer

`verify` throws a `MayuraError`, and the server answers 503 `AUTH_UNAVAILABLE`, never letting the request through:

| `code` | When |
| --- | --- |
| `TOOL_FAILED` | ReqKey could not be reached, did not answer within `timeoutMs`, answered validation or details with another HTTP status (such as 401 for a root key it refuses), or gave an answer Mayura does not know. |
| `CANCELLED` | The request's signal was aborted. |
| `INVALID_INPUT` | `cost` is not a whole number of credits. |

Neither the root key nor the caller's key is ever in an error message. Configuration mistakes, such as a missing
`identity`, a malformed `apiId` or a `baseUrl` that is not `https`, fail with `INVALID_CONFIG` when you call
`reqkeyVerifier()`.

## How it is tested

- Unit tests run the verifier against a fake ReqKey (`/key/validate` and `/key/details`). They check both requests
  (URLs, root key header, no redirects, API id, credits), that only tokens with your prefix are sent, each refusal
  mapped to Mayura's reasons with `Retry-After`, keys validated for another API refused, that unread responses are
  released, defensive reading of ReqKey's answers, the sooner of the key's and grant's expiry, failures that never
  carry either key, cancellation, timeouts, another ReqKey address, and use through `keyAuthenticator`.
- `scripts/live/km-reqkey.mjs` passed against a real ReqKey project on October 6, 2026. It created a key for a consumer,
  allowed only your API, and checked that: the key verified for that API with a free check and a paid one, read with
  its consumer id, and the consumer's credits dropped by one for the paid check when ReqKey reported them; a verifier
  for another API refused the key; and an unknown key was refused as `not_found`. It then deleted the key.

## Related

- [Authentication and API keys](../guides/authentication.md#api-keys): Mayura's own keys and the `KeyVerifier`
  contract.
- [Unkey API keys](km-unkey.md): keys issued by Unkey.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): identities, capabilities and the
  server's authentication errors.
