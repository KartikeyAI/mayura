import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createWorkflowLifecycleHost, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-host-test', validate: value => ({ value: value as JsonValue }) } };
const timer = defineWorkflowLifecycle({ id: 'host-timer', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }],
  result: { kind: 'step', stepId: 'wake', path: [] } });

describe('hosted lifecycle coordinator on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; });

  it('runs bounded full sweeps and continuously advances due work until stopped', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize(); const clock = { value: 100 };
    const host = createWorkflowLifecycleHost({ store, definitions: [timer], intervalMs: 5, maxBackoffMs: 20,
      scope: { principalId: 'host', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1',
      maxCostMicros: 0, now: () => clock.value });
    const submitted = await host.runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'timer' });
    const first = await host.runOnce(); expect(first.completedSweep).toBe(true);
    expect(await host.runtime.inspect(submitted.id)).toMatchObject({ status: 'waiting' });
    host.start(); clock.value = 500;
    for (let attempt = 0; attempt < 100 && (await host.runtime.inspect(submitted.id)).status !== 'succeeded'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(await host.runtime.inspect(submitted.id)).toMatchObject({ status: 'succeeded' });
    await host.stop(); expect(host.status()).toMatchObject({ running: false, consecutiveFailures: 0, lastError: null });
    await host.close(); expect(await store.read('missing', 'missing')).toBeUndefined();
  });

  it('coalesces concurrent manual cycles and rejects duplicate definition catalogs', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize();
    const host = createWorkflowLifecycleHost({ store, definitions: [timer], scope: { principalId: 'host', projectId: 'project' },
      permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
    const first = host.runOnce(); const second = host.runOnce(); expect(second).toBe(first); await first; await host.close();
    expect(() => createWorkflowLifecycleHost({ store: store!, definitions: [timer, timer], scope: { principalId: 'host', projectId: 'project' },
      permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
