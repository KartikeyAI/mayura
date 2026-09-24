import { createWebhookRuntime, defineWebhookTrigger, type WebhookDeliverySnapshot } from '@mayura/workstream/webhooks';
import type { Schema } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage-contracts';

interface Input { readonly action: string }
const schema = {} as Schema<Input, Input>;

/** Public webhook types work with a driver-free custom aggregate adapter. */
async function consume(store: AggregateStore): Promise<void> {
  const trigger = defineWebhookTrigger({ id: 'deploy', version: '1', secretId: 'secret', schemaId: 'deploy-v1', schemaDigest: 'a'.repeat(64), input: schema,
    dispatch: input => ({ accepted: input.action }) });
  const runtime = createWebhookRuntime({ store, scope: { principalId: 'consumer', projectId: 'app' }, resolveSecret: async () => new Uint8Array(32) });
  const result: WebhookDeliverySnapshot = await runtime.receive(trigger, { deliveryId: 'delivery', timestampMs: 1, body: new Uint8Array(), signature: `sha256=${'0'.repeat(64)}` });
  await runtime.inspect(result.id); await runtime.recoverAbandoned(result.id); await runtime.events(result.id, 0); runtime.close();
  // @ts-expect-error Delivery snapshots are immutable.
  result.status = 'succeeded';
  // @ts-expect-error Signatures use an explicit string envelope.
  await runtime.receive(trigger, { deliveryId: 'bad', timestampMs: 1, body: new Uint8Array(), signature: 1 });
}
void consume;
