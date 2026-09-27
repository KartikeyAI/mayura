/**
 * A few tickets the local tracker starts with, and the `ticket.created` event the tracker sends for each. `npm run dev`
 * delivers some of them; `npm run send-sample -- <name>` delivers any of them again.
 */
export const sampleTickets = {
  outage: { id: 'T-1001', title: 'Checkout is down for all customers', reporter: 'ops@example.com',
    body: 'Since 09:12 UTC every checkout attempt in production returns a 502. This is an outage.' },
  billing: { id: 'T-1002', title: 'Charged twice for one invoice', reporter: 'ada@example.com',
    body: 'My card was charged twice for invoice INV-88. Please refund the duplicate payment.' },
  docs: { id: 'T-1003', title: 'Typo in the API docs', reporter: 'grace@example.com',
    body: 'The documentation for /v1/orders spells "idempotency" as "idempotence".' },
  feature: { id: 'T-1004', title: 'Dark mode for the dashboard', reporter: 'lin@example.com',
    body: 'Feature request: it would be nice to have a dark mode.' },
} as const;
export type SampleName = keyof typeof sampleTickets;
export const sampleNames = Object.keys(sampleTickets) as SampleName[];

/** The exact JSON the tracker posts to `/webhooks/tickets` when a ticket is created. */
export const ticketCreatedEvent = (name: SampleName) => ({ event: 'ticket.created' as const, ticket: { ...sampleTickets[name] } });
