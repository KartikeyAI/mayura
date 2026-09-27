import { createClient, type ClientSchema, type MayuraClient } from '@mayura/client';

// Everything the chat needs from the outside world. No secret lives in this bundle: the browser holds only a short-lived
// customer session, and the Mayura API decides what that session may do.

/** The Mayura API. Same origin as this page (see README for serving it from elsewhere). */
export const apiOrigin = window.location.origin;
export const assistantId = 'support.assistant';

export interface Session { readonly token: string; readonly customerId: string; readonly name: string; readonly expiresAtMs: number }
export interface DemoCustomer { readonly customerId: string; readonly name: string }

/**
 * DEVELOPMENT ONLY: `npm run dev` offers demo customers and signs sessions for them without a login.
 * In production, replace these two functions with a call to your own backend: it signs the shopper in with your
 * existing login and returns `mintSessionToken(secret, customerId, ttlMs)` (src/session.ts) for that shopper only.
 */
export async function demoCustomers(): Promise<readonly DemoCustomer[]> {
  const response = await fetch('/dev/customers', { cache: 'no-store' });
  if (!response.ok) throw new Error('The demo customer list is only available under `npm run dev`.');
  return ((await response.json()) as { customers: DemoCustomer[] }).customers;
}
export async function signIn(customerId: string): Promise<Session> {
  const response = await fetch('/dev/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId }), cache: 'no-store' });
  if (!response.ok) throw new Error('Could not start a session.');
  return (await response.json()) as Session;
}

export function supportClient(session: Session): MayuraClient {
  return createClient({ baseUrl: `${apiOrigin}/`, token: () => session.token });
}

export interface Turn { readonly role: 'customer' | 'assistant'; readonly text: string }
export interface Reply { readonly reply: string; readonly references: readonly { readonly kind: 'order' | 'return' | 'note'; readonly id: string }[] }

/** A small hand-written check of the reply shape, so the bundle does not need a validation library. */
export const replySchema: ClientSchema<Reply> = {
  '~standard': {
    version: 1,
    validate(value: unknown) {
      const candidate = value as Partial<Reply> | null;
      const valid = typeof candidate === 'object' && candidate !== null && typeof candidate.reply === 'string' && Array.isArray(candidate.references)
        && candidate.references.every(item => typeof item?.id === 'string' && ['order', 'return', 'note'].includes(item.kind));
      return valid ? { value: candidate as Reply } : { issues: [{ message: 'Unexpected reply.' }] };
    },
  },
};

/** What the assistant is doing, in the customer's words. Unknown tools fall back to their id. */
export const toolLabels: Readonly<Record<string, string>> = {
  'orders.list': 'Looked up your orders',
  'orders.track': 'Checked tracking',
  'returns.start': 'Opened a return',
  'memory.remember': 'Saved a note',
  'memory.recall': 'Checked your notes',
};
