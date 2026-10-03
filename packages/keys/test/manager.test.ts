import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@mayura/core/host';
import type { AggregateStore } from '@mayura/storage-contracts';
import { createKeyManager, keyHash } from '../src/index.js';
import { base62, crc32, newSecret, randomWidth, wellFormed } from '../src/format.js';
import { memoryAggregateStore } from '../src/testing.js';

afterEach(() => { vi.useRealTimers(); });
const owner = (extra: Record<string, unknown> = {}) => ({ projectId: 'acme', ownerId: 'user/1', agentIds: ['support'], capabilities: ['runs:read'] as ('runs:read' | 'runs:submit')[], ...extra });
async function setup(options: Partial<Parameters<typeof createKeyManager>[0]> = {}) {
  const store = memoryAggregateStore(); await store.initialize();
  let reads = 0;
  const counted: AggregateStore = { ...store, read: async (scope, id) => { reads++; return store.read(scope, id); } };
  return { store, keys: createKeyManager({ store: counted, prefix: 'acme', ...options }), reads: () => reads };
}

describe('key format', () => {
  it('uses CRC-32 and base62 as GitHub does, so a mistyped key is caught by its checksum', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(base62(new Uint8Array([0]), 3)).toBe('000');
    expect(base62(61, 1)).toBe('z');
    expect(base62(62, 1)).toBe('10');
    const key = newSecret('acme_live', 32);
    expect(key).toMatch(/^acme_live_[0-9A-Za-z]{49}$/u);
    expect(wellFormed('acme_live', 32, key)).toBe(true);
    const typo = `${key.slice(0, 20)}${key[20] === 'a' ? 'b' : 'a'}${key.slice(21)}`;
    expect(wellFormed('acme_live', 32, typo)).toBe(false);
    expect(wellFormed('acme', 32, key)).toBe(false);
    expect(wellFormed('acme_live', 16, key)).toBe(false);
    expect(wellFormed('acme_live', 32, `${key}x`)).toBe(false);
    expect(wellFormed('acme_live', 32, key.replace(/.$/u, '!'))).toBe(false);
  });

  it('stores only the base64 SHA-256 of a key, the form Unkey also takes', () => {
    expect(keyHash('acme_x')).toBe(btoa(String.fromCharCode(...sha256('acme_x'))));
  });
});

describe('createKeyManager', () => {
  it('refuses configuration it cannot keep to', async () => {
    const store = memoryAggregateStore();
    expect(() => createKeyManager({ store: {} as never, prefix: 'acme' })).toThrow(/store/u);
    for (const prefix of ['A', 'acme-live', 'a', 'acme_live_x', '1acme', 'acme_']) expect(() => createKeyManager({ store, prefix }), prefix).toThrow(/prefix/u);
    for (const [name, value] of [['namespace', 'Live!'], ['randomBytes', 8], ['maxKeysPerOwner', 0], ['maxExpiresInMs', 10], ['maxRotationOverlapMs', -1], ['cacheTtlMs', 120_000], ['lastUsedIntervalMs', 10]] as const) {
      expect(() => createKeyManager({ store, prefix: 'acme', [name]: value }), name).toThrow(new RegExp(name, 'u'));
    }
  });

  it('refuses keys of the wrong form before reading storage', async () => {
    const { keys, reads } = await setup();
    const { key } = await keys.create(owner());
    const before = reads();
    for (const bad of ['', 'nope', `other_${key.slice(5)}`, `${key.slice(0, -1)}0`, key.toUpperCase(), 7]) {
      expect(await keys.verify(bad as string), String(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(reads()).toBe(before);
    // A key made for another prefix of the same length, or with other characters and a checksum to match: still refused unread.
    expect(await keys.verify(newSecret('acmf', 32))).toEqual({ ok: false, reason: 'malformed' });
    const head = `acme_${'-'.repeat(randomWidth(32))}`;
    expect(await keys.verify(`${head}${base62(crc32(head), 6)}`)).toEqual({ ok: false, reason: 'malformed' });
    expect(reads()).toBe(before);
    // Well formed but never issued: read, and not found.
    expect(await keys.verify(newSecret('acme', 32))).toEqual({ ok: false, reason: 'not_found' });
    expect(keys.accepts(key)).toBe(true); expect(keys.accepts('other_x')).toBe(false);
  });

  it('checks what is asked of a key', async () => {
    const { keys } = await setup({ maxExpiresInMs: 86_400_000 });
    for (const [input, pattern] of [
      [owner({ projectId: 'bad id' }), /projectId/u], [owner({ ownerId: '' }), /ownerId/u], [owner({ agentIds: ['a b'] }), /agentIds/u],
      [owner({ capabilities: ['root'] }), /capabilities/u], [owner({ expiresInMs: 1_000 }), /expiresInMs/u], [owner(), /expire within/u],
      [owner({ expiresInMs: 172_800_000 }), /expire within/u], [owner({ expiresInMs: 3_600_000, rateLimit: { limit: 0, windowMs: 1_000 } }), /rateLimit/u],
      [owner({ expiresInMs: 3_600_000, rateLimit: { limit: 1, windowMs: 10 } }), /rateLimit/u], [owner({ expiresInMs: 3_600_000, credits: { remaining: -1 } }), /credits/u],
      [owner({ expiresInMs: 3_600_000, credits: { remaining: 1, refill: { amount: 1, intervalMs: 10 } } }), /refill/u],
      [owner({ expiresInMs: 3_600_000, meta: 'x' }), /meta/u], [owner({ expiresInMs: 3_600_000, meta: { pad: 'x'.repeat(5_000) } }), /meta/u],
      [owner({ expiresInMs: 3_600_000, name: 'x'.repeat(200) }), /name/u], [owner({ expiresInMs: 3_600_000, name: 'a\nb' }), /name/u],
    ] as const) await expect(keys.create(input as never), JSON.stringify(input).slice(0, 80)).rejects.toThrow(pattern);
    expect((await keys.create(owner({ expiresInMs: 3_600_000 }))).record.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('never gives a key more than its grantor holds', async () => {
    const { keys } = await setup();
    const grantor = { scope: { principalId: 'user/1', projectId: 'acme' }, agentIds: ['support'], capabilities: ['runs:read' as const], expiresAtMs: Date.now() + 60_000 };
    expect((await keys.create(owner(), { grantor })).record.capabilities).toEqual(['runs:read']);
    await expect(keys.create(owner({ capabilities: ['runs:read', 'runs:submit'] }), { grantor })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(keys.create(owner({ agentIds: ['billing'] }), { grantor })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(keys.create(owner({ projectId: 'other' }), { grantor })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('keeps a key read from storage only when cacheTtlMs says so, so revocation is immediate by default', async () => {
    const plain = await setup();
    const { key, record } = await plain.keys.create(owner());
    await plain.keys.verify(key);
    await plain.keys.revoke(record.keyId);
    expect(await plain.keys.verify(key)).toEqual({ ok: false, reason: 'revoked' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const cached = await setup({ cacheTtlMs: 10_000 });
    const second = await cached.keys.create(owner());
    // Another process (another manager on the same store) revokes; this one's cache keeps the key for its TTL.
    const other = createKeyManager({ store: cached.store, prefix: 'acme' });
    expect((await cached.keys.verify(second.key)).ok).toBe(true);
    await other.revoke(second.record.keyId);
    expect((await cached.keys.verify(second.key)).ok).toBe(true);
    vi.setSystemTime(Date.now() + 11_000);
    expect(await cached.keys.verify(second.key)).toEqual({ ok: false, reason: 'revoked' });
    // A change made through the same manager clears its cache at once.
    const third = await cached.keys.create(owner());
    await cached.keys.verify(third.key);
    await cached.keys.disable(third.record.keyId);
    expect(await cached.keys.verify(third.key)).toEqual({ ok: false, reason: 'disabled' });
  });

  it('refills credits by replacing the balance at each interval, and spends nothing on refused requests or at cost 0', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { keys } = await setup();
    const { key, record } = await keys.create(owner({ credits: { remaining: 2, refill: { amount: 3, intervalMs: 60_000 } }, rateLimit: { limit: 2, windowMs: 1_000 } }));
    expect(await keys.verify(key, { cost: 0 })).toMatchObject({ ok: true, remaining: 2 });
    expect(await keys.verify(key)).toMatchObject({ ok: true, remaining: 1 });
    // Over the rate limit: refused, and no credit spent.
    expect(await keys.verify(key)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((await keys.get(record.keyId))!.remaining).toBe(1);
    vi.setSystemTime(Date.now() + 1_100);
    expect(await keys.verify(key, { cost: 2 })).toMatchObject({ ok: false, reason: 'exhausted', retryAfterMs: expect.any(Number) });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await keys.verify(key, { cost: 2 })).toMatchObject({ ok: true, remaining: 1 });
    await expect(keys.verify(key, { cost: -1 })).rejects.toThrow(/cost/u);
  });

  it('updates a key\'s grant, limits and credits, and refuses changes to a revoked one', async () => {
    const { keys } = await setup();
    const { key, record } = await keys.create(owner());
    await keys.update(record.keyId, { capabilities: ['runs:read', 'runs:submit'], name: 'renamed', credits: { remaining: 1 }, meta: { team: 'ops' } });
    expect(await keys.verify(key)).toMatchObject({ ok: true, capabilities: ['runs:read', 'runs:submit'], remaining: 0 });
    expect(await keys.verify(key)).toMatchObject({ ok: false, reason: 'exhausted' });
    await keys.update(record.keyId, { credits: null });
    expect((await keys.verify(key)).ok).toBe(true);
    expect((await keys.audit(record.keyId)).map(event => event.type)).toEqual(['key.created', 'key.updated', 'key.updated']);
    await expect(keys.update(record.keyId, { capabilities: ['root' as never] })).rejects.toThrow(/capabilities/u);
    await expect(keys.update(record.keyId, { expiresAtMs: 1.5 })).rejects.toThrow(/expiresAtMs/u);
    await keys.revoke(record.keyId);
    await expect(keys.update(record.keyId, { name: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(keys.disable(record.keyId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(keys.rotate(record.keyId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(keys.get('nope')).rejects.toThrow(/keyId/u);
    expect(await keys.get(`key_${'0'.repeat(22)}`)).toBeUndefined();
    await expect(keys.revoke(`key_${'0'.repeat(22)}`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(keys.audit(`key_${'0'.repeat(22)}`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(keys.rotate(record.keyId, { overlapMs: -1 })).rejects.toThrow(/overlapMs/u);
  });

  it('keeps updates within maxExpiresInMs, and never lets rotation extend a key due to expire sooner', async () => {
    const { keys } = await setup({ maxExpiresInMs: 86_400_000 });
    const { record } = await keys.create(owner({ expiresInMs: 60_000 }));
    await expect(keys.update(record.keyId, { expiresAtMs: null })).rejects.toThrow(/expire within/u);
    await expect(keys.update(record.keyId, { expiresAtMs: Date.now() + 172_800_000 })).rejects.toThrow(/expire within/u);
    const expiresAtMs = (await keys.get(record.keyId))!.expiresAtMs!;
    await keys.rotate(record.keyId, { overlapMs: 3_600_000 });
    expect((await keys.get(record.keyId))!.expiresAtMs).toBe(expiresAtMs);
  });

  it('records when a key was last used, at most once per interval, without failing a request over it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store, keys } = await setup({ lastUsedIntervalMs: 60_000 });
    const { key, record } = await keys.create(owner());
    expect((await keys.get(record.keyId))!.lastUsedAtMs).toBeNull();
    await keys.verify(key);
    const first = (await keys.get(record.keyId))!.lastUsedAtMs;
    expect(first).toBeTypeOf('number');
    vi.setSystemTime(Date.now() + 10_000);
    await keys.verify(key);
    expect((await keys.get(record.keyId))!.lastUsedAtMs).toBe(first);
    vi.setSystemTime(Date.now() + 61_000);
    // A store that fails the write does not fail the request.
    const failing = createKeyManager({ store: { ...store, update: async () => { throw new Error('down'); } }, prefix: 'acme', lastUsedIntervalMs: 1_000 });
    expect((await failing.verify(key)).ok).toBe(true);
    await keys.verify(key);
    expect((await keys.get(record.keyId))!.lastUsedAtMs).toBeGreaterThan(first!);
  });

  it('refuses records that fail validation rather than trusting them', async () => {
    const { store, keys } = await setup();
    const { key, record } = await keys.create(owner());
    const secret = await store.read('mayura.keys.default', `id.${record.keyId}`);
    const tampered = createKeyManager({ prefix: 'acme', store: { ...store, read: async (scope, id) => {
      const found = await store.read(scope, id);
      return found && id === secret!.state['secretRecordId'] ? { ...found, state: { ...found.state, capabilities: ['root'] } } : found;
    } } });
    await expect(tampered.verify(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const pointer = createKeyManager({ prefix: 'acme', store: { ...store, read: async (scope, id) => {
      const found = await store.read(scope, id);
      return found && id.startsWith('id.') ? { ...found, state: { ...found.state, secretRecordId: 'elsewhere' } } : found;
    } } });
    await expect(pointer.get(record.keyId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const usage = createKeyManager({ prefix: 'acme', store: { ...store, read: async (scope, id) => {
      const found = await store.read(scope, id);
      return found && id.startsWith('usage.') ? { ...found, state: { ...found.state, format: 2 } } : found;
    } } });
    await expect(usage.get(record.keyId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    // A record whose stored hash is not the key's is not that key.
    const rehashed = createKeyManager({ prefix: 'acme', store: { ...store, read: async (scope, id) => {
      const found = await store.read(scope, id);
      return found && id.startsWith('secret.') ? { ...found, state: { ...found.state, hash: 'x' } } : found;
    } } });
    expect(await rehashed.verify(key)).toEqual({ ok: false, reason: 'not_found' });
    // A pointer to another key's record is refused.
    const other = await keys.create(owner());
    const otherPointer = await store.read('mayura.keys.default', `id.${other.record.keyId}`);
    const crossed = createKeyManager({ prefix: 'acme', store: { ...store, read: async (scope, id) => id === `id.${record.keyId}` ? otherPointer && { ...otherPointer, state: { ...otherPointer.state, keyId: record.keyId } } : store.read(scope, id) } });
    await expect(crossed.get(record.keyId)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    // A corrupted owner index is refused when listing and when adding a key.
    const indexed = createKeyManager({ prefix: 'acme', store: { ...store, read: async (scope, id) => {
      const found = await store.read(scope, id);
      return found && id.startsWith('owner.') ? { ...found, state: { ...found.state, keyIds: ['not-a-key-id'] } } : found;
    } } });
    await expect(indexed.list({ projectId: 'acme', ownerId: 'user/1' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(indexed.create(owner())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('leaves out a key whose writing stopped part way, and makes no key from it', async () => {
    const { store, keys } = await setup();
    let creates = 0;
    const stopping = createKeyManager({ prefix: 'acme', store: { ...store, create: async command => {
      if (++creates === 4) throw new Error('crashed before the key itself was written');
      return store.create(command);
    } } });
    await expect(stopping.create(owner())).rejects.toThrow(/crashed/u);
    expect(await keys.list({ projectId: 'acme', ownerId: 'user/1' })).toEqual([]);
    const { record } = await keys.create(owner());
    expect((await keys.list({ projectId: 'acme', ownerId: 'user/1' })).map(item => item.keyId)).toEqual([record.keyId]);
  });

  it('never issues a key it could not store as new', async () => {
    const { store } = await setup();
    const existing = createKeyManager({ prefix: 'acme', store: { ...store, create: async command => {
      if (command.id.startsWith('secret.')) return { record: { scope: command.scope, id: command.id, idempotencyKey: command.idempotencyKey, definitionHash: command.definitionHash, version: 1, state: command.state }, created: false };
      return store.create(command);
    } } });
    await expect(existing.create(owner())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('retries only write conflicts; any other storage error is thrown at once', async () => {
    const { store, keys } = await setup();
    const { key } = await keys.create(owner({ credits: { remaining: 5 } }));
    let updates = 0;
    const failing = createKeyManager({ prefix: 'acme', store: { ...store, update: async () => { updates++; throw new Error('disk full'); } } });
    await expect(failing.verify(key)).rejects.toThrow(/disk full/u);
    expect(updates).toBe(1);
  });

  it('gives up with an error after repeated write conflicts, rather than guessing', async () => {
    const { store, keys } = await setup();
    const { key } = await keys.create(owner({ credits: { remaining: 5 } }));
    const contended = createKeyManager({ prefix: 'acme', store: { ...store, update: async () => { const { StorageError } = await import('@mayura/storage-contracts'); throw new StorageError('CONFLICT', 'changed'); } } });
    await expect(contended.verify(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('cancels before doing anything for a caller who has given up', async () => {
    const { keys, reads } = await setup();
    const { key } = await keys.create(owner());
    const before = reads();
    await expect(keys.verify(key, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(keys.create(owner(), { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(reads()).toBe(before);
  });
});
