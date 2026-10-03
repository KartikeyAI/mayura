import { MayuraError } from 'mayura';
import type { IdentityGrant } from 'mayura/auth';
import type { KeyRefusal, KeyVerification, KeyVerifier } from 'mayura/keys';

/** A key Unkey verified, as `identity` receives it. */
export interface UnkeyKey {
  readonly keyId: string;
  /** The keyspace (API) the key belongs to: one of `keyspaces`. */
  readonly keyspaceId: string;
  readonly name: string | null;
  /** The key's metadata, when set. */
  readonly meta: Readonly<Record<string, unknown>> | null;
  /** Every permission the key holds, directly or through its roles. */
  readonly permissions: readonly string[];
  readonly roles: readonly string[];
  /** The identity the key is linked to (its `externalId` is yours, such as a user or organization id). */
  readonly identity: { readonly id: string; readonly externalId: string; readonly meta: Readonly<Record<string, unknown>> | null } | null;
  readonly expiresAtMs: number | null;
  /** Credits left after this verification; null for keys without credits. */
  readonly remaining: number | null;
}

export interface UnkeyVerifierOptions {
  /** A root key allowed to verify keys (`api.*.verify_key`, or `api.<id>.verify_key`); never sent anywhere but Unkey. */
  readonly rootKey: string;
  /** Your keys' prefix, such as `sk` for `sk_...`: only tokens with it are sent to Unkey. */
  readonly prefix: string;
  /** The keyspaces (`ks_...`, your APIs') whose keys are accepted; keys of any other are refused by Unkey. */
  readonly keyspaces: readonly string[];
  /** What a verified key may do, or null to refuse; for example from `key.permissions` with `mapCapabilities`. */
  readonly identity: (key: UnkeyKey) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /**
   * A permission query every key must satisfy, such as `agents.use`. Unkey checks it before rate limits and credits,
   * so a key without it spends nothing; a key `identity` refuses has already spent its cost.
   */
  readonly permissions?: string;
  /** How long Unkey may take to answer; 5 s by default (1 to 30 s). */
  readonly timeoutMs?: number;
  /** Unkey's API, for a self-hosted Unkey; `https://api.unkey.com` by default. */
  readonly baseUrl?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const refusals: Readonly<Record<string, KeyRefusal>> = {
  NOT_FOUND: 'not_found', DISABLED: 'disabled', EXPIRED: 'expired', FORBIDDEN: 'forbidden',
  INSUFFICIENT_PERMISSIONS: 'forbidden', RATE_LIMITED: 'rate_limited', USAGE_EXCEEDED: 'exhausted',
};
const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
const strings = (value: unknown) => Object.freeze(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * A key verifier (`KeyVerifier`, for `keyAuthenticator`) for keys issued by Unkey: each key with your prefix is checked
 * with Unkey's `keys.verifyKey` (spending its cost in credits), limited to your keyspaces, and `identity` turns what
 * Unkey knows about it into a grant. Unkey's own answers are never cached, so a key revoked there is refused at once.
 */
export function unkeyVerifier(options: UnkeyVerifierOptions): KeyVerifier {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): identity decides what a key may do.');
  if (typeof options.rootKey !== 'string' || !/^[\x21-\x7e]{16,512}$/u.test(options.rootKey)) throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): rootKey is an Unkey root key allowed to verify keys.');
  const prefix = options.prefix;
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_]{0,15}$/u.test(prefix)) throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): prefix is your keys\' prefix, such as sk, 1 to 16 letters, digits or underscores.');
  const keyspaces = options.keyspaces;
  if (!Array.isArray(keyspaces) || keyspaces.length === 0 || keyspaces.length > 5 || keyspaces.some(id => typeof id !== 'string' || !/^ks_[A-Za-z0-9]{1,97}$/u.test(id))) {
    throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): keyspaces are 1 to 5 keyspace ids (ks_...) whose keys are accepted.');
  }
  const permissions = options.permissions;
  if (permissions !== undefined && (typeof permissions !== 'string' || permissions.length === 0 || permissions.length > 1_000)) throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): permissions is a permission query of 1 to 1,000 characters.');
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): timeoutMs is 1,000 to 30,000.');
  const base = (options.baseUrl ?? 'https://api.unkey.com').replace(/\/$/u, '');
  if (typeof base !== 'string' || !/^(?:https:\/\/[^/?#\s]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)$/u.test(base)) throw new MayuraError('INVALID_CONFIG', 'unkeyVerifier(): baseUrl is an https URL (http only on this machine).');
  const fetcher = options.fetch ?? globalThis.fetch;
  const shape = new RegExp(`^${prefix}_[A-Za-z0-9]{8,500}$`, 'u');
  const accepts = (key: string) => shape.test(key);

  const verify = async (key: string, verifyOptions: { readonly signal?: AbortSignal; readonly cost?: number } = {}): Promise<KeyVerification> => {
    if (!accepts(key)) return { ok: false, reason: 'malformed' };
    const cost = verifyOptions.cost ?? 1;
    if (!Number.isSafeInteger(cost) || cost < 0) throw new MayuraError('INVALID_INPUT', 'unkeyVerifier(): cost is a whole number of credits.');
    const signal = verifyOptions.signal ?? new AbortController().signal;
    let response: Response;
    try {
      response = await fetcher(`${base}/v2/keys.verifyKey`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: { authorization: `Bearer ${options.rootKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ key, keyspaces, credits: { cost }, ...(permissions !== undefined ? { permissions } : {}) }),
      });
    // Neither the root key nor the key may reach an error.
    } catch { throw signal.aborted ? new MayuraError('CANCELLED', 'Key verification was cancelled.') : new MayuraError('TOOL_FAILED', 'Unkey could not be reached to verify the key.'); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new MayuraError('TOOL_FAILED', `Unkey answered HTTP ${response.status} when verifying the key.`); }
    const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined;
    const data = object(body?.data);
    if (!data || typeof data['valid'] !== 'boolean' || typeof data['code'] !== 'string') throw new MayuraError('TOOL_FAILED', 'Unkey\'s answer about the key is not one Mayura knows.');
    if (data['valid'] !== true || data['code'] !== 'VALID') {
      const reason = refusals[data['code']] ?? 'forbidden';
      if (reason !== 'rate_limited') return { ok: false, reason };
      // The soonest an exceeded limit resets, when Unkey says.
      const resets = (Array.isArray(data['ratelimits']) ? data['ratelimits'] : []).map(object).filter(limit => limit?.['exceeded'] === true).map(limit => limit!['reset']).filter((reset): reset is number => typeof reset === 'number');
      const retryAfterMs = resets.length > 0 ? Math.max(0, Math.min(...resets) - Date.now()) : undefined;
      return { ok: false, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    const keyId = text(data['keyId']); const keyspaceId = keyspaces.find(id => id === data['keyspaceId']);
    // Unkey keeps to the keyspaces asked for; a key from any other is refused here too.
    if (keyId === null || keyspaceId === undefined) return { ok: false, reason: 'forbidden' };
    const linked = object(data['identity']);
    const identityId = text(linked?.['id']); const externalId = text(linked?.['externalId']);
    const expires = data['expires'];
    const found: UnkeyKey = Object.freeze({
      keyId, keyspaceId, name: text(data['name']), meta: object(data['meta']), permissions: strings(data['permissions']), roles: strings(data['roles']),
      identity: identityId !== null && externalId !== null ? Object.freeze({ id: identityId, externalId, meta: object(linked!['meta']) }) : null,
      expiresAtMs: typeof expires === 'number' && Number.isSafeInteger(expires) ? expires : null, remaining: count(data['credits']),
    });
    const grant = await options.identity(found);
    if (!grant) return { ok: false, reason: 'forbidden' };
    // The sooner of the key's expiry and the grant's.
    const ends = [found.expiresAtMs, grant.expiresAtMs].filter((end): end is number => typeof end === 'number');
    return { ok: true, principalId: grant.principalId, projectId: grant.projectId, agentIds: grant.agentIds, capabilities: grant.capabilities, expiresAtMs: ends.length > 0 ? Math.min(...ends) : null, remaining: found.remaining };
  };
  return Object.freeze({ accepts, verify });
}
