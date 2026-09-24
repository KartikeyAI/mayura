# Use authenticated webhook triggers

Install the driver-free workstream and core/storage contracts, then select a storage adapter separately.

```ts
import { createWebhookRuntime, defineWebhookTrigger } from '@mayura/workstream/webhooks';

const deploy = defineWebhookTrigger({
  id: 'deploy',
  version: '1.0.0',
  secretId: 'deploy-webhook-v1',
  schemaId: 'deploy-input-v1',
  schemaDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  input: deployInputSchema,
  dispatch: async (input, { deliveryId, commandId, signal }) => {
    return submitDeployment({ input, deliveryId, idempotencyKey: commandId, signal });
  },
});

const webhooks = createWebhookRuntime({
  store, // already initialized; ownership remains with the application
  scope: verifiedScope,
  resolveSecret: ({ secretId, signal }) => secretStore.readBytes(secretId, { signal }),
});

const result = await webhooks.receive(deploy, {
  deliveryId: headers.deliveryId,
  timestampMs: Number(headers.timestampMs),
  signature: headers.signature,
  body: rawRequestBytes,
});
```

Preserve the exact raw request bytes; parsing and reserialization before verification changes the signature. Return a success response for both a newly completed delivery and an identical persisted retry. Treat `outcome_unknown` as an operator reconciliation condition, never as permission to replay the effect.

After restart, inspect known delivery IDs. If a delivery is still `dispatching` and no authoritative provider reconciliation can prove the outcome, call `recoverAbandoned(id)`. The stable `commandId` passed to dispatch should also be used as the downstream provider idempotency key when that provider supports one.

Expose this runtime through an authenticated, rate-limited HTTPS route. The application must choose the trigger and scope from trusted routing/authentication state rather than request JSON. Configure secret rotation, retention, monitoring and provider-specific error responses outside this package.
