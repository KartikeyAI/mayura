---
title: "Unkey API keys"
description: "Accept API keys issued by Unkey as Mayura server identities with @mayurajs/km-unkey: every request verified with Unkey, no cache, explicit grants."
package: "@mayurajs/km-unkey"
vendor: "Unkey"
logo: "unkey"
website: "https://www.unkey.com"
area: "keys"
---

[Unkey](https://www.unkey.com) issues and manages API keys for your users: rate limits, credits, permissions and roles,
expiry and revocation. `@mayurajs/km-unkey` lets Mayura's server accept those keys. It is a `KeyVerifier` for
`keyAuthenticator` from [`mayura/keys`](../guides/authentication.md#api-keys): each request's key is verified with
Unkey's `keys.verifyKey`, and your `identity` callback decides what the key may do on your server. It talks to Unkey's
HTTP API with `fetch`: no Unkey SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/km-unkey
```

## Credentials

The package needs two things from Unkey:

- **A root key** allowed to verify keys: `api.*.verify_key`, or `api.<id>.verify_key` for one API. Create it in the
  [Unkey dashboard](https://app.unkey.com) under your workspace's root keys. It needs no other permission, and it is
  sent only to Unkey, as a bearer token.
- **The keyspace id** (`ks_...`) of the API your keys belong to. Keys of any other keyspace are refused.

The package reads nothing from the environment: pass them in yourself, for example from `UNKEY_ROOT_KEY` and
`UNKEY_KEYSPACE_ID`.

## Use it

```ts
import { mapCapabilities, principalId } from 'mayura/auth';
import { keyAuthenticator } from 'mayura/keys';
import { unkeyVerifier } from '@mayurajs/km-unkey';

const keys = unkeyVerifier({
  rootKey: process.env.UNKEY_ROOT_KEY ?? '',
  prefix: 'sk', // your keys look like sk_...
  keyspaces: [process.env.UNKEY_KEYSPACE_ID ?? ''],
  permissions: 'agents.use', // checked by Unkey before rate limits and credits
  identity: key => key.identity ? {
    principalId: principalId('unkey', key.identity.externalId),
    projectId: key.identity.externalId,
    agentIds: ['support'],
    capabilities: mapCapabilities(key.permissions, { 'agents.use': ['runs:submit', 'runs:read'] }),
  } : null,
});

export const authenticate = keyAuthenticator(keys, { cost: 1 });
// createAgentServer({ ..., authenticate })
```

Nothing is granted unless `identity` grants it. Here a key must be linked to an Unkey identity, whose `externalId` (your
customer or organization id) becomes the project; the key's Unkey permissions map to server capabilities through an
explicit table, and anything not in the table grants nothing. A project id must use the server's allowed characters
(letters, digits, `.`, `_`, `/` and `-`); `principalId()` maps any subject to them. Combine it with other callers' tokens
with `chainAuthenticators`, as the [authentication guide](../guides/authentication.md) shows.

To see why a key is refused, call the verifier yourself:

```ts
import { unkeyVerifier } from '@mayurajs/km-unkey';

declare const keys: ReturnType<typeof unkeyVerifier>;
const result = await keys.verify('sk_3ZbXq9wYk2LmNpQrStUv', { cost: 0 });
if (!result.ok) console.log(result.reason, result.retryAfterMs);
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `rootKey` | required | An Unkey root key allowed to verify keys. |
| `prefix` | required | Your keys' prefix, such as `sk` for `sk_...`: 1 to 16 letters, digits or underscores. Only tokens with it are sent to Unkey. |
| `keyspaces` | required | 1 to 5 keyspace ids (`ks_...`) whose keys are accepted. |
| `identity` | required | Turns a verified key into a grant (`principalId`, `projectId`, `agentIds`, `capabilities`, optional `expiresAtMs`), or `null` to refuse it. May be async. |
| `permissions` | none | A permission query every key must satisfy, such as `agents.use`, up to 1,000 characters. |
| `timeoutMs` | 5 s | How long Unkey may take to answer, 1 to 30 s. |
| `baseUrl` | `https://api.unkey.com` | Unkey's API, for a self-hosted Unkey: an `https` origin, or `http` only on `localhost`, `127.0.0.1` or `[::1]`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

`keyAuthenticator(keys, { cost, maxIdentityMs })` takes `cost`, the credits each request spends (1 by default, 0 to
check without spending), and `maxIdentityMs`, the longest an identity lasts (60 s by default).

## What is checked per request

1. **The token's shape.** Only a token that is your `prefix`, `_`, then 8 to 500 letters and digits is sent to Unkey.
   Anything else (a JWT, another provider's key) is `malformed` without a request, and `keyAuthenticator` passes it on
   to the next authenticator in a chain.
2. **Unkey's verification.** One `POST /v2/keys.verifyKey` with the key, your `keyspaces`, the request's `cost` in
   credits and your `permissions` query. Unkey checks that the key exists in those keyspaces, is enabled and unexpired,
   satisfies the permission query, is within its rate limits and has the credits, and spends them. Redirects are not
   followed.
3. **Mayura's own checks.** The answer must name the key and a keyspace from your list; otherwise the key is refused.
4. **Your `identity` callback** receives what Unkey knows about the key and returns a grant or `null`.

The identity's expiry is the soonest of the key's expiry, the grant's `expiresAtMs` and `maxIdentityMs` from now. An
event stream never outlives it.

### What `identity` receives

| Field | Meaning |
| --- | --- |
| `keyId` | The key's Unkey id. |
| `keyspaceId` | The keyspace it belongs to: one of `keyspaces`. |
| `name` | The key's name, or `null`. |
| `meta` | The key's metadata, or `null`. |
| `permissions` | Every permission the key holds, directly or through its roles. |
| `roles` | The key's roles. |
| `identity` | The Unkey identity the key is linked to (`id`, `externalId`, `meta`), or `null`. |
| `expiresAtMs` | When the key expires, or `null`. |
| `remaining` | Credits left after this verification, or `null` for keys without credits. |

## Caching

There is no cache: every request asks Unkey, so a key revoked, disabled or deleted there is refused on the next
request. Each authenticated request costs one call to Unkey, within your `timeoutMs`.

## Credits and spending

Each request spends `cost` credits on keys that have credits, through Unkey. Unkey checks permissions before rate limits
and credits, so with `permissions` set, a key without them spends nothing. A key that `identity` refuses has already
spent its cost, since Unkey charges before your callback runs.

## Refusals

A refused key is not an error: `verify` returns `{ ok: false, reason }`, and `keyAuthenticator` makes the server answer
401 `AUTH_INVALID`.

| `reason` | When |
| --- | --- |
| `malformed` | The token does not look like one of your keys. No request is made. |
| `not_found` | Unkey does not know the key in your keyspaces (`NOT_FOUND`). |
| `disabled` | The key is disabled (`DISABLED`). |
| `expired` | The key has expired (`EXPIRED`). |
| `forbidden` | Unkey answered `FORBIDDEN` or `INSUFFICIENT_PERMISSIONS`, or an outcome Mayura does not know; or the answer named no key or another keyspace; or `identity` returned `null`. |
| `rate_limited` | A rate limit was exceeded (`RATE_LIMITED`). `retryAfterMs` is the time until the soonest exceeded limit resets, when Unkey says. |
| `exhausted` | The key is out of credits (`USAGE_EXCEEDED`). |

## When Unkey cannot answer

`verify` throws a `MayuraError`, and the server answers 503 `AUTH_UNAVAILABLE`, never letting the request through:

| `code` | When |
| --- | --- |
| `TOOL_FAILED` | Unkey could not be reached, did not answer within `timeoutMs`, answered with an HTTP error (such as a root key it refuses), or gave an answer Mayura does not know. |
| `CANCELLED` | The request's signal was aborted. |
| `INVALID_INPUT` | `cost` is not a whole number of credits. |

Neither the root key nor the caller's key is ever in an error message. Configuration mistakes, such as a missing
`identity`, a keyspace id that is not `ks_...` or a `baseUrl` that is not `https`, fail with `INVALID_CONFIG` when you
call `unkeyVerifier()`.

## How it is tested

- Unit tests run the verifier against a fake Unkey `keys.verifyKey`. They check the request (URL, root key header, no
  redirects, keyspaces, credits, permission query), that only tokens with your prefix are sent, every Unkey outcome
  mapped to Mayura's reasons, `retryAfterMs` from the soonest exceeded limit, keys from other keyspaces refused,
  defensive reading of Unkey's answer, the sooner of the key's and grant's expiry, failures that never carry either key,
  cancellation, timeouts, a self-hosted URL, and use through `keyAuthenticator`.
- `scripts/live/km-unkey.mjs` passed against a real Unkey workspace on October 6, 2026. It created a key with 2 credits
  and checked that: the key verified, with its identity and the credits left; a check with cost 0 spent nothing, and
  the key was refused as `exhausted` once its last credit was spent; the key checked against a keyspace it is not in,
  and an unknown key, were refused as `not_found`; and a permission query the key did not meet was refused as
  `forbidden`. It then deleted the key.

## Related

- [Authentication and API keys](../guides/authentication.md#api-keys): Mayura's own keys and the `KeyVerifier`
  contract. Mayura's own keys are stored as SHA-256, as Unkey stores them, so they can move to Unkey later.
- [ReqKey API keys](km-reqkey.md): keys issued by ReqKey.
- [Server and client](../guides/server-and-client.md#authentication-and-capabilities): identities, capabilities and the
  server's authentication errors.
