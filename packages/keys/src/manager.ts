import { MayuraError, type JsonObject } from '@mayura/core';
import { sha256Hex, utf8ByteLength } from '@mayura/core/host';
import { serverCapabilities, type ServerCapability } from '@mayura/auth';
import type { ServerIdentity } from '@mayura/server';
import { StorageError, type AggregateStore, type StoredRecord } from '@mayura/storage-contracts';
import { keyHash, keyIdPattern, keyRecordId, newKeyId, newSecret, prefixPattern, wellFormed } from './format.js';
import type { KeyRefusal, KeyVerification, KeyVerifier } from './verifier.js';

export interface KeyRateLimit { /** Requests allowed per window. */ readonly limit: number; /** The window, in milliseconds. */ readonly windowMs: number }
export interface KeyCredits {
  /** Credits the key starts with; each verification spends `cost` (1 by default). */
  readonly remaining: number;
  /** Set the balance back to `amount` every `intervalMs` (it replaces the balance, it does not add to it). */
  readonly refill?: { readonly amount: number; readonly intervalMs: number };
}

export interface CreateKeyInput {
  readonly projectId: string;
  /** Who holds the key: the identity's principal, such as `user/42` or `service/billing`. */
  readonly ownerId: string;
  readonly agentIds: readonly string[];
  /** What the key may do on Mayura's server; nothing by default. */
  readonly capabilities: readonly ServerCapability[];
  readonly name?: string;
  /** How long the key works; for ever unless set (or capped by `maxExpiresInMs`). */
  readonly expiresInMs?: number;
  readonly rateLimit?: KeyRateLimit;
  readonly credits?: KeyCredits;
  /** Your own data about the key (at most 4 KiB of JSON); never secrets. */
  readonly meta?: JsonObject;
}

/** A key as stored and shown: everything but its secret. */
export interface KeyRecord {
  readonly keyId: string;
  /** What to show the key as, such as `acme_live_4f…9Xk2`. */
  readonly display: string;
  readonly name: string | null;
  readonly projectId: string;
  readonly ownerId: string;
  readonly agentIds: readonly string[];
  readonly capabilities: readonly ServerCapability[];
  readonly meta: JsonObject | null;
  readonly status: 'active' | 'disabled' | 'revoked';
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
  readonly rateLimit: KeyRateLimit | null;
  readonly credits: { readonly refill: { readonly amount: number; readonly intervalMs: number } | null } | null;
  /** The key that replaced this one, after `rotate`. */
  readonly rotatedTo: string | null;
}

export interface KeyUsage { readonly remaining: number | null; readonly lastUsedAtMs: number | null }

export interface KeyManagerOptions {
  /** Where keys are kept: any Mayura store (Postgres, SQLite, libSQL, MySQL, MongoDB, D1, DynamoDB), initialized. */
  readonly store: AggregateStore;
  /** The start of every key, such as `acme` or `acme_live`: lowercase letters and digits, one `_` at most. */
  readonly prefix: string;
  /** Keeps several key sets apart in one store, such as `live` and `test`; `default` by default. */
  readonly namespace?: string;
  /** Random bytes in each key; 32 (256 bits) by default, 16 to 64. */
  readonly randomBytes?: number;
  /** The most keys one owner holds at once (revoked and expired ones excluded); 100 by default (1 to 1,000). */
  readonly maxKeysPerOwner?: number;
  /** The longest a key may be made to last; no limit by default. */
  readonly maxExpiresInMs?: number;
  /** The longest the old key works after `rotate`; 7 days by default (at most 30 days). */
  readonly maxRotationOverlapMs?: number;
  /**
   * Keep a key read from storage for this long; 0 by default, so a revoked or disabled key stops working at once. Up to
   * 60 s: a revoked key then works for that long more in each process.
   */
  readonly cacheTtlMs?: number;
  /** Record when a key was last used at most this often per process; 5 minutes by default (1 s to 1 hour). */
  readonly lastUsedIntervalMs?: number;
}

export interface KeyManager extends KeyVerifier {
  readonly prefix: string;
  /** A new key. Its secret is in the result and nowhere else: show it once. With `grantor`, the key gets no more than the grantor has. */
  create(input: CreateKeyInput, options?: { readonly grantor?: ServerIdentity; readonly signal?: AbortSignal }): Promise<{ readonly key: string; readonly record: KeyRecord }>;
  verify(key: string, options?: { readonly signal?: AbortSignal; readonly cost?: number }): Promise<KeyVerification & { readonly record?: KeyRecord }>;
  get(keyId: string): Promise<(KeyRecord & KeyUsage) | undefined>;
  list(owner: { readonly projectId: string; readonly ownerId: string }): Promise<readonly (KeyRecord & KeyUsage)[]>;
  update(keyId: string, changes: { readonly name?: string | null; readonly agentIds?: readonly string[]; readonly capabilities?: readonly ServerCapability[];
    readonly expiresAtMs?: number | null; readonly rateLimit?: KeyRateLimit | null; readonly credits?: KeyCredits | null; readonly meta?: JsonObject | null }): Promise<KeyRecord>;
  disable(keyId: string): Promise<KeyRecord>;
  enable(keyId: string): Promise<KeyRecord>;
  /** Stops the key for good. */
  revoke(keyId: string): Promise<KeyRecord>;
  /** A new key with the same grant; the old one works for `overlapMs` more (0: it stops now). */
  rotate(keyId: string, options?: { readonly overlapMs?: number }): Promise<{ readonly key: string; readonly record: KeyRecord }>;
  /** What happened to a key: created, updated, disabled, enabled, revoked, rotated. */
  audit(keyId: string): Promise<readonly { readonly type: string; readonly data: JsonObject; readonly at: string }[]>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const namespacePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const definitionHash = 'mayura.keys.v1';
const conflict = (error: unknown) => error instanceof StorageError && error.storageCode === 'CONFLICT';
const invalid = (message: string) => new MayuraError('INVALID_INPUT', message);
const corrupt = () => new MayuraError('STORAGE_UNAVAILABLE', 'A stored key record failed validation.');

function bounded(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `createKeyManager(): ${name} is ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`);
  return result;
}
function checkIds(projectId: unknown, ownerId: unknown, agentIds: unknown, capabilities: unknown): void {
  if (typeof projectId !== 'string' || !identifier.test(projectId) || typeof ownerId !== 'string' || !identifier.test(ownerId)) {
    throw invalid('projectId and ownerId are 1-128 letters, digits, ".", "_", "/" or "-", starting with a letter or digit.');
  }
  checkGrant(agentIds, capabilities);
}
function checkGrant(agentIds: unknown, capabilities: unknown): void {
  if (!Array.isArray(agentIds) || agentIds.length > 256 || agentIds.some(id => typeof id !== 'string' || !identifier.test(id))) throw invalid('agentIds are at most 256 agent ids.');
  if (!Array.isArray(capabilities) || capabilities.some(capability => !serverCapabilities.includes(capability))) throw invalid(`capabilities are some of ${serverCapabilities.join(', ')}.`);
}
function checkRateLimit(value: unknown): KeyRateLimit | null {
  if (value === undefined || value === null) return null;
  const limit = value as KeyRateLimit;
  if (!Number.isSafeInteger(limit.limit) || limit.limit < 1 || limit.limit > 1_000_000 || !Number.isSafeInteger(limit.windowMs) || limit.windowMs < 1_000 || limit.windowMs > 86_400_000) {
    throw invalid('rateLimit is { limit: 1 to 1,000,000, windowMs: 1,000 to 86,400,000 }.');
  }
  return { limit: limit.limit, windowMs: limit.windowMs };
}
function checkCredits(value: unknown): KeyCredits | null {
  if (value === undefined || value === null) return null;
  const credits = value as KeyCredits;
  if (!Number.isSafeInteger(credits.remaining) || credits.remaining < 0 || credits.remaining > 1e12) throw invalid('credits.remaining is 0 to 1,000,000,000,000.');
  if (credits.refill !== undefined && (!Number.isSafeInteger(credits.refill?.amount) || credits.refill.amount < 1 || credits.refill.amount > 1e12
    || !Number.isSafeInteger(credits.refill.intervalMs) || credits.refill.intervalMs < 60_000 || credits.refill.intervalMs > 31_622_400_000)) {
    throw invalid('credits.refill is { amount: 1 or more, intervalMs: 60,000 (a minute) to a year }.');
  }
  return { remaining: credits.remaining, ...(credits.refill ? { refill: { amount: credits.refill.amount, intervalMs: credits.refill.intervalMs } } : {}) };
}
function checkMeta(value: unknown): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('meta is a JSON object.');
  let text: string;
  try { text = JSON.stringify(value); } catch { throw invalid('meta is a JSON object.'); }
  if (utf8ByteLength(text) > 4_096) throw invalid('meta is at most 4 KiB of JSON.');
  return JSON.parse(text) as JsonObject;
}
function checkName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f]/u.test(value)) throw invalid('name is at most 128 characters, without control characters.');
  return value;
}

interface KeyState extends KeyRecord { readonly format: 1; readonly hash: string }
interface UsageState { readonly format: 1; readonly windowStartMs: number; readonly count: number; readonly remaining: number | null; readonly nextRefillAtMs: number | null; readonly lastUsedAtMs: number | null }

function keyState(record: StoredRecord | undefined): KeyState | undefined {
  if (!record) return undefined;
  const state = record.state as unknown as KeyState;
  if (state.format !== 1 || typeof state.keyId !== 'string' || !keyIdPattern.test(state.keyId) || typeof state.hash !== 'string'
    || !['active', 'disabled', 'revoked'].includes(state.status) || typeof state.projectId !== 'string' || typeof state.ownerId !== 'string'
    || !Array.isArray(state.agentIds) || !Array.isArray(state.capabilities) || state.capabilities.some(capability => !serverCapabilities.includes(capability))
    || !(state.expiresAtMs === null || Number.isSafeInteger(state.expiresAtMs))) throw corrupt();
  return state;
}
function usageState(record: StoredRecord | undefined): UsageState {
  const state = record?.state as unknown as UsageState | undefined;
  if (!state || state.format !== 1 || !Number.isSafeInteger(state.windowStartMs) || !Number.isSafeInteger(state.count)
    || !(state.remaining === null || Number.isSafeInteger(state.remaining)) || !(state.nextRefillAtMs === null || Number.isSafeInteger(state.nextRefillAtMs))) throw corrupt();
  return state;
}
const publicRecord = (state: KeyState): KeyRecord => {
  const { format: _format, hash: _hash, ...record } = state;
  return Object.freeze(record);
};

/**
 * API keys for callers of Mayura's server, kept in any Mayura store. A key is `<prefix>_<random><checksum>`: the
 * checksum rejects mistyped and made-up keys before any storage read, and only the key's SHA-256 is stored, so the
 * secret exists only in the result of `create` or `rotate`. Each key carries what it may do (project, agents,
 * capabilities), and may expire, be rate limited and spend credits. Verification reads storage every time unless
 * `cacheTtlMs` is set, so disabling or revoking a key takes effect at once. Give `keyAuthenticator(manager)` to the
 * server as `authenticate`.
 */
export function createKeyManager(options: KeyManagerOptions): KeyManager {
  const store = options?.store;
  if (!store || typeof store.create !== 'function' || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof store.events !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'createKeyManager(): store is a Mayura store, initialized.');
  }
  const prefix = options.prefix;
  if (typeof prefix !== 'string' || !prefixPattern.test(prefix)) throw new MayuraError('INVALID_CONFIG', 'createKeyManager(): prefix is 2-16 lowercase letters and digits starting with a letter, with one optional _ part, such as acme or acme_live.');
  const namespace = options.namespace ?? 'default';
  if (typeof namespace !== 'string' || !namespacePattern.test(namespace)) throw new MayuraError('INVALID_CONFIG', 'createKeyManager(): namespace is 1-32 lowercase letters, digits, "_" or "-".');
  const randomBytes = bounded(options.randomBytes, 'randomBytes', 32, 16, 64);
  const maxKeysPerOwner = bounded(options.maxKeysPerOwner, 'maxKeysPerOwner', 100, 1, 1_000);
  const maxExpiresInMs = options.maxExpiresInMs === undefined ? undefined : bounded(options.maxExpiresInMs, 'maxExpiresInMs', 0, 60_000, 3_162_240_000_000);
  const maxOverlapMs = bounded(options.maxRotationOverlapMs, 'maxRotationOverlapMs', 604_800_000, 0, 2_592_000_000);
  const cacheTtlMs = bounded(options.cacheTtlMs, 'cacheTtlMs', 0, 0, 60_000);
  const lastUsedIntervalMs = bounded(options.lastUsedIntervalMs, 'lastUsedIntervalMs', 300_000, 1_000, 3_600_000);
  const scope = `mayura.keys.${namespace}`;
  const pointerId = (keyId: string) => `id.${keyId}`;
  const usageId = (keyId: string) => `usage.${keyId}`;
  const ownerIndexId = (projectId: string, ownerId: string) => `owner.${sha256Hex(`${projectId}\n${ownerId}`)}`;
  const cache = new Map<string, { readonly state: KeyState | undefined; readonly until: number }>();
  const lastUsedWritten = new Map<string, number>();

  /** Repeats a read-modify-write while another writer gets in first, a few times. */
  const retrying = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) { if (!conflict(error) || attempt >= 7) throw conflict(error) ? new MayuraError('STORAGE_UNAVAILABLE', 'The key changed too often to update; try again.') : error; }
    }
  };
  const secretIdOf = async (keyId: string): Promise<string | undefined> => {
    if (typeof keyId !== 'string' || !keyIdPattern.test(keyId)) throw invalid('keyId is key_ and 22 letters and digits.');
    const pointer = await store.read(scope, pointerId(keyId));
    if (!pointer) return undefined;
    const target = pointer.state['secretRecordId'];
    if (pointer.state['format'] !== 1 || pointer.state['keyId'] !== keyId || typeof target !== 'string' || !target.startsWith('secret.')) throw corrupt();
    return target;
  };
  const readKey = async (keyId: string): Promise<{ readonly record: StoredRecord; readonly state: KeyState } | undefined> => {
    const id = await secretIdOf(keyId);
    const record = id ? await store.read(scope, id) : undefined;
    const state = keyState(record);
    if (!record || !state) return undefined;
    if (state.keyId !== keyId) throw corrupt();
    return { record, state };
  };
  const usageOf = async (keyId: string): Promise<KeyUsage> => {
    const record = await store.read(scope, usageId(keyId));
    if (!record) return { remaining: null, lastUsedAtMs: null };
    const usage = usageState(record);
    return { remaining: usage.remaining, lastUsedAtMs: usage.lastUsedAtMs };
  };
  /** Changes a key's state with compare-and-set, recording what happened. */
  const change = async (keyId: string, event: string, apply: (state: KeyState) => KeyState, data: JsonObject = {}): Promise<KeyRecord> => retrying(async () => {
    const found = await readKey(keyId);
    if (!found) throw new MayuraError('NOT_FOUND', 'No such key.');
    const next = apply(found.state);
    await store.update({ scope, id: found.record.id, expectedVersion: found.record.version, state: next as unknown as JsonObject, events: [{ type: event, data }] });
    cache.delete(found.record.id);
    return publicRecord(next);
  });
  /** Puts a key id in its owner's index, refusing past maxKeysPerOwner (keys that cannot work any more do not count). */
  const addToOwner = async (projectId: string, ownerId: string, keyId: string): Promise<void> => retrying(async () => {
    const id = ownerIndexId(projectId, ownerId);
    const record = await store.read(scope, id);
    const listed = record ? record.state['keyIds'] : [];
    if (record && (record.state['format'] !== 1 || !Array.isArray(listed) || listed.some(item => typeof item !== 'string' || !keyIdPattern.test(item)))) throw corrupt();
    let keyIds = listed as string[];
    if (keyIds.length >= maxKeysPerOwner) {
      // Only now are the listed keys read, to drop those that can no longer work.
      const now = Date.now(); const live: string[] = [];
      for (const listedId of keyIds) {
        const found = await readKey(listedId);
        if (found && found.state.status !== 'revoked' && (found.state.expiresAtMs === null || found.state.expiresAtMs > now)) live.push(listedId);
      }
      keyIds = live;
      if (keyIds.length >= maxKeysPerOwner) throw new MayuraError('LIMIT_EXCEEDED', `This owner holds ${maxKeysPerOwner} keys already: revoke one first.`);
    }
    const state = { format: 1, projectId, ownerId, keyIds: [...keyIds, keyId] };
    if (record) await store.update({ scope, id, expectedVersion: record.version, state, events: [] });
    else {
      const created = await store.create({ scope, id, idempotencyKey: id, definitionHash, state, events: [] });
      if (!created.created) throw new StorageError('CONFLICT', 'The owner index was created meanwhile.');
    }
  });
  /** Writes a new key: its owner index entry, its pointer and usage, and last the key itself, which makes it work. */
  const issue = async (state: Omit<KeyState, 'hash' | 'display' | 'keyId'>, remaining: number | null, event: { readonly type: string; readonly data: JsonObject }) => {
    const key = newSecret(prefix, randomBytes); const keyId = newKeyId(); const secretId = keyRecordId(key);
    await addToOwner(state.projectId, state.ownerId, keyId);
    await store.create({ scope, id: pointerId(keyId), idempotencyKey: pointerId(keyId), definitionHash, state: { format: 1, keyId, secretRecordId: secretId }, events: [] });
    const now = Date.now();
    const usage: UsageState = { format: 1, windowStartMs: now, count: 0, remaining, nextRefillAtMs: state.credits?.refill ? now + state.credits.refill.intervalMs : null, lastUsedAtMs: null };
    await store.create({ scope, id: usageId(keyId), idempotencyKey: usageId(keyId), definitionHash, state: usage as unknown as JsonObject, events: [] });
    const random = key.slice(prefix.length + 1);
    const full: KeyState = { ...state, format: 1, keyId, hash: keyHash(key), display: `${prefix}_${random.slice(0, 2)}…${random.slice(-4)}` };
    const created = await store.create({ scope, id: secretId, idempotencyKey: secretId, definitionHash, state: full as unknown as JsonObject, events: [{ type: event.type, data: { keyId, ...event.data } }] });
    if (!created.created) throw new MayuraError('STORAGE_UNAVAILABLE', 'A key with this secret exists already.');
    return { key, record: publicRecord(full) };
  };

  const refuse = (reason: KeyRefusal, retryAfterMs?: number): KeyVerification => ({ ok: false, reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

  const verify = async (key: string, verifyOptions: { readonly signal?: AbortSignal; readonly cost?: number } = {}): Promise<KeyVerification & { readonly record?: KeyRecord }> => {
    const cost = verifyOptions.cost ?? 1;
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > 1e9) throw invalid('cost is 0 to 1,000,000,000 credits.');
    verifyOptions.signal?.throwIfAborted();
    if (!wellFormed(prefix, randomBytes, key)) return refuse('malformed');
    const secretId = keyRecordId(key);
    const now = Date.now();
    let state: KeyState | undefined;
    const cached = cacheTtlMs > 0 ? cache.get(secretId) : undefined;
    if (cached && cached.until > now) state = cached.state;
    else {
      state = keyState(await store.read(scope, secretId));
      if (cacheTtlMs > 0 && state) {
        if (cache.size >= 10_000) cache.delete(cache.keys().next().value!);
        cache.set(secretId, { state, until: now + cacheTtlMs });
      }
    }
    if (!state || state.hash !== keyHash(key)) return refuse('not_found');
    if (state.status === 'revoked') return refuse('revoked');
    if (state.status === 'disabled') return refuse('disabled');
    if (state.expiresAtMs !== null && state.expiresAtMs <= now) return refuse('expired');
    const keyId = state.keyId;
    let remaining: number | null = null;
    if (state.rateLimit || state.credits) {
      // Rate limit first, credits last: a refused request spends nothing.
      const outcome = await retrying(async () => {
        const record = await store.read(scope, usageId(keyId));
        const usage = usageState(record);
        const at = Date.now();
        let { windowStartMs, count, remaining: balance, nextRefillAtMs } = usage;
        if (state!.rateLimit) {
          if (at >= windowStartMs + state!.rateLimit.windowMs) { windowStartMs = at; count = 0; }
          if (count + 1 > state!.rateLimit.limit) return refuse('rate_limited', windowStartMs + state!.rateLimit.windowMs - at);
          count += 1;
        }
        if (state!.credits) {
          if (state!.credits.refill && nextRefillAtMs !== null && at >= nextRefillAtMs) {
            const periods = Math.floor((at - nextRefillAtMs) / state!.credits.refill.intervalMs) + 1;
            balance = state!.credits.refill.amount; nextRefillAtMs += periods * state!.credits.refill.intervalMs;
          }
          if ((balance ?? 0) < cost) return refuse('exhausted', nextRefillAtMs === null ? undefined : nextRefillAtMs - at);
          balance = (balance ?? 0) - cost;
        }
        const next: UsageState = { format: 1, windowStartMs, count, remaining: balance, nextRefillAtMs, lastUsedAtMs: at };
        await store.update({ scope, id: usageId(keyId), expectedVersion: record!.version, state: next as unknown as JsonObject, events: [] });
        lastUsedWritten.set(keyId, at);
        return { ok: true as const, remaining: balance };
      });
      if (!outcome.ok) return outcome;
      remaining = outcome.remaining;
    } else if (now - (lastUsedWritten.get(keyId) ?? 0) >= lastUsedIntervalMs) {
      // When a key was last used, written at most once per interval per process, and never at the cost of the request.
      lastUsedWritten.set(keyId, now);
      if (lastUsedWritten.size > 100_000) lastUsedWritten.delete(lastUsedWritten.keys().next().value!);
      try {
        const record = await store.read(scope, usageId(keyId));
        if (record) await store.update({ scope, id: usageId(keyId), expectedVersion: record.version, state: { ...usageState(record), lastUsedAtMs: now } as unknown as JsonObject, events: [] });
      } catch { /* A missed last-used time is not worth refusing a valid key. */ }
    }
    const record = publicRecord(state);
    return { ok: true, principalId: state.ownerId, projectId: state.projectId, agentIds: state.agentIds, capabilities: state.capabilities, expiresAtMs: state.expiresAtMs, remaining, record };
  };

  const manager: KeyManager = {
    prefix,
    accepts: (key: string) => typeof key === 'string' && key.startsWith(`${prefix}_`),
    verify,
    create: async (input, createOptions = {}) => {
      createOptions.signal?.throwIfAborted();
      checkIds(input?.projectId, input?.ownerId, input?.agentIds, input?.capabilities);
      const grantor = createOptions.grantor;
      if (grantor) {
        // A key never holds more than whoever makes it.
        if (grantor.scope.projectId !== input.projectId || input.capabilities.some(capability => !grantor.capabilities.includes(capability)) || input.agentIds.some(id => !grantor.agentIds.includes(id))) {
          throw new MayuraError('PERMISSION_DENIED', 'A key cannot hold a project, agents or capabilities its grantor does not.');
        }
      }
      if (input.expiresInMs !== undefined && (!Number.isSafeInteger(input.expiresInMs) || input.expiresInMs < 60_000)) throw invalid('expiresInMs is at least 60,000 (a minute).');
      if (maxExpiresInMs !== undefined && (input.expiresInMs === undefined || input.expiresInMs > maxExpiresInMs)) throw invalid(`Keys here expire within ${maxExpiresInMs.toLocaleString('en-US')} ms: give expiresInMs.`);
      const rateLimit = checkRateLimit(input.rateLimit); const credits = checkCredits(input.credits);
      const now = Date.now();
      return issue({
        format: 1, name: checkName(input.name), projectId: input.projectId, ownerId: input.ownerId, agentIds: Object.freeze([...new Set(input.agentIds)]),
        capabilities: Object.freeze(serverCapabilities.filter(capability => input.capabilities.includes(capability))), meta: checkMeta(input.meta),
        status: 'active', createdAtMs: now, expiresAtMs: input.expiresInMs === undefined ? null : now + input.expiresInMs,
        rateLimit, credits: credits ? { refill: credits.refill ?? null } : null, rotatedTo: null,
      }, credits ? credits.remaining : null, { type: 'key.created', data: {} });
    },
    get: async keyId => {
      const found = await readKey(keyId);
      return found ? Object.freeze({ ...publicRecord(found.state), ...(await usageOf(keyId)) }) : undefined;
    },
    list: async owner => {
      checkIds(owner?.projectId, owner?.ownerId, [], []);
      const record = await store.read(scope, ownerIndexId(owner.projectId, owner.ownerId));
      const keyIds = record?.state['keyIds'];
      if (!record) return [];
      if (!Array.isArray(keyIds) || keyIds.some(item => typeof item !== 'string' || !keyIdPattern.test(item))) throw corrupt();
      const found: (KeyRecord & KeyUsage)[] = [];
      // A key whose writing stopped part way has an index entry but no key, and is left out.
      for (const keyId of keyIds as string[]) { const key = await readKey(keyId); if (key) found.push(Object.freeze({ ...publicRecord(key.state), ...(await usageOf(keyId)) })); }
      return found;
    },
    update: async (keyId, changes) => {
      if (!changes || typeof changes !== 'object') throw invalid('changes is an object.');
      if (changes.agentIds !== undefined || changes.capabilities !== undefined) checkGrant(changes.agentIds ?? [], changes.capabilities ?? []);
      if (changes.expiresAtMs !== undefined && changes.expiresAtMs !== null && !Number.isSafeInteger(changes.expiresAtMs)) throw invalid('expiresAtMs is a time in milliseconds, or null.');
      if (maxExpiresInMs !== undefined && changes.expiresAtMs !== undefined && (changes.expiresAtMs === null || changes.expiresAtMs > Date.now() + maxExpiresInMs)) throw invalid(`Keys here expire within ${maxExpiresInMs.toLocaleString('en-US')} ms.`);
      const rateLimit = changes.rateLimit === undefined ? undefined : checkRateLimit(changes.rateLimit);
      const credits = changes.credits === undefined ? undefined : checkCredits(changes.credits);
      const name = changes.name === undefined ? undefined : checkName(changes.name);
      const meta = changes.meta === undefined ? undefined : checkMeta(changes.meta);
      const updated = await change(keyId, 'key.updated', state => {
        if (state.status === 'revoked') throw new MayuraError('CONFLICT', 'A revoked key cannot change.');
        return {
          ...state, ...(name !== undefined ? { name } : {}), ...(meta !== undefined ? { meta } : {}), ...(rateLimit !== undefined ? { rateLimit } : {}),
          ...(changes.agentIds !== undefined ? { agentIds: Object.freeze([...new Set(changes.agentIds)]) } : {}),
          ...(changes.capabilities !== undefined ? { capabilities: Object.freeze(serverCapabilities.filter(capability => changes.capabilities!.includes(capability))) } : {}),
          ...(changes.expiresAtMs !== undefined ? { expiresAtMs: changes.expiresAtMs } : {}),
          ...(credits !== undefined ? { credits: credits ? { refill: credits.refill ?? null } : null } : {}),
        };
      }, { fields: Object.keys(changes).filter(field => (changes as Record<string, unknown>)[field] !== undefined) });
      if (credits !== undefined) {
        await retrying(async () => {
          const record = await store.read(scope, usageId(keyId));
          const usage = usageState(record); const now = Date.now();
          await store.update({ scope, id: usageId(keyId), expectedVersion: record!.version, events: [], state: { ...usage,
            remaining: credits ? credits.remaining : null, nextRefillAtMs: credits?.refill ? now + credits.refill.intervalMs : null } as unknown as JsonObject });
        });
      }
      return updated;
    },
    disable: keyId => change(keyId, 'key.disabled', state => {
      if (state.status === 'revoked') throw new MayuraError('CONFLICT', 'A revoked key stays revoked.');
      return { ...state, status: 'disabled' };
    }),
    enable: keyId => change(keyId, 'key.enabled', state => {
      if (state.status === 'revoked') throw new MayuraError('CONFLICT', 'A revoked key cannot be enabled.');
      return { ...state, status: 'active' };
    }),
    revoke: keyId => change(keyId, 'key.revoked', state => ({ ...state, status: 'revoked' })),
    rotate: async (keyId, rotateOptions = {}) => {
      const overlapMs = rotateOptions.overlapMs ?? 0;
      if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs > maxOverlapMs) throw invalid(`overlapMs is 0 to ${maxOverlapMs.toLocaleString('en-US')}.`);
      const found = await readKey(keyId);
      if (!found) throw new MayuraError('NOT_FOUND', 'No such key.');
      if (found.state.status !== 'active') throw new MayuraError('CONFLICT', 'Only an active key can be rotated.');
      const usage = await usageOf(keyId);
      const { keyId: _old, hash: _hash, display: _display, ...grant } = found.state;
      const now = Date.now();
      const issued = await issue({ ...grant, createdAtMs: now, rotatedTo: null }, usage.remaining, { type: 'key.created', data: { rotatedFrom: keyId } });
      await change(keyId, 'key.rotated', state => ({
        ...state, rotatedTo: issued.record.keyId,
        ...(overlapMs === 0 ? { status: 'revoked' as const } : { expiresAtMs: Math.min(state.expiresAtMs ?? Number.MAX_SAFE_INTEGER, now + overlapMs) }),
      }), { rotatedTo: issued.record.keyId, overlapMs });
      return issued;
    },
    audit: async keyId => {
      const id = await secretIdOf(keyId);
      if (!id) throw new MayuraError('NOT_FOUND', 'No such key.');
      const events = await store.events(scope, id);
      return events.map(event => Object.freeze({ type: event.type, data: event.data, at: event.createdAt }));
    },
  };
  return Object.freeze(manager);
}

