import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type Schema } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage';
import { createWebhookRuntime, defineWebhookTrigger, type WebhookRequest, type WebhookRuntime } from '../src/webhooks.js';
import type { WorkStreamFixture } from './fixtures.js';

interface Input { readonly action: string }
const scope = { principalId: 'operator', projectId: 'project' };
const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const schema: Schema<Input, Input> = { '~standard': { version: 1, vendor: 'webhook-conformance',
  validate: value => value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { action?: unknown }).action === 'string'
    ? { value: { action: (value as { action: string }).action } } : { issues: [{ message: 'action required' }] },
  types: undefined as unknown as { input: Input; output: Input } } };

function signed(body: unknown, deliveryId = 'delivery-1', timestampMs = 1_000): WebhookRequest {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(`${timestampMs}.${deliveryId}.`).update(bytes).digest('hex');
  return { deliveryId, timestampMs, body: bytes, signature: `sha256=${signature}` };
}

/** The same authenticated ingress semantics run against every reference aggregate adapter. */
export function webhookConformance(name: string, factory: () => Promise<WorkStreamFixture>): void {
  describe(`${name} webhook trigger conformance`, () => {
    let fixture: WorkStreamFixture; let store: AggregateStore; let runtime: WebhookRuntime; let calls: number;
    const create = (overrides: Partial<Parameters<typeof createWebhookRuntime>[0]> = {}) => createWebhookRuntime({
      store, scope, now: () => 1_000, resolveSecret: async () => secret, ...overrides,
    });
    const trigger = (dispatch: (input: Input, context: { readonly deliveryId: string; readonly commandId: string; readonly signal: AbortSignal }) => unknown) => defineWebhookTrigger({
      id: 'deploy', version: '1.0.0', secretId: 'webhook-secret', schemaId: 'deploy-input-v1', schemaDigest: 'a'.repeat(64), input: schema,
      dispatch: async (input, context) => { calls += 1; return dispatch(input, context) as never; },
    });

    beforeEach(async () => { fixture = await factory(); store = fixture.store; await store.initialize(); runtime = create(); calls = 0; });
    afterEach(async () => { vi.restoreAllMocks(); runtime?.close(); await store?.close(); await fixture?.cleanup(); });

    it('authenticates, validates, dispatches, and exposes bounded durable history', async () => {
      const result = await runtime.receive(trigger(input => ({ accepted: input.action })), signed({ action: 'release' }));
      expect(result).toMatchObject({ triggerId: 'deploy', deliveryId: 'delivery-1', status: 'succeeded', output: { accepted: 'release' } });
      expect(result.id).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(result)).toBe(true); expect(calls).toBe(1);
      expect((await runtime.inspect(result.id)).output).toEqual({ accepted: 'release' });
      const events = await runtime.events(result.id); expect(events.map(event => event.type)).toEqual(['webhook.admitted', 'webhook.dispatching', 'webhook.succeeded']);
      expect(Object.isFrozen(events)).toBe(true); expect(Object.isFrozen(events[0])).toBe(true);
    });

    it('deduplicates a delivery across fresh signatures without redispatching', async () => {
      let now = 1_000; runtime.close(); runtime = create({ now: () => now }); const definition = trigger(() => ({ accepted: true }));
      const first = await runtime.receive(definition, signed({ action: 'release' }, 'retry', now)); now = 1_500;
      const second = await runtime.receive(definition, signed({ action: 'release' }, 'retry', now));
      expect(second).toEqual(first); expect(calls).toBe(1);
      await expect(runtime.receive(definition, signed({ action: 'different' }, 'retry', now))).rejects.toMatchObject({ code: 'CONFLICT' });
      // The documented public error, not a raw storage error.
      await expect(runtime.receive(definition, signed({ action: 'different' }, 'retry', now))).rejects.toBeInstanceOf(MayuraError);
      expect(calls).toBe(1);
    });

    it('rejects conflicting content while the first delivery is still active', async () => {
      let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
      const definition = trigger(async input => { await waiting; return { accepted: input.action }; });
      const first = runtime.receive(definition, signed({ action: 'first' }, 'concurrent'));
      await vi.waitFor(() => expect(calls).toBe(1));
      await expect(runtime.receive(definition, signed({ action: 'second' }, 'concurrent'))).rejects.toMatchObject({ code: 'CONFLICT' });
      release(); expect((await first).status).toBe('succeeded'); expect(calls).toBe(1);
    });

    it('rejects invalid authentication, replay windows, and bodies before persistence or dispatch', async () => {
      let creates = 0; const observed: AggregateStore = { ...store, create: async command => { creates += 1; return store.create(command); } };
      runtime.close(); runtime = create({ store: observed }); const definition = trigger(() => ({ unreachable: true }));
      const valid = signed({ action: 'release' }); const invalid = { ...valid, signature: `sha256=${'0'.repeat(64)}` };
      await expect(runtime.receive(definition, invalid)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(runtime.receive(definition, signed({ action: 'release' }, 'late', 500_000))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(runtime.receive(definition, signed({ wrong: true }, 'invalid'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(creates).toBe(0); expect(calls).toBe(0);
    });

    it('makes failed dispatch terminal and never replays an uncertain effect', async () => {
      const definition = trigger(() => { throw new Error('PRIVATE PROVIDER DETAIL'); });
      const first = await runtime.receive(definition, signed({ action: 'release' }, 'failed'));
      expect(first).toMatchObject({ status: 'outcome_unknown', output: null }); expect(calls).toBe(1);
      expect(await runtime.receive(definition, signed({ action: 'release' }, 'failed'))).toEqual(first); expect(calls).toBe(1);
    });

    it('recovers an abandoned dispatch and withholds its late result', async () => {
      let release!: (value: { accepted: boolean }) => void; let commandId!: string;
      const waiting = new Promise<{ accepted: boolean }>(resolve => { release = resolve; });
      const definition = trigger((_input, context) => { commandId = context.commandId; return waiting; });
      const receiving = runtime.receive(definition, signed({ action: 'release' }, 'abandoned'));
      await vi.waitFor(() => expect(commandId).toMatch(/^[a-f0-9]{64}$/));
      const recovery = create(); const competingRecovery = create();
      const [recovered, repeated] = await Promise.all([recovery.recoverAbandoned(commandId), competingRecovery.recoverAbandoned(commandId)]);
      expect(recovered.status).toBe('outcome_unknown'); expect(repeated).toEqual(recovered); release({ accepted: true });
      expect(await receiving).toEqual(recovered); expect((await runtime.inspect(commandId)).output).toBeNull(); recovery.close(); competingRecovery.close();
    });

    it('retains timed-out callback admission until the underlying callback settles', async () => {
      let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
      runtime.close(); runtime = create({ callbackTimeoutMs: 10, maxPendingCallbacks: 1, resolveSecret: async () => { await waiting; return secret; } });
      const definition = trigger(() => ({ accepted: true }));
      await expect(runtime.receive(definition, signed({ action: 'one' }, 'one'))).rejects.toMatchObject({ code: 'TIMEOUT' });
      await expect(runtime.receive(definition, signed({ action: 'two' }, 'two'))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      release(); await vi.waitFor(async () => expect((await runtime.receive(definition, signed({ action: 'three' }, 'three'))).status).toBe('succeeded'));
    });

    it('validates definition identity and event queries at the public boundary', async () => {
      expect(() => defineWebhookTrigger({ id: 'bad', version: '1', secretId: 'secret', schemaId: 'schema', schemaDigest: 'bad', input: schema, dispatch: () => null }))
        .toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
      await expect(runtime.events('bad')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(runtime.events('a'.repeat(64), -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('sanitizes secret resolver failures before dispatch', async () => {
      runtime.close(); runtime = create({ resolveSecret: async () => { throw new Error('PRIVATE SECRET STORE DETAIL'); } });
      const error: unknown = await runtime.receive(trigger(() => null), signed({ action: 'release' })).catch(caught => caught);
      expect(error).toMatchObject({ code: 'PERMISSION_DENIED' }); expect(JSON.stringify(error)).not.toContain('PRIVATE'); expect(calls).toBe(0);
    });
  });
}
