import { MayuraError } from 'mayura';
import type { IdentityGrant } from 'mayura/auth';
import type { KeyVerification, KeyVerifier } from 'mayura/keys';

/** A key ReqKey validated, as `identity` receives it. */
export interface ReqkeyKey {
  readonly keyId: string;
  /** The consumer the key belongs to: its credits and rate limits are the consumer's, shared by its keys. */
  readonly consumerId: string;
  /** The API it was validated for (`apiId`), and every API it may call. */
  readonly apiId: string;
  readonly allowedApis: readonly string[];
  readonly tag: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly expiresAtMs: number | null;
  /** The consumer's credits left after this validation, and its limit; null for unlimited consumers. */
  readonly remaining: number | null;
  readonly limit: number | null;
}

export interface ReqkeyVerifierOptions {
  /** Your project's root key; never sent anywhere but ReqKey. */
  readonly rootKey: string;
  /** The start of your keys, such as `prod_`: only tokens with it are sent to ReqKey. */
  readonly prefix: string;
  /** The API (registered in ReqKey) requests are for: keys not allowed to call it are refused. */
  readonly apiId: string;
  /** What a validated key may do, or null to refuse; for example from `key.metadata` or `key.consumerId`. */
  readonly identity: (key: ReqkeyKey) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** How long ReqKey may take to answer; 5 s by default (1 to 30 s). */
  readonly timeoutMs?: number;
  /** ReqKey's API; `https://api.reqkey.com` by default. */
  readonly baseUrl?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const unknownAnswer = () => new MayuraError('TOOL_FAILED', 'ReqKey\'s answer about the key is not one Mayura knows.');

/**
 * A key verifier (`KeyVerifier`, for `keyAuthenticator`) for keys issued by ReqKey: each key with your prefix is
 * validated for your API (spending its cost from its consumer's credits), its details read for its key and consumer
 * ids, and `identity` turns them into a grant. ReqKey's answers are never cached, so a key disabled there is refused at
 * once.
 */
export function reqkeyVerifier(options: ReqkeyVerifierOptions): KeyVerifier {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'reqkeyVerifier(): identity decides what a key may do.');
  if (typeof options.rootKey !== 'string' || !/^[\x21-\x7e]{16,512}$/u.test(options.rootKey)) throw new MayuraError('INVALID_CONFIG', 'reqkeyVerifier(): rootKey is your ReqKey project\'s root key.');
  const prefix = options.prefix;
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(prefix)) throw new MayuraError('INVALID_CONFIG', 'reqkeyVerifier(): prefix is the start of your keys, such as prod_.');
  const apiId = options.apiId;
  if (typeof apiId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(apiId)) throw new MayuraError('INVALID_CONFIG', 'reqkeyVerifier(): apiId is the id of the API, registered in ReqKey, that requests are for.');
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new MayuraError('INVALID_CONFIG', 'reqkeyVerifier(): timeoutMs is 1,000 to 30,000.');
  const base = (options.baseUrl ?? 'https://api.reqkey.com').replace(/\/$/u, '');
  if (typeof base !== 'string' || !/^(?:https:\/\/[^/?#\s]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)$/u.test(base)) throw new MayuraError('INVALID_CONFIG', 'reqkeyVerifier(): baseUrl is an https URL (http only on this machine).');
  const fetcher = options.fetch ?? globalThis.fetch;
  const shape = new RegExp(`^${prefix}[A-Za-z0-9]{16,256}$`, 'u');
  const accepts = (key: string) => shape.test(key);

  const call = async (path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> => {
    try {
      return await fetcher(`${base}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: { authorization: `Bearer ${options.rootKey}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
      });
    // Neither the root key nor the key may reach an error.
    } catch { throw signal.aborted ? new MayuraError('CANCELLED', 'Key verification was cancelled.') : new MayuraError('TOOL_FAILED', 'ReqKey could not be reached to verify the key.'); }
  };
  const failed = (response: Response) => {
    void response.body?.cancel().catch(() => undefined);
    return new MayuraError('TOOL_FAILED', `ReqKey answered HTTP ${response.status} when verifying the key.`);
  };

  const verify = async (key: string, verifyOptions: { readonly signal?: AbortSignal; readonly cost?: number } = {}): Promise<KeyVerification> => {
    if (!accepts(key)) return { ok: false, reason: 'malformed' };
    const cost = verifyOptions.cost ?? 1;
    if (!Number.isSafeInteger(cost) || cost < 0) throw new MayuraError('INVALID_INPUT', 'reqkeyVerifier(): cost is a whole number of credits.');
    const signal = verifyOptions.signal ?? new AbortController().signal;
    // Validation answers whether the key may call the API; only details name the key and its consumer. Both at once.
    const details = call('/key/details', { key }, signal);
    details.catch(() => undefined);
    try {
      const validation = await call('/key/validate', { key, apiId, credits: cost }, signal);
      // ReqKey answers 200 for keys it does not know, and an error status for a key it blocks.
      if (validation.status === 402) { void validation.body?.cancel().catch(() => undefined); return { ok: false, reason: 'exhausted' }; }
      if (validation.status === 403) { void validation.body?.cancel().catch(() => undefined); return { ok: false, reason: 'forbidden' }; }
      if (validation.status === 429) {
        void validation.body?.cancel().catch(() => undefined);
        const seconds = Number(validation.headers.get('retry-after'));
        return { ok: false, reason: 'rate_limited', ...(validation.headers.has('retry-after') && Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.ceil(seconds * 1_000) } : {}) };
      }
      if (validation.status !== 200) throw failed(validation);
      const valid = object(await validation.json().catch(() => undefined));
      if (!valid || typeof valid['valid'] !== 'boolean') throw unknownAnswer();
      if (valid['valid'] !== true) return { ok: false, reason: 'not_found' };
      // Validated for another API than asked for is never validated for this one.
      if (valid['apiId'] !== apiId) return { ok: false, reason: 'forbidden' };
      const detailed = await details;
      if (detailed.status !== 200) throw failed(detailed);
      const about = object(await detailed.json().catch(() => undefined));
      const keyId = text(about?.['keyId']); const consumerId = text(about?.['consumerId']);
      if (!about || keyId === null || consumerId === null) throw unknownAnswer();
      const expiresAtMs = typeof valid['expiresAt'] === 'string' ? Date.parse(valid['expiresAt']) : Number.NaN;
      const allowed = Array.isArray(valid['allowedApis']) ? valid['allowedApis'] : about['allowedApis'];
      const found: ReqkeyKey = Object.freeze({
        keyId, consumerId, apiId, allowedApis: Object.freeze(Array.isArray(allowed) ? allowed.filter((item): item is string => typeof item === 'string') : []),
        tag: text(about['tag']), metadata: object(about['metadata']), expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
        remaining: count(valid['creditsRemaining']), limit: count(valid['creditsLimit']),
      });
      const grant = await options.identity(found);
      if (!grant) return { ok: false, reason: 'forbidden' };
      // The sooner of the key's expiry and the grant's.
      const ends = [found.expiresAtMs, grant.expiresAtMs].filter((end): end is number => typeof end === 'number');
      return { ok: true, principalId: grant.principalId, projectId: grant.projectId, agentIds: grant.agentIds, capabilities: grant.capabilities, expiresAtMs: ends.length > 0 ? Math.min(...ends) : null, remaining: found.remaining };
    } finally {
      // Details unread (a key refused, or ReqKey failing) are let go of, not left holding a connection; read ones are done.
      void details.then(response => response.body?.cancel(), () => undefined).catch(() => undefined);
    }
  };
  return Object.freeze({ accepts, verify });
}
