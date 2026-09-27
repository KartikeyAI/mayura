// Your order system, seen from support. The only way in is "the orders of this customer": there is no lookup by order
// id alone, so a tool cannot fetch someone else's order even by mistake.

export type OrderStatus = 'processing' | 'shipped' | 'delivered';
export interface TrackingEvent { readonly at: string; readonly description: string }
export interface Order {
  readonly orderId: string;
  readonly placedAt: string;
  readonly status: OrderStatus;
  readonly items: readonly string[];
  readonly totalCents: number;
  readonly currency: string;
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  /** Expected delivery date for undelivered orders, the delivery date for delivered ones. */
  readonly deliveryDate: string | null;
  readonly tracking: readonly TrackingEvent[];
}

export interface OrderDirectory {
  /** Every order the customer placed, newest first. Unknown customers have none. */
  ordersFor(customerId: string): Promise<readonly Order[]>;
}

/**
 * Local stand-in with two demo customers. Replace it with a call to your order system (keep the per-customer shape).
 * Tracking numbers deliberately look like carrier references, not like phone or card numbers.
 */
const sample: Readonly<Record<string, readonly Order[]>> = {
  'cus-ada': [
    { orderId: 'ord-1003', placedAt: '2026-09-25T09:12:00.000Z', status: 'processing', items: ['Brass desk lamp'], totalCents: 3_450, currency: 'USD',
      carrier: null, trackingNumber: null, deliveryDate: '2026-10-02', tracking: [{ at: '2026-09-25T09:12:00.000Z', description: 'Order received' }] },
    { orderId: 'ord-1002', placedAt: '2026-09-18T16:40:00.000Z', status: 'shipped', items: ['Mechanical keyboard', 'Wrist rest'], totalCents: 15_480, currency: 'USD',
      carrier: 'Parcelline', trackingNumber: 'PL-7Q4K-22XD', deliveryDate: '2026-09-29', tracking: [
        { at: '2026-09-18T16:40:00.000Z', description: 'Order received' },
        { at: '2026-09-20T11:05:00.000Z', description: 'Handed to Parcelline' },
        { at: '2026-09-24T07:30:00.000Z', description: 'In transit: arrived at the regional hub' }] },
    { orderId: 'ord-1001', placedAt: '2026-08-28T13:20:00.000Z', status: 'delivered', items: ['Ceramic mug set'], totalCents: 4_999, currency: 'USD',
      carrier: 'Parcelline', trackingNumber: 'PL-3M8B-10AA', deliveryDate: '2026-09-02', tracking: [
        { at: '2026-08-28T13:20:00.000Z', description: 'Order received' },
        { at: '2026-08-30T10:00:00.000Z', description: 'Handed to Parcelline' },
        { at: '2026-09-02T15:45:00.000Z', description: 'Delivered to the front door' }] },
  ],
  'cus-grace': [
    { orderId: 'ord-2002', placedAt: '2026-09-21T08:00:00.000Z', status: 'shipped', items: ['Noise-cancelling headphones'], totalCents: 18_450, currency: 'EUR',
      carrier: 'Nordpost', trackingNumber: 'NP-58TR-K2', deliveryDate: '2026-09-30', tracking: [
        { at: '2026-09-21T08:00:00.000Z', description: 'Order received' },
        { at: '2026-09-22T14:10:00.000Z', description: 'Handed to Nordpost' }] },
    { orderId: 'ord-2001', placedAt: '2026-09-01T18:30:00.000Z', status: 'delivered', items: ['Paperback: A Programmer\'s Almanac'], totalCents: 2_600, currency: 'EUR',
      carrier: 'Nordpost', trackingNumber: 'NP-11AC-Z9', deliveryDate: '2026-09-05', tracking: [
        { at: '2026-09-01T18:30:00.000Z', description: 'Order received' },
        { at: '2026-09-05T12:00:00.000Z', description: 'Delivered to a parcel locker' }] },
  ],
};

export const sampleOrders: OrderDirectory = { ordersFor: async customerId => Object.hasOwn(sample, customerId) ? sample[customerId]! : [] };

/** The demo customers `npm run dev` offers in the chat UI. */
export const demoCustomers = Object.freeze([
  { customerId: 'cus-ada', name: 'Ada Lovelace' },
  { customerId: 'cus-grace', name: 'Grace Hopper' },
]);
