import { createHmac, timingSafeEqual } from 'node:crypto';

// Customer sessions: short-lived, HMAC-SHA256 signed tokens that your own backend mints after it has signed the shopper
// in with your existing login. The Mayura server only verifies them; it never sees a password.
//
//   v1.<base64url(JSON {"sub":"<customer id>","exp":<expiry, ms since epoch>})>.<base64url(HMAC-SHA256(secret, "mayura-session:v1." + payload))>
//
// The customer id inside a verified token is the only source of "who is asking": every tool derives the customer from
// it (through the run scope), never from anything the model or the browser says.

/** Customer identifiers as your order system issues them. Deliberately narrow: they end up in scopes and logs. */
export const customerIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
/** Sessions are short-lived; the browser asks your backend for a new one when it expires. */
export const maxSessionTtlMs = 24 * 60 * 60_000;
const domain = 'mayura-session:v1.';
const tokenPattern = /^v1\.([A-Za-z0-9_-]{1,256})\.([A-Za-z0-9_-]{43})$/u;

function assertSecret(secret: Buffer): void {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('A session secret needs at least 32 random bytes.');
}
const sign = (secret: Buffer, payload: string): Buffer => createHmac('sha256', secret).update(domain + payload).digest();

/**
 * Mint a session for one customer. Call it from your application's backend, after your own login, and hand the token
 * to that customer's browser. Never ship the secret to a browser.
 */
export function mintSessionToken(secret: Buffer, customerId: string, ttlMs: number, now: number = Date.now()): string {
  assertSecret(secret);
  if (!customerIdPattern.test(customerId)) throw new Error('Invalid customer id.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > maxSessionTtlMs) throw new Error('Session lifetime must be between one second and one day.');
  const payload = Buffer.from(JSON.stringify({ sub: customerId, exp: now + ttlMs })).toString('base64url');
  return `v1.${payload}.${sign(secret, payload).toString('base64url')}`;
}

export interface VerifiedSession { readonly customerId: string; readonly expiresAtMs: number }

/** Returns the customer only for an authentic, unexpired token signed with `secret`; null for anything else. */
export function verifySessionToken(secret: Buffer, token: string, now: number = Date.now()): VerifiedSession | null {
  assertSecret(secret);
  const match = tokenPattern.exec(token);
  if (!match) return null;
  const [, payload, signature] = match as unknown as [string, string, string];
  // Constant-time comparison of equal-length MACs; check the signature before parsing anything the caller supplied.
  const expected = sign(secret, payload); const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  const { sub, exp, ...rest } = claims as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof sub !== 'string' || !customerIdPattern.test(sub)
    || typeof exp !== 'number' || !Number.isSafeInteger(exp)) return null;
  // Expired, or further in the future than any session we mint (a sign of a leaked or misused key).
  if (exp <= now || exp > now + maxSessionTtlMs) return null;
  return { customerId: sub, expiresAtMs: exp };
}
