import type { AggregateStore } from '@mayura/storage-contracts';
import { createKeyManager } from './manager.js';

/** One case of the key manager's behaviour over a store: resolves when it holds, rejects with what did not. */
export interface KeyManagerConformanceCase {
  readonly name: string;
  run(context: { readonly store: AggregateStore }): Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const owner = () => ({ projectId: 'acme', ownerId: 'user/1', agentIds: ['support'], capabilities: ['runs:read', 'runs:submit'] as ('runs:read' | 'runs:submit')[] });
const code = async (work: () => Promise<unknown>): Promise<string | undefined> => {
  try { await work(); return undefined; } catch (error) { return (error as { code?: string }).code ?? 'ERROR'; }
};

/**
 * The key manager's behaviour that depends on its store. Run it over each store you use, with an initialized, empty
 * store per case, as Mayura does over every store it ships.
 */
export const keyManagerConformance: readonly KeyManagerConformanceCase[] = Object.freeze([
  {
    name: 'creates a key whose secret only its creator sees, verifies it, and lists and audits it',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const { key, record } = await keys.create({ ...owner(), name: 'ci' });
      check(/^acme_[0-9A-Za-z]{49}$/u.test(key), 'the key has its prefix, random part and checksum');
      check(!JSON.stringify(record).includes(key.slice(5)), 'the record never holds the secret');
      const verified = await keys.verify(key);
      check(verified.ok && verified.principalId === 'user/1' && verified.projectId === 'acme' && verified.capabilities.join() === 'runs:read,runs:submit', 'the key verifies with its grant');
      check((await keys.get(record.keyId))?.name === 'ci', 'the key can be read by its id');
      check((await keys.list({ projectId: 'acme', ownerId: 'user/1' })).map(item => item.keyId).join() === record.keyId, 'the owner lists the key');
      check((await keys.audit(record.keyId)).map(event => event.type).join() === 'key.created', 'the audit shows its creation');
    },
  },
  {
    name: 'stops a disabled or revoked key at once, and never brings a revoked key back',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const { key, record } = await keys.create(owner());
      await keys.disable(record.keyId);
      const disabled = await keys.verify(key);
      check(!disabled.ok && disabled.reason === 'disabled', 'a disabled key is refused');
      await keys.enable(record.keyId);
      check((await keys.verify(key)).ok, 'an enabled key works again');
      await keys.revoke(record.keyId);
      const revoked = await keys.verify(key);
      check(!revoked.ok && revoked.reason === 'revoked', 'a revoked key is refused');
      check(await code(() => keys.enable(record.keyId)) === 'CONFLICT', 'a revoked key cannot be enabled');
      check((await keys.audit(record.keyId)).map(event => event.type).join() === 'key.created,key.disabled,key.enabled,key.revoked', 'the audit shows each change');
    },
  },
  {
    name: 'refuses a key once it expires',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const { key, record } = await keys.create({ ...owner(), expiresInMs: 60_000 });
      check((await keys.verify(key)).ok, 'the key works before it expires');
      await keys.update(record.keyId, { expiresAtMs: Date.now() + 100 });
      await pause(200);
      const expired = await keys.verify(key);
      check(!expired.ok && expired.reason === 'expired', 'an expired key is refused');
    },
  },
  {
    name: 'rate limits a key per window',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const { key } = await keys.create({ ...owner(), rateLimit: { limit: 2, windowMs: 1_000 } });
      check((await keys.verify(key)).ok && (await keys.verify(key)).ok, 'requests within the limit pass');
      const limited = await keys.verify(key);
      check(!limited.ok && limited.reason === 'rate_limited' && (limited.retryAfterMs ?? 0) > 0, 'a request over the limit is refused, with when to retry');
      await pause(1_100);
      check((await keys.verify(key)).ok, 'the next window allows requests again');
    },
  },
  {
    name: 'spends credits exactly, even when requests race',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const { key, record } = await keys.create({ ...owner(), credits: { remaining: 5 } });
      const results = await Promise.all(Array.from({ length: 10 }, () => keys.verify(key)));
      const passed = results.filter(result => result.ok).length;
      check(passed === 5, `exactly five of ten racing requests pass (got ${passed})`);
      check(results.filter(result => !result.ok && result.reason === 'exhausted').length === 5, 'the rest are refused as exhausted');
      check((await keys.get(record.keyId))?.remaining === 0, 'no credits remain');
    },
  },
  {
    name: 'rotates a key: the new one works at once, the old one only for the overlap',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const old = await keys.create({ ...owner(), credits: { remaining: 9 } });
      // An overlap long enough for two verifications on a slow store (D1 on a loaded runner took over 300 ms).
      const rotatedAt = Date.now(); const rotated = await keys.rotate(old.record.keyId, { overlapMs: 2_000 });
      check(rotated.key !== old.key && rotated.record.keyId !== old.record.keyId, 'rotation makes a new key');
      check((await keys.verify(rotated.key)).ok && (await keys.verify(old.key)).ok, 'both work during the overlap');
      check((await keys.get(old.record.keyId))?.rotatedTo === rotated.record.keyId, 'the old key names its successor');
      check((await keys.get(rotated.record.keyId))?.remaining === 8, 'the new key starts with the old one\'s credits');
      await pause(Math.max(0, rotatedAt + 2_100 - Date.now()));
      check(!(await keys.verify(old.key)).ok && (await keys.verify(rotated.key)).ok, 'after the overlap only the new key works');
      const next = await keys.rotate(rotated.record.keyId);
      const stopped = await keys.verify(rotated.key);
      check(!stopped.ok && stopped.reason === 'revoked' && (await keys.verify(next.key)).ok, 'without an overlap the old key stops at once');
    },
  },
  {
    name: 'keeps an owner within its number of keys, counting only keys that still work',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme', maxKeysPerOwner: 2 });
      const first = await keys.create(owner());
      await keys.create(owner());
      check(await code(() => keys.create(owner())) === 'LIMIT_EXCEEDED', 'a third key is refused');
      await keys.revoke(first.record.keyId);
      await keys.create(owner());
      check((await keys.list({ projectId: 'acme', ownerId: 'user/1' })).length === 2, 'a revoked key makes room, and leaves the list');
    },
  },
  {
    name: 'creates keys for one owner at once without losing any',
    async run({ store }) {
      const keys = createKeyManager({ store, prefix: 'acme' });
      const created = await Promise.all(Array.from({ length: 5 }, () => keys.create(owner())));
      const listed = (await keys.list({ projectId: 'acme', ownerId: 'user/1' })).map(item => item.keyId).sort();
      check(listed.join() === created.map(item => item.record.keyId).sort().join(), `the owner lists all five keys (listed ${listed.length})`);
    },
  },
  {
    name: 'keeps namespaces apart in one store',
    async run({ store }) {
      const live = createKeyManager({ store, prefix: 'acme', namespace: 'live' });
      const test = createKeyManager({ store, prefix: 'acme', namespace: 'test' });
      const { key } = await live.create(owner());
      check((await live.verify(key)).ok, 'the key works in its namespace');
      const elsewhere = await test.verify(key);
      check(!elsewhere.ok && elsewhere.reason === 'not_found', 'the same store does not know it in another namespace');
    },
  },
]);
