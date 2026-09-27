import { createHmac } from 'node:crypto';

/**
 * The webhook contract between the tracker and this service. The tracker sends three headers with every POST:
 *
 *   x-tracker-delivery   a unique id per delivery (retries of one delivery reuse it)
 *   x-tracker-timestamp  when it signed, in milliseconds since the Unix epoch
 *   x-tracker-signature  sha256=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body bytes>" with the shared secret>
 *
 * The id and timestamp are inside the signature, so neither can be changed without the secret. Adapt the header names
 * to your tracker in src/ingress.ts; keep the signed material as the Mayura webhook runtime expects it.
 */
export const webhookHeaders = { delivery: 'x-tracker-delivery', timestamp: 'x-tracker-timestamp', signature: 'x-tracker-signature' } as const;

export function signDelivery(secret: string, delivery: { readonly deliveryId: string; readonly timestampMs: number; readonly body: string | Uint8Array }): string {
  return `sha256=${createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${delivery.timestampMs}.${delivery.deliveryId}.`).update(delivery.body).digest('hex')}`;
}

/** Sign and POST one delivery the way the tracker does. Used by `npm run dev`, `npm run send-sample` and the tests. */
export async function sendDelivery(url: string, secret: string, delivery: { readonly deliveryId: string; readonly event: unknown; readonly timestampMs?: number }):
  Promise<{ readonly status: number; readonly body: unknown }> {
  const body = JSON.stringify(delivery.event); const timestampMs = delivery.timestampMs ?? Date.now();
  const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(30_000), headers: {
    'content-type': 'application/json', [webhookHeaders.delivery]: delivery.deliveryId, [webhookHeaders.timestamp]: String(timestampMs),
    [webhookHeaders.signature]: signDelivery(secret, { deliveryId: delivery.deliveryId, timestampMs, body }) } });
  const text = await response.text();
  let parsed: unknown = text; try { parsed = JSON.parse(text); } catch { /* keep the text */ }
  return { status: response.status, body: parsed };
}
