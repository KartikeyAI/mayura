import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError } from '@mayura/core';
import { createWorkflowLeadership, createWorkflowWorker, type WorkflowWorkerUnit } from '../src/index.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const scope = { principalId: 'ops', projectId: 'workers' };
function unit(name: string, log: string[]): WorkflowWorkerUnit & { active: () => boolean } {
  let active = false;
  return { start: () => { active = true; log.push(`${name}:start`); }, stop: async () => { active = false; log.push(`${name}:stop`); },
    drain: async () => { active = false; log.push(`${name}:drain`); return { drained: true, interrupted: 0 }; }, active: () => active };
}

describe('durable leadership and worker supervision on SQLite', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });
  const open = async () => { fixture = await sqliteFixture(); await fixture.store.initialize(); return fixture.store; };

  it('grants one holder, renews without advancing the fence and fails over only after expiry or release', async () => {
    const store = await open(); const clock = { value: 1_000 };
    const lease = (holderId: string) => createWorkflowLeadership({ store, scope, role: 'lifecycle-host', holderId, leaseMs: 9_000, now: () => clock.value });
    const a = lease('replica-a'); const b = lease('replica-b');
    expect(await a.acquire()).toMatchObject({ leader: true, fence: 1, holderId: 'replica-a' }); expect(a.isLeader()).toBe(true);
    expect(await b.acquire()).toMatchObject({ leader: false, fence: 1, holderId: 'replica-a' }); expect(b.isLeader()).toBe(false);
    clock.value = 5_000; expect(await a.acquire()).toMatchObject({ leader: true, fence: 1, expiresAtMs: 14_000 });
    // The holder stops trusting its lease a third of the duration before expiry, to tolerate clock skew.
    clock.value = 11_001; expect(a.isLeader()).toBe(false); expect((await b.acquire()).leader).toBe(false);
    clock.value = 14_001; expect(await b.acquire()).toMatchObject({ leader: true, fence: 2, holderId: 'replica-b' });
    expect(await a.acquire()).toMatchObject({ leader: false, holderId: 'replica-b' }); expect(a.isLeader()).toBe(false);
    await b.release(); expect(b.isLeader()).toBe(false);
    expect(await a.acquire()).toMatchObject({ leader: true, fence: 3 });
    const other = createWorkflowLeadership({ store, scope, role: 'composite-host', holderId: 'replica-b', leaseMs: 9_000, now: () => clock.value });
    expect((await other.acquire()).leader).toBe(true);
    expect(() => createWorkflowLeadership({ store, scope, role: 'bad role', holderId: 'a' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createWorkflowLeadership({ store, scope, role: 'x', holderId: 'a', leaseMs: 100 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('elects exactly one leader among concurrent contenders', async () => {
    const store = await open();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      createWorkflowLeadership({ store, scope, role: 'contended', holderId: `replica-${index}` }).acquire()));
    expect(results.filter(result => result.leader)).toHaveLength(1); expect(new Set(results.map(result => result.holderId)).size).toBe(1);
  });

  it('runs units only on the leader and hands over when the leader drains', async () => {
    const store = await open(); const log: string[] = [];
    const replica = (name: string) => { const work = unit(name, log);
      return { work, worker: createWorkflowWorker({ units: [work], renewIntervalMs: 100,
        leadership: createWorkflowLeadership({ store, scope, role: 'handover', holderId: name, leaseMs: 3_000 }) }) }; };
    const a = replica('a'); a.worker.start(); await vi.waitFor(() => expect(a.work.active()).toBe(true), { timeout: 2_000 });
    const b = replica('b'); b.worker.start(); await vi.waitFor(() => expect(b.worker.status().lastConfirmedAtMs).not.toBeNull(), { timeout: 2_000 });
    expect(b.work.active()).toBe(false); expect(a.worker.status()).toMatchObject({ leader: true, fence: 1, unitsActive: true });
    expect(a.worker.isReady()).toBe(true); expect(b.worker.isReady()).toBe(true);
    expect(await a.worker.drain({ timeoutMs: 1_000 })).toEqual({ drained: true, interrupted: 0 }); expect(a.worker.isReady()).toBe(false);
    await vi.waitFor(() => expect(b.work.active()).toBe(true), { timeout: 2_000 });
    expect(b.worker.status()).toMatchObject({ leader: true, fence: 2 }); expect(log).toContain('a:drain');
    await b.worker.drain({ timeoutMs: 1_000 });
  });

  it('stops driving and reports not ready when leadership cannot be confirmed', async () => {
    const log: string[] = []; const work = unit('solo', log); let healthy = true;
    const leadership = { acquire: vi.fn(async () => { if (!healthy) throw new MayuraError('STORAGE_UNAVAILABLE', 'PRIVATE');
      return { leader: true, fence: 4, holderId: 'solo', expiresAtMs: Date.now() + 10_000 }; }), release: vi.fn(async () => {}), isLeader: () => healthy };
    const worker = createWorkflowWorker({ units: [work], leadership, renewIntervalMs: 100 }); worker.start();
    await vi.waitFor(() => expect(work.active()).toBe(true), { timeout: 2_000 }); healthy = false;
    await vi.waitFor(() => expect(work.active()).toBe(false), { timeout: 2_000 });
    expect(worker.isReady()).toBe(false); expect(worker.status()).toMatchObject({ leader: false, lastError: 'STORAGE_UNAVAILABLE' });
    await worker.drain(); expect(leadership.release).toHaveBeenCalledOnce();
    const single = createWorkflowWorker({ units: [unit('alone', log)], renewIntervalMs: 100 }); single.start();
    await vi.waitFor(() => expect(single.status().unitsActive).toBe(true)); await single.drain();
    expect(() => createWorkflowWorker({ units: [] })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
