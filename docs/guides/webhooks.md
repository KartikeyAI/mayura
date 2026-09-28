---
title: "Webhooks"
description: "Accept signed webhook deliveries, verify their HMAC signature and freshness, and start work exactly once per delivery."
---

Many systems announce events with webhooks: a ticket was created, a payment settled, a build finished. Senders retry,
so the same delivery can arrive several times, and anyone who finds your URL can post to it. `mayura/workstream/webhooks`
handles both problems. It checks an HMAC-SHA256 signature and a timestamp window, validates the JSON body against your
schema, records the delivery durably, and runs your `dispatch` function once per delivery id. A repeat of a delivery
gets the recorded answer instead of starting anything new.

It is transport-neutral: you receive the HTTP request with your own server and hand Mayura the raw bytes. The usual
`dispatch` submits a [durable workflow](durable-workflows.md) run.

## A complete example

```ts
import { createServer } from 'node:http';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWebhookRuntime, defineWebhookTrigger } from 'mayura/workstream/webhooks';
import { z } from 'zod';

const store = createSqliteStore({ filename: 'webhooks.sqlite' });
await store.initialize();

const ticketCreated = z.object({ ticket: z.object({ id: z.string(), title: z.string() }) });

const trigger = defineWebhookTrigger({
  id: 'tickets.created',
  version: '1',
  secretId: 'tracker',
  schemaId: 'tickets.created.v1',
  input: ticketCreated, // its JSON Schema's digest is pinned into every stored delivery
  // Runs once per new delivery, after verification. `commandId` is stable for the delivery.
  dispatch: async (event, { commandId }) => {
    console.log('new ticket', event.ticket.id);
    return { accepted: true, key: commandId };
  },
});

const webhooks = createWebhookRuntime({
  store,
  scope: { principalId: 'tracker-ingress', projectId: 'support' },
  resolveSecret: async () => new TextEncoder().encode(process.env.WEBHOOK_SECRET ?? ''),
});

createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    const delivery = await webhooks.receive(trigger, {
      deliveryId: String(request.headers['x-delivery-id']),
      timestampMs: Number(request.headers['x-timestamp']),
      signature: String(request.headers['x-signature']), // sha256=<hex>
      body: new Uint8Array(Buffer.concat(chunks)),
    });
    response.writeHead(delivery.status === 'succeeded' ? 202 : 500).end();
  } catch {
    response.writeHead(401).end(); // map error codes properly in production; see below
  }
}).listen(8081);
```

Set `WEBHOOK_SECRET` to at least 16 bytes, and configure the same secret in the sending system. Size limits, error
mapping and concurrency limits are up to your HTTP handler; the
[event-automation starter's ingress](https://github.com/KartikeyAI/mayura/blob/main/packages/cli/starters/event-automation/src/ingress.ts)
is a production version.

## The signature contract

The sender signs these bytes with HMAC-SHA256 and the shared secret:

```text
<timestamp in ms>.<delivery id>.<raw body bytes>
```

and sends the signature as `sha256=<64 lowercase hex characters>`. The timestamp and delivery id are inside the
signature, so neither can be changed without the secret. Header names are yours to choose; Mayura only sees the four
fields of `receive`. If your provider signs a different format, verify its signature yourself first; `receive` always
checks this format.

Pass the exact bytes you received. Parsing and re-serializing the JSON before verification changes the bytes and
breaks the signature.

## What `receive` checks, in order

1. The request is well formed: a simple delivery id, a timestamp, a `sha256=` signature, a body within `maxBodyBytes`.
2. The timestamp is within `maxClockSkewMs` of the runtime's clock (5 minutes by default), so a captured request goes
   stale.
3. The signature matches, compared in constant time, using the secret from `resolveSecret`.
4. The body is UTF-8 JSON that passes the trigger's `input` schema.
5. The delivery is recorded in the store, keyed by trigger and delivery id, and only then dispatched.

A request refused at any of these steps changes nothing, not even the delivery record.

## Duplicates and retries

- A repeat of a delivery that already succeeded returns the same snapshot, with the same `output`, and does not call
  `dispatch` again. Answer it with the same success status so the sender stops retrying.
- A retry may carry a fresh timestamp and signature. That is fine as long as the body is identical.
- The same delivery id with a different body is refused with `CONFLICT`.
- Pass `commandId` to whatever `dispatch` starts, as its idempotency key. For a workflow, use it in the
  `idempotencyKey` of `submit`, so even a dispatch retried after a crash finds the run it already started:

```ts
import type { WebhookDispatchContext } from 'mayura/workstream/webhooks';

// Use as the trigger's `dispatch`. `workflows` is a lifecycle fleet runtime, `intake` a workflow definition.
const dispatch = async (event: TicketCreated, { commandId }: WebhookDispatchContext) => {
  const run = await workflows.submit(intake, { input: event, idempotencyKey: `delivery:${commandId}` });
  return { runId: run.id };
};
```

## Delivery statuses

`receive` returns a snapshot with `status`:

| Status | Meaning | Typical HTTP answer |
|---|---|---|
| `succeeded` | `dispatch` returned; `output` holds its JSON result. | 202 |
| `outcome_unknown` | `dispatch` threw or timed out part-way. It is never retried automatically. | 500 |
| `dispatching` | Another request or process is dispatching this delivery right now, or crashed while doing so. | 503 with `retry-after` |

Errors thrown by `receive` carry a `code`: `PERMISSION_DENIED` (bad signature, stale timestamp or no secret),
`INVALID_INPUT` (malformed request or body that fails the schema), `CONFLICT` (delivery id reused with a different
body), `LIMIT_EXCEEDED` (too many callbacks in flight) and `STORAGE_UNAVAILABLE`. Map them to 401, 400, 409, 503 and
503.

A delivery stuck in `dispatching` because a process died stays that way. After checking whether its work happened,
call `webhooks.recoverAbandoned(snapshot.id)` to mark it `outcome_unknown`. `inspect(id)` and `events(id)` read a
delivery by the `id` in its snapshot.

## Options

`defineWebhookTrigger`:

| Option | Meaning |
|---|---|
| `id`, `version` | The trigger's identity. Change `version` when the payload contract changes. |
| `secretId` | Passed to `resolveSecret`, so one runtime can serve several senders. |
| `schemaId`, `schemaDigest` | A name and a 64-hex SHA-256 that pin the payload contract into every stored delivery. Leave `schemaDigest` out to derive it from `input` when that validator can describe itself as JSON Schema (Zod 4.2 and later can); `schemaDigest(jsonSchema)` from `mayura/workstream/webhooks` computes it for any other. |
| `input` | The schema the parsed body must pass. `dispatch` receives the validated value. |
| `dispatch` | Your handler. Receives the input and `{ deliveryId, commandId, signal }`, returns JSON. |

`createWebhookRuntime`:

| Option | Default | Meaning |
|---|---|---|
| `store`, `scope` | required | An initialized store and the scope deliveries are recorded under. |
| `resolveSecret` | required | Returns the secret bytes (16 to 4,096) for `{ triggerId, secretId, signal }`. Read your secret manager here to rotate without a restart. |
| `maxClockSkewMs` | 300,000 | Accepted distance between the delivery timestamp and now. At most 1 hour. |
| `maxBodyBytes` | 1 MiB | Largest body accepted. At most 1 MiB. |
| `callbackTimeoutMs` | 30,000 | Time limit for `resolveSecret`, schema validation and `dispatch`. |
| `maxPendingCallbacks` | 32 | Callbacks in flight at once; beyond it, `receive` fails with `LIMIT_EXCEEDED`. |
| `now` | `Date.now` | The clock, for tests. |

## Good to know

- Deduplication is by delivery id. If a sender sends the same event under two ids, `dispatch` runs twice; make its
  effects idempotent on a business key too.
- Keep `dispatch` short: record the event or submit a workflow, and do the real work in the workflow. Anything that
  fails part-way inside `dispatch` becomes `outcome_unknown`.
- Rate limiting per sender, TLS and routing belong in your server or proxy. Choose the trigger and scope from your
  route, never from the request body.

## Related

- [Durable workflows](durable-workflows.md)
- [Workflows](../concepts/workflows.md)
- [Storage](storage.md)
- [Deployment](deployment.md)
