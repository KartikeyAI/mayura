import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Budget, type Authorizer } from '@mayura/core';
import { invokeTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAggregateFrontendToolStore, type FrontendToolStore } from '@mayura/storage-contracts';
import { createAgUiFrontendTools, type AgUiFrontendTools } from '../src/index.js';
import { frontendInternals } from '../src/frontend-tools.js';

const scope = { principalId: 'alice', projectId: 'shop' }; const signal = () => new AbortController().signal;
let directory: string; let database: ReturnType<typeof createSqliteStore>; const services: AgUiFrontendTools[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-durable-frontend-'));
  database = createSqliteStore({ filename: join(directory, 'journal.sqlite') }); await database.initialize(); });
afterEach(async () => { for (const service of services.splice(0)) service.close(); await database.close(); vi.useRealTimers();
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-durable-frontend-`)) throw new Error('Unsafe cleanup path');
  await rm(directory, { recursive: true, force: true }); });
function replica(version = '1', provided?: FrontendToolStore) {
  const require = vi.fn(async () => {});
  const store = provided ?? createAggregateFrontendToolStore(database, { permissions: { allow: ['frontend-tools:store'] } });
  const service = createAgUiFrontendTools({ agentId: 'support', store, permissions: { allow: ['ag-ui:frontend-tools'] },
    authorization: { require } as unknown as Authorizer, limits: { pollIntervalMs: 5 } }); services.push(service);
  const tool = service.defineTool({ id: 'ui.select', version, description: 'Choose an item.', input: z.object({ item: z.number() }),
    output: z.object({ selected: z.number() }), capabilities: [], effects: 'none', costMicros: 3, timeoutMs: 10_000 });
  return { service, tool, broker: frontendInternals(service), require, store,
    wire: { name: tool.id, description: tool.description, parameters: tool.inputJsonSchema! } };
}
async function pending() {
  const owner = replica(); const receiver = replica(); const controller = new AbortController(); const budget = new Budget(100, 10);
  await receiver.broker.bind(scope, 'native-1', 'thread-1', [receiver.wire]);
  const outcome = invokeTool(owner.tool, { item: 7 }, { runId: 'native-1', callId: 'c1', scope, signal: controller.signal, budget,
    permissions: { allow: ['tool:ui.select', 'frontend:ui.select'] } });
  await vi.waitFor(async () => expect(await receiver.broker.pending(scope, 'native-1')).toBe(true));
  const dispatch = (await receiver.broker.dispatch(scope, 'native-1', 'thread-1', 'ui-1', signal()))!;
  return { owner, receiver, controller, budget, outcome, dispatch };
}
const message = (content = '{"selected":7}') => ({ id: 'r1', role: 'tool' as const, toolCallId: 'wire-c1', content });

describe('shared durable frontend bridge (offline)', () => {
  it('receives a result on a restarted HTTP replica and delivers it once to the original native owner', async () => {
    const f = await pending(); const claim = await f.receiver.broker.claim(f.dispatch.token, scope, signal()); f.receiver.service.close();
    const restarted = replica(); await expect(restarted.broker.claim(f.dispatch.token, scope, signal())).rejects.toMatchObject({ code: 'FRONTEND_RESULT_CONFLICT' });
    await restarted.broker.result(f.dispatch.token, claim.claimId, scope, 'thread-1', 'ui-2', message(), 'wire-c1', signal());
    expect(await f.outcome).toMatchObject({ status: 'succeeded', output: { selected: 7 } });
    await restarted.broker.result(f.dispatch.token, claim.claimId, scope, 'thread-1', 'ui-2', message(), 'wire-c1', signal());
    expect(await restarted.service.outboxes({ scope, runId: 'native-1' })).toMatchObject([{ status: 'settled', delivery: 'reserved' }]);
    expect(await restarted.broker.pending(scope, 'native-1')).toBe(false);
  });
  it('keeps an unconsumed outbox after owner loss without reopening the browser claim', async () => {
    const f = await pending(); const claim = await f.receiver.broker.claim(f.dispatch.token, scope, signal()); f.owner.service.close(); await f.outcome;
    await f.receiver.broker.result(f.dispatch.token, claim.claimId, scope, 'thread-1', 'ui-2', message(), 'wire-c1', signal());
    const restarted = replica(); const view = await restarted.service.outboxes({ scope, runId: 'native-1' });
    expect(view).toMatchObject([{ status: 'settled', delivery: 'pending', purged: false }]);
    expect(JSON.stringify(view)).not.toContain(f.dispatch.token); expect(JSON.stringify(view)).not.toContain('selected');
    await expect(restarted.broker.claim(f.dispatch.token, scope, signal())).rejects.toMatchObject({ code: 'FRONTEND_RESULT_CONFLICT' });
    expect(await restarted.broker.dispatch(scope, 'native-1', 'thread-1', 'ui-3', signal())).toBeUndefined();
  });
  it('keeps native output validation authoritative across replicas', async () => {
    const f = await pending(); const claim = await f.receiver.broker.claim(f.dispatch.token, scope, signal());
    await f.receiver.broker.result(f.dispatch.token, claim.claimId, scope, 'thread-1', 'ui-2', message('{"selected":"PRIVATE"}'), 'wire-c1', signal());
    const result = await f.outcome; expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('denies changed definitions, cross-scope requests and revoked result authorization without consuming the claim', async () => {
    const f = await pending(); const claim = await f.receiver.broker.claim(f.dispatch.token, scope, signal()); const changed = replica('2');
    await expect(changed.broker.inspect(f.dispatch.token, scope)).rejects.toMatchObject({ code: 'FRONTEND_CALL_UNAVAILABLE' });
    await expect(f.receiver.broker.inspect(f.dispatch.token, { ...scope, projectId: 'other' })).rejects.toMatchObject({ code: 'FRONTEND_CALL_UNAVAILABLE' });
    f.receiver.require.mockRejectedValueOnce(new Error('PRIVATE_POLICY'));
    await expect(f.receiver.broker.result(f.dispatch.token, claim.claimId, scope, 'thread-1', 'ui-2', message(), 'wire-c1', signal())).rejects.toMatchObject({ code: 'FRONTEND_ACCESS_DENIED' });
    expect((await f.receiver.store.read({ scope, agentId: 'support', token: f.dispatch.token }))?.outbox).toBeNull();
    f.controller.abort(); await f.outcome;
    expect((await f.receiver.store.read({ scope, agentId: 'support', token: f.dispatch.token }))?.status).toBe('claimed');
  });
  it('fails closed on an ambiguous claim commit without retrying the browser admission', async () => {
    const f = await pending(); const claim = vi.fn(async (...args: Parameters<FrontendToolStore['claim']>) => {
      await f.receiver.store.claim(...args); throw new Error('commit reply lost');
    });
    const uncertain = replica('1', { ...f.receiver.store, claim });
    await expect(uncertain.broker.claim(f.dispatch.token, scope, signal())).rejects.toMatchObject({ code: 'FRONTEND_STORE_UNAVAILABLE' });
    expect(claim).toHaveBeenCalledTimes(1);
    await expect(f.receiver.broker.claim(f.dispatch.token, scope, signal())).rejects.toMatchObject({ code: 'FRONTEND_RESULT_CONFLICT' });
    f.controller.abort(); await f.outcome;
  });
  it('retains capacity for timed-out storage work until the driver actually settles', async () => {
    const base = replica(); let release!: (value: Awaited<ReturnType<FrontendToolStore['calls']>>) => void;
    const delayed = new Promise<Awaited<ReturnType<FrontendToolStore['calls']>>>(resolve => { release = resolve; });
    const calls = vi.fn(() => delayed);
    const service = createAgUiFrontendTools({ agentId: 'support', store: { ...base.store, calls },
      permissions: { allow: ['ag-ui:frontend-tools'] }, authorization: { require: async () => {} } as unknown as Authorizer,
      limits: { maxStorageOperations: 1, storageTimeoutMs: 5 } }); services.push(service);
    await expect(service.outboxes({ scope, runId: 'native-1' })).rejects.toMatchObject({ code: 'FRONTEND_STORE_UNAVAILABLE' });
    await expect(service.outboxes({ scope, runId: 'native-1' })).rejects.toMatchObject({ code: 'FRONTEND_STORE_BUSY' });
    expect(calls).toHaveBeenCalledTimes(1); release([]);
    await vi.waitFor(async () => expect(await service.outboxes({ scope, runId: 'native-1' })).toEqual([]));
  });

});
