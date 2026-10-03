import { afterEach, describe, expect, it } from 'vitest';
import type { Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer } from '@mayura/server';
import { createKeyManager, keyAuthenticator, type KeyVerifier } from '../src/index.js';
import { memoryAggregateStore } from '../src/testing.js';

const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const signal = new AbortController().signal;
async function manager() {
  const store = memoryAggregateStore(); await store.initialize();
  return createKeyManager({ store, prefix: 'acme' });
}

describe('keyAuthenticator', () => {
  it('turns a key\'s grant into the identity, no longer than the key or maxIdentityMs, and charges each request', async () => {
    const keys = await manager();
    const { key } = await keys.create({ projectId: 'acme', ownerId: 'service/billing', agentIds: ['support'], capabilities: ['runs:submit'], expiresInMs: 120_000, credits: { remaining: 2 } });
    const authenticate = keyAuthenticator(keys, { maxIdentityMs: 30_000, cost: 1 });
    const identity = await authenticate({ token: key, signal });
    expect(identity).toMatchObject({ scope: { principalId: 'service/billing', projectId: 'acme' }, agentIds: ['support'], capabilities: ['runs:submit'] });
    expect(identity!.expiresAtMs - Date.now()).toBeLessThanOrEqual(30_000);
    expect(await authenticate({ token: key, signal })).not.toBeNull();
    expect(await authenticate({ token: key, signal })).toBeNull();
    expect(await authenticate({ token: 'eyJ.not.ours', signal })).toBeNull();
    expect(authenticate.accepts(key)).toBe(true);
    expect(authenticate.accepts('other_key')).toBe(false);
  });

  it('spends the cost it is given: none at 0, more where more is asked', async () => {
    const keys = await manager();
    const { key, record } = await keys.create({ projectId: 'acme', ownerId: 'user/1', agentIds: [], capabilities: ['runs:read'], credits: { remaining: 4 } });
    await keyAuthenticator(keys, { cost: 0 })({ token: key, signal });
    expect((await keys.get(record.keyId))!.remaining).toBe(4);
    await keyAuthenticator(keys, { cost: 3 })({ token: key, signal });
    expect((await keys.get(record.keyId))!.remaining).toBe(1);
  });

  it('caps the identity at the key\'s own expiry', async () => {
    const keys = await manager();
    const { key, record } = await keys.create({ projectId: 'acme', ownerId: 'user/1', agentIds: [], capabilities: ['runs:read'], expiresInMs: 120_000 });
    await keys.update(record.keyId, { expiresAtMs: Date.now() + 5_000 });
    expect((await keyAuthenticator(keys)({ token: key, signal }))!.expiresAtMs - Date.now()).toBeLessThanOrEqual(5_000);
  });

  it('works with any key verifier, never asks one about keys it does not accept, and refuses bad options', async () => {
    let asked = 0;
    const provider: KeyVerifier = { accepts: key => key.startsWith('prov_'), verify: async () => { asked++; return { ok: true, principalId: 'p/1', projectId: 'acme', agentIds: [], capabilities: ['runs:read'], expiresAtMs: null, remaining: null }; } };
    const authenticate = keyAuthenticator(provider);
    expect((await authenticate({ token: 'prov_123', signal }))!.scope.principalId).toBe('p/1');
    expect(await authenticate({ token: 'acme_123', signal })).toBeNull();
    expect(asked).toBe(1);
    expect(() => keyAuthenticator({} as never)).toThrow(/verifier/u);
    expect(() => keyAuthenticator(provider, { cost: -1 })).toThrow(/cost/u);
    expect(() => keyAuthenticator(provider, { maxIdentityMs: 10 })).toThrow(/maxIdentityMs/u);
  });

  it('lets a key in to Mayura\'s server, and keeps a revoked one out at once', async () => {
    const keys = await manager();
    const { key, record } = await keys.create({ projectId: 'acme', ownerId: 'user/1', agentIds: ['echo'], capabilities: ['runs:read'] });
    const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
    const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
      model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final' as const, output: 1, usage: { costMicros: 0 } }) } });
    const server = createAgentServer({ publicOrigin: 'https://agents.test', agents: [{ agent, permissions: { allow: ['model:fixture'] } }], authenticate: keyAuthenticator(keys) });
    servers.push(server);
    const call = () => server.fetch(new Request('https://agents.test/v1/agents', { headers: { authorization: `Bearer ${key}` } }));
    expect((await call()).status).toBe(200);
    await keys.revoke(record.keyId);
    expect((await call()).status).toBe(401);
  });
});
