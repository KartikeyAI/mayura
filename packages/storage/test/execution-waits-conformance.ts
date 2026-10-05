import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import {
  workflowHashMaterial,
  type Claim, type ExecutionCompletion, type ExecutionRef, type ExecutionWaitAggregateStore,
  type ExecutionWaitStore, type ExecutionWaitStreamKey, type ScheduledWorkflowSnapshot,
  type ScheduledWrite, type WorkflowManifest, type WorkflowPolicyManifest,
} from '@mayura/storage-contracts';
import type { ExecutionWaitFixture } from './execution-waits-fixtures.js';

/** The hosted Windows runner, where 127 sequential durable writes can outlast a 15 s budget. */
const slowRunner = process.env['CI'] === 'true' && process.platform === 'win32';

const digest = (domain: string, value: unknown) => createHash('sha256').update(workflowHashMaterial(domain, value)).digest('hex');
const policy: WorkflowPolicyManifest = {
  scope: { principalId: 'completion-principal', projectId: 'completion-project' },
  permissions: ['tool:completion-tool', 'effect:read'], policyVersion: 'completion-v1', maxCostMicros: 30,
  maxOutputBytes: 65_536, approvalTtlMs: 60_000,
};
const scope = digest('mayura:scope:v1', policy.scope);
const policyHash = digest('mayura:policy:v1', { ...policy, permissions: [...policy.permissions].sort() });
const stream: ExecutionWaitStreamKey = { scope, policyHash, streamId: 'completion-stream' };
const manifest = (approval = false): WorkflowManifest => ({ id: 'completion-workflow', version: '1', graph: [{
  id: 'work', kind: 'tool', dependsOn: [], tool: 'completion-tool', toolVersion: '1', effects: 'read', capabilities: [],
  costMicros: 3, approval, input: { kind: 'literal', value: null },
}], result: { kind: 'step', stepId: 'work', path: [] } });
interface Target {
  readonly reference: ExecutionRef;
  readonly access: { readonly scope: string; readonly id: string; readonly policyHash: string };
  snapshot: ScheduledWorkflowSnapshot;
  claim?: Claim;
  jobId?: string;
}
const outcomes = ['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'] as const;
type Terminal = typeof outcomes[number];

/** Same finite semantic command and race suite runs against both real SQL adapters. */
export function executionWaitConformance(name: string, factory: () => Promise<ExecutionWaitFixture>): void {
  describe(`${name} durable execution completion waits`, () => {
    let fixture: ExecutionWaitFixture;
    let store: ExecutionWaitAggregateStore;
    let waits: ExecutionWaitStore;
    let stores: ExecutionWaitAggregateStore[];
    const key = (id: string) => ({ ...stream, id });
    const command = async (target: Target): Promise<ScheduledWrite> => {
      target.snapshot = await store.workflows.inspect(target.access);
      return { ...target.access, expectedVersion: target.snapshot.record.version, commandId: randomUUID() };
    };
    const submit = async (idempotencyKey: string = randomUUID(), approval = false, pinnedPolicy = policy): Promise<Target> => {
      const result = await store.workflows.submit({ manifest: manifest(approval), policy: pinnedPolicy, resources: {},
        idempotencyKey, input: { private: 'SECRET_TARGET_INPUT' } });
      const reference: ExecutionRef = { kind: 'scheduled-workflow', runId: result.snapshot.record.id,
        definitionHash: result.snapshot.manifestHash, policyHash: result.snapshot.policyHash };
      return { reference, snapshot: result.snapshot,
        access: { scope: result.snapshot.record.scope, id: reference.runId, policyHash: reference.policyHash } };
    };
    const finish = async (target: Target, outcome: Terminal): Promise<void> => {
      if (outcome === 'cancelled') {
        target.snapshot = await store.workflows.cancel(await command(target)); return;
      }
      if (outcome === 'failed' || outcome === 'blocked') {
        await store.workflows.failNode({ ...await command(target), nodeId: 'work', outcome });
        target.snapshot = await store.workflows.advance(await command(target)); return;
      }
      await store.workflows.prepare({ ...await command(target), nodeId: 'work', input: null });
      const claim = (await store.workflows.claim({ ...target.access, workerId: 'completion-worker', limit: 1, leaseMs: 60_000 }))[0]!;
      target.claim = claim.claim; target.jobId = claim.job.jobId;
      await store.workflows.start({ ...await command(target), claim: claim.claim, input: null });
      const receipt = { callId: claim.job.intent['callId'] as string, toolId: 'completion-tool',
        execution: outcome === 'succeeded' ? 'succeeded' as const : 'unknown' as const, disclosure: 'withheld' as const };
      await store.workflows.recordReceipt({ ...target.access, jobId: claim.job.jobId, fence: claim.claim.fence, evidenceId: 'initial-evidence', receipt });
      if (outcome === 'succeeded') {
        await store.workflows.complete({ ...await command(target), claim: claim.claim, evidenceId: 'initial-evidence', outcome: 'succeeded', output: 'SECRET_TOOL_OUTPUT' });
        target.snapshot = await store.workflows.finalize({ ...await command(target), validation: 'passed', output: 'SECRET_FINAL_OUTPUT' });
      } else target.snapshot = await store.workflows.advance(await command(target));
    };
    const register = (id: string, targets: readonly Target[]) => waits.register({ ...key(id), targets: targets.map(target => target.reference) });
    const reopen = async () => {
      const other = fixture.reopen(); stores.push(other); await other.initialize();
      await other.workflows.initialize(); await other.executionWaits.initialize(); await other.executionWaits.open(stream); return other;
    };
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; stores = [store]; await store.initialize(); await store.workflows.initialize();
      waits = store.executionWaits; await waits.initialize(); await waits.open(stream);
    });
    afterEach(async () => { for (const current of stores ?? []) await current.close(); await fixture?.cleanup(); });

    it('opens one pinned stream idempotently and exposes separate optional storage capability', async () => {
      expect(waits).toBeDefined(); await waits.initialize(); await waits.open(stream); await waits.open(stream);
      const events = await waits.events({ ...stream, after: 0 });
      expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ sequence: 1, data: {} });
      await expect(waits.open({ ...stream, policyHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await waits.events({ ...stream, after: 0 })).toEqual(events);
    });

    it.each(outcomes)('automatically publishes %s and resolves pre-completion registration without copying content', async outcome => {
      const target = await submit(); const pending = await register('join', [target]);
      expect(pending).toMatchObject({ status: 'waiting', version: 1, targets: [target.reference], observations: [] });
      await finish(target, outcome);
      // Inspect is read-only: publication itself does not mutate an unrelated wait.
      expect(await waits.inspect(key('join'))).toEqual(pending);
      const facts = await fixture.query(`SELECT * FROM ${fixture.prefix}mayura_execution_completions WHERE scope = ? AND run_id = ?`, [scope, target.reference.runId]);
      expect(facts).toHaveLength(1);
      const results = await waits.drainReady({ ...stream, limit: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: 'join', status: 'resolved', version: 2,
        observations: [{ reference: target.reference, outcome, sourceVersion: target.snapshot.record.version }] });
      const observation = results[0]!.observations[0]!;
      expect(observation.sourceEventSequence).toBe((await store.events(scope, target.reference.runId)).at(-1)!.sequence);
      expect(Object.keys(observation).sort()).toEqual(['outcome', 'reference', 'sourceEventSequence', 'sourceVersion']);
      expect(JSON.stringify([results, await waits.events({ ...stream, after: 0 })])).not.toContain('SECRET');
      expect(Object.isFrozen(results)).toBe(true); expect(Object.isFrozen(results[0])).toBe(true);
      expect(Object.isFrozen(observation.reference)).toBe(true);
    });

    it('registers an already completed run at version one and reuses its immutable fact', async () => {
      const target = await submit(); await finish(target, 'succeeded');
      const before = await store.workflows.inspect(target.access); const history = await store.events(scope, target.reference.runId);
      const first = await waits.materialize({ scope, reference: target.reference });
      expect(await waits.materialize({ scope, reference: target.reference })).toEqual(first);
      const result = await register('late-registration', [target]);
      expect(result).toMatchObject({ version: 1, status: 'resolved', observations: [first] });
      expect((await waits.events({ ...stream, after: 0 })).map(event => event.type)).toEqual(['stream.created', 'wait.registered', 'wait.resolved']);
      expect(await store.workflows.inspect(target.access)).toEqual(before);
      expect(await store.events(scope, target.reference.runId)).toEqual(history);
    });

    it('leaves existing running and approval targets pending without dispatch or history writes', async () => {
      const running = await submit(); const approval = await submit('requires-human', true);
      approval.snapshot = await store.workflows.requestApproval({ ...await command(approval), nodeId: 'work', input: null });
      const histories = await Promise.all([running, approval].map(target => store.events(scope, target.reference.runId)));
      expect(await waits.materialize({ scope, reference: running.reference })).toBeUndefined();
      expect(await waits.materialize({ scope, reference: approval.reference })).toBeUndefined();
      const wait = await register('pending-targets', [running, approval]);
      for (let index = 0; index < 3; index++) {
        expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
        expect(await waits.inspect(key(wait.id))).toEqual(wait);
      }
      expect(await Promise.all([running, approval].map(target => store.events(scope, target.reference.runId)))).toEqual(histories);
      expect((await store.workflows.inspect(running.access)).jobs).toEqual([]);
      expect((await store.workflows.inspect(approval.access)).jobs).toEqual([]);
    });

    it('preserves declared target order rather than completion order and waits for every outcome', async () => {
      const first = await submit(); const second = await submit(); const third = await submit();
      await register('ordered', [third, first, second]);
      await finish(second, 'failed'); await finish(first, 'blocked');
      expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
      await finish(third, 'cancelled');
      const resolved = (await waits.drainReady({ ...stream, limit: 1 }))[0]!;
      expect(resolved.observations.map(item => item.reference.runId)).toEqual([third, first, second].map(item => item.reference.runId));
      expect(resolved.observations.map(item => item.outcome)).toEqual(['cancelled', 'blocked', 'failed']);
    });

    it('makes inspect, event reads, no-op drains and identical retries genuinely read-only', async () => {
      const target = await submit(); const pending = await register('idempotent', [target]);
      const before = await waits.events({ ...stream, after: 0 });
      for (let index = 0; index < 4; index++) {
        expect(await waits.inspect(key('idempotent'))).toEqual(pending);
        expect(await register('idempotent', [target])).toEqual(pending);
        expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
      }
      expect(await waits.events({ ...stream, after: 0 })).toEqual(before);
      await finish(target, 'cancelled'); await waits.drainReady({ ...stream, limit: 32 });
      const resolved = await waits.inspect(key('idempotent')); const terminalHistory = await waits.events({ ...stream, after: 0 });
      expect(await register('idempotent', [target])).toEqual(resolved);
      expect(await waits.cancel(key('idempotent'))).toEqual(resolved);
      expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
      expect(await waits.events({ ...stream, after: 0 })).toEqual(terminalHistory);
    });

    it('keeps missing wait inspection distinct from cancellation and returns scoped event cursors', async () => {
      expect(await waits.inspect(key('absent'))).toBeUndefined();
      await expect(waits.cancel(key('absent'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const target = await submit(); await register('one', [target]); await waits.cancel(key('one'));
      const all = await waits.events({ ...stream, after: 0 });
      expect(all.map(event => event.sequence)).toEqual(all.map((_, index) => index + 1));
      expect(await waits.events({ ...stream, after: all[0]!.sequence })).toEqual(all.slice(1));
      expect(await waits.events({ ...stream, after: all.at(-1)!.sequence })).toEqual([]);
      for (const event of all) expect(Object.keys(event.data)).toEqual(event.sequence === 1 ? [] : ['waitId']);
    });

    it('rejects access to unopened streams instead of fabricating an empty journal or wait', async () => {
      const unopened = { ...stream, streamId: 'never-opened' };
      await expect(waits.inspect({ ...unopened, id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(waits.events({ ...unopened, after: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(waits.drainReady({ ...unopened, limit: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('conflicts on changed ordered content under one immutable wait identity', async () => {
      const first = await submit(); const second = await submit();
      const expected = await register('stable', [first, second]);
      const events = await waits.events({ ...stream, after: 0 });
      await expect(register('stable', [second, first])).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(register('stable', [first])).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await register('stable', [first, second])).toEqual(expected);
      expect(await waits.events({ ...stream, after: 0 })).toEqual(events);
    });

    it('validates the complete target list before creating or journaling any wait', async () => {
      const valid = await submit(); await finish(valid, 'succeeded');
      const absent = { ...valid.reference, runId: 'f'.repeat(64) };
      const before = await waits.events({ ...stream, after: 0 });
      await expect(waits.register({ ...key('invalid-tail'), targets: [valid.reference, absent] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await waits.inspect(key('invalid-tail'))).toBeUndefined();
      expect(await waits.events({ ...stream, after: 0 })).toEqual(before);
    });

    it.each(['definition', 'policy', 'scope'] as const)('rejects a reference with wrong %s without mutating its stream', async mismatch => {
      const target = await submit();
      const reference = { ...target.reference, ...(mismatch === 'definition' ? { definitionHash: 'd'.repeat(64) } : mismatch === 'policy' ? { policyHash: 'e'.repeat(64) } : {}) };
      const request = { scope: mismatch === 'scope' ? 'c'.repeat(64) : scope, reference };
      await expect(waits.materialize(request)).rejects.toMatchObject({ code: mismatch === 'scope' ? 'NOT_FOUND' : 'CONFLICT' });
      const before = await waits.events({ ...stream, after: 0 });
      if (mismatch !== 'scope') await expect(waits.register({ ...key('wrong'), targets: [reference] })).rejects.toBeDefined();
      expect(await waits.inspect(key('wrong'))).toBeUndefined();
      expect(await waits.events({ ...stream, after: 0 })).toEqual(before);
    });

    it('rejects valid aggregate identities that are not enrolled scheduled workflows', async () => {
      const id = 'a'.repeat(64); const definitionHash = 'b'.repeat(64);
      await store.create({ scope, id, idempotencyKey: 'ordinary', definitionHash, state: { arbitrary: true }, events: [] });
      await expect(waits.materialize({ scope, reference: { kind: 'scheduled-workflow', runId: id, definitionHash, policyHash } })).rejects.toBeDefined();
    });

    it.each([
      { kind: 'ephemeral', runId: 'a'.repeat(64), definitionHash: 'b'.repeat(64), policyHash },
      { kind: 'scheduled-workflow', runId: 'A'.repeat(64), definitionHash: 'b'.repeat(64), policyHash },
      { kind: 'scheduled-workflow', runId: 'a'.repeat(63), definitionHash: 'b'.repeat(64), policyHash },
      { kind: 'scheduled-workflow', runId: 'a'.repeat(64), definitionHash: 'b'.repeat(64), policyHash, output: 'SECRET_FORGED' },
    ])('rejects malformed references before touching persisted waits: %#', async reference => {
      const before = await waits.events({ ...stream, after: 0 });
      await expect(waits.register({ ...key('malformed'), targets: [reference as ExecutionRef] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await waits.inspect(key('malformed'))).toBeUndefined(); expect(await waits.events({ ...stream, after: 0 })).toEqual(before);
    });

    it('rejects empty, duplicate, oversized target lists and invalid bounded drain/cursor commands', async () => {
      const target = await submit();
      for (const targets of [[], [target.reference, target.reference], Array.from({ length: 33 }, () => target.reference)]) {
        await expect(waits.register({ ...key('invalid-list'), targets })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      }
      for (const limit of [0, -1, 33, 1.5, Number.NaN]) await expect(waits.drainReady({ ...stream, limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      for (const after of [-1, 1.5, Number.NaN]) await expect(waits.events({ ...stream, after })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await waits.inspect(key('invalid-list'))).toBeUndefined();
    });

    it('accepts the full 32-target bound and retains every ordered terminal observation', async () => {
      const targets: Target[] = [];
      for (let index = 0; index < 32; index++) targets.push(await submit());
      await register('full-target-list', targets);
      for (const target of [...targets].reverse()) await finish(target, 'cancelled');
      const result = (await waits.drainReady({ ...stream, limit: 32 }))[0]!;
      expect(result.status).toBe('resolved'); expect(result.observations).toHaveLength(32);
      expect(result.observations.map(item => item.reference)).toEqual(targets.map(item => item.reference));
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
    }, 15_000);

    it('pins policy for every stream method and isolates equal stream/wait IDs across scopes', async () => {
      const target = await submit(); await register('same', [target]);
      const anotherPolicy = { ...policy, scope: { ...policy.scope, projectId: 'other-project' } };
      const other = await submit('other-scope', false, anotherPolicy);
      const otherStream = { ...stream, scope: other.access.scope, policyHash: other.reference.policyHash };
      await waits.open(otherStream); expect(await waits.inspect({ ...otherStream, id: 'same' })).toBeUndefined();
      await waits.register({ ...otherStream, id: 'same', targets: [other.reference] });
      await waits.cancel({ ...otherStream, id: 'same' });
      expect((await waits.inspect(key('same')))?.status).toBe('waiting');
      const wrong = { ...key('same'), policyHash: 'e'.repeat(64) };
      await expect(waits.inspect(wrong)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(waits.cancel(wrong)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(waits.drainReady({ ...wrong, limit: 1 })).rejects.toBeDefined();
      await expect(waits.events({ ...wrong, after: 0 })).rejects.toBeDefined();
    });

    it('cancels only the wait and preserves the targets for independent completion', async () => {
      const target = await submit(); await register('cancel-me', [target]);
      const before = await store.workflows.inspect(target.access);
      const cancelled = await waits.cancel(key('cancel-me'));
      expect(cancelled).toMatchObject({ version: 2, status: 'cancelled', observations: [] });
      expect(await store.workflows.inspect(target.access)).toEqual(before);
      expect(await waits.cancel(key('cancel-me'))).toEqual(cancelled);
      await finish(target, 'succeeded');
      expect(await waits.drainReady({ ...stream, limit: 1 })).toEqual([]);
      expect(await register('cancel-me', [target])).toEqual(cancelled);
    });

    it('recovers registration and target completion races across independent adapter owners', async () => {
      const other = await reopen(); const target = await submit();
      await Promise.all([
        waits.register({ ...key('race'), targets: [target.reference] }),
        other.workflows.cancel({ ...target.access, commandId: 'cancel-race', expectedVersion: target.snapshot.record.version }),
      ]);
      await waits.drainReady({ ...stream, limit: 32 });
      expect(await other.executionWaits.inspect(key('race'))).toMatchObject({ status: 'resolved', observations: [{ outcome: 'cancelled' }] });
    });

    it('deduplicates concurrent registration and lets two drainers resolve every wait exactly once', async () => {
      const other = await reopen(); const target = await submit();
      const same = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? waits : other.executionWaits).register({ ...key('same'), targets: [target.reference] })));
      expect(same.every(item => item.definitionHash === same[0]!.definitionHash && item.version === 1)).toBe(true);
      await register('second', [target]); await register('third', [target]); await finish(target, 'cancelled');
      const pages = await Promise.all([waits.drainReady({ ...stream, limit: 2 }), other.executionWaits.drainReady({ ...stream, limit: 2 })]);
      expect(pages.flat().map(item => item.id).sort()).toEqual(['same', 'second', 'third']);
      expect(new Set(pages.flat().map(item => item.id)).size).toBe(3);
      expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
      expect((await waits.events({ ...stream, after: 0 })).filter(event => event.type === 'wait.resolved')).toHaveLength(3);
    });

    it('serializes cancellation versus ready resolution with one permanent winner', async () => {
      const other = await reopen(); const target = await submit(); await register('race', [target]); await finish(target, 'failed');
      await Promise.all([waits.cancel(key('race')), other.executionWaits.drainReady({ ...stream, limit: 1 })]);
      const result = await waits.inspect(key('race'));
      expect(result?.version).toBe(2); expect(['resolved', 'cancelled']).toContain(result?.status);
      const before = await waits.events({ ...stream, after: 0 });
      expect(before.filter(event => event.type === 'wait.resolved' || event.type === 'wait.cancelled')).toHaveLength(1);
      await waits.cancel(key('race')); await waits.drainReady({ ...stream, limit: 1 });
      expect(await waits.inspect(key('race'))).toEqual(result); expect(await waits.events({ ...stream, after: 0 })).toEqual(before);
    });

    it('uses registration sequence, not identifier order, for deterministic bounded ready pages', async () => {
      const target = await submit(); const order = ['z.last-lexically', 'a.first-lexically', 'm.middle'];
      for (const id of order) await register(id, [target]); await finish(target, 'succeeded');
      expect((await waits.drainReady({ ...stream, limit: 2 })).map(item => item.id)).toEqual(order.slice(0, 2));
      expect((await waits.drainReady({ ...stream, limit: 2 })).map(item => item.id)).toEqual(order.slice(2));
      expect(await waits.drainReady({ ...stream, limit: 2 })).toEqual([]);
    });

    it('retains waits and immutable observations across close/reopen without a live worker', async () => {
      const target = await submit(); const registered = await register('persisted', [target]); await store.close();
      store = await reopen(); waits = store.executionWaits;
      expect(await waits.inspect(key('persisted'))).toEqual(registered);
      await finish(target, 'blocked'); const completed = await waits.drainReady({ ...stream, limit: 32 }); await store.close();
      store = await reopen(); waits = store.executionWaits;
      expect(await waits.inspect(key('persisted'))).toEqual(completed[0]);
      expect(await register('persisted', [target])).toEqual(completed[0]);
    });

    it('materializes old terminal sources without rewriting workflow version or event history', async () => {
      const target = await submit(); await finish(target, 'succeeded');
      await fixture.query(`DELETE FROM ${fixture.prefix}mayura_execution_completions WHERE scope = ? AND run_id = ?`, [scope, target.reference.runId]);
      const before = await store.workflows.inspect(target.access); const history = await store.events(scope, target.reference.runId);
      expect(await waits.materialize({ scope, reference: target.reference })).toMatchObject({ outcome: 'succeeded', sourceVersion: before.record.version });
      expect(await store.workflows.inspect(target.access)).toEqual(before); expect(await store.events(scope, target.reference.runId)).toEqual(history);
      const result = await register('old', [target]); expect(result).toMatchObject({ status: 'resolved', version: 1 });
    });

    it('keeps an unknown terminal observation immutable when late known receipt evidence arrives', async () => {
      const target = await submit(); await finish(target, 'outcome_unknown');
      const initial = await register('unknown', [target]); const original = initial.observations[0]!;
      const job = target.snapshot.jobs[0]!;
      await store.workflows.recordReceipt({ ...target.access, jobId: target.jobId!, fence: target.claim!.fence, evidenceId: 'late-known',
        receipt: { callId: job.intent['callId'] as string, toolId: 'completion-tool', execution: 'succeeded', disclosure: 'withheld' } });
      const current = await store.workflows.inspect(target.access);
      expect(current.record.version).toBeGreaterThan(original.sourceVersion);
      expect(await waits.materialize({ scope, reference: target.reference })).toEqual(original);
      expect(await waits.inspect(key('unknown'))).toEqual(initial);
      expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
    });

    it('enforces the lifetime wait cap under concurrent insertion and never evicts cancelled entries', async () => {
      const other = await reopen(); const target = await submit();
      for (let index = 0; index < 127; index++) await register(`retained-${index}`, [target]);
      await waits.cancel(key('retained-0'));
      const attempts = await Promise.allSettled([register('last-a', [target]), other.executionWaits.register({ ...key('last-b'), targets: [target.reference] })]);
      expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find(item => item.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'LIMIT_EXCEEDED' } });
      expect((await waits.inspect(key('retained-0')))?.status).toBe('cancelled');
      await expect(register('overflow', [target])).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await waits.inspect(key('overflow'))).toBeUndefined();
      await finish(target, 'cancelled');
      const resolved = []; for (let page = 0; page < 4; page++) resolved.push(...await waits.drainReady({ ...stream, limit: 32 }));
      expect(resolved).toHaveLength(127); expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
      const journal = await waits.events({ ...stream, after: 0 });
      expect(journal).toHaveLength(257);
      expect(await waits.events({ ...stream, after: 256 })).toEqual(journal.slice(256));
    }, slowRunner ? 45_000 : 15_000);

    it.each(['digest', 'column', 'extra-data'] as const)('rejects a corrupt completion %s before exposing or resolving its observation', async corruption => {
      const target = await submit(); await register('corrupt-fact', [target]); await finish(target, 'succeeded');
      const rows = await fixture.query(`SELECT * FROM ${fixture.prefix}mayura_execution_completions WHERE scope = ? AND run_id = ?`, [scope, target.reference.runId]);
      const stored = rows[0]!;
      if (corruption === 'digest') {
        await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_completions SET digest = ? WHERE scope = ? AND run_id = ?`, ['f'.repeat(64), scope, target.reference.runId]);
      } else if (corruption === 'column') {
        await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_completions SET outcome = ? WHERE scope = ? AND run_id = ?`, ['failed', scope, target.reference.runId]);
      } else {
        const data = JSON.parse(stored['data'] as string) as JsonObject; data['SECRET_unrecognized'] = 'SECRET_fact';
        await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_completions SET data = ? WHERE scope = ? AND run_id = ?`, [JSON.stringify(data), scope, target.reference.runId]);
      }
      const before = await waits.events({ ...stream, after: 0 });
      const result = await Promise.allSettled([waits.materialize({ scope, reference: target.reference }), waits.drainReady({ ...stream, limit: 1 })]);
      expect(result.every(item => item.status === 'rejected')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(await waits.events({ ...stream, after: 0 })).toEqual(before);
    });

    it.each(['sourceVersion', 'sourceEventSequence'] as const)('rejects a consistently rehashed fact whose %s is beyond the current source', async counter => {
      const target = await submit(); await finish(target, 'cancelled');
      const rows = await fixture.query(`SELECT data FROM ${fixture.prefix}mayura_execution_completions WHERE scope = ? AND run_id = ?`, [scope, target.reference.runId]);
      const fact = JSON.parse(rows[0]!['data'] as string) as ExecutionCompletion;
      const changed = { ...fact, [counter]: fact[counter] + 100 };
      const column = counter === 'sourceVersion' ? 'source_version' : 'source_event_sequence';
      await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_completions SET ${column} = ?, data = ?, digest = ? WHERE scope = ? AND run_id = ?`,
        [changed[counter], workflowHashMaterial('fixture', changed).slice('fixture\n'.length), digest('mayura:execution-completion:v1', { scope, ...changed }), scope, target.reference.runId]);
      await expect(waits.materialize({ scope, reference: target.reference })).rejects.toBeDefined();
      await expect(register('future-fact', [target])).rejects.toBeDefined();
      expect(await waits.inspect(key('future-fact'))).toBeUndefined();
    });

    it.each(['missing-target', 'wrong-ordinal', 'snapshot-extra', 'version-column'] as const)('fails a ready drain atomically when the wait %s projection is corrupt', async corruption => {
      const first = await submit(); const second = await submit(); await register('bad-projection', [first, second]);
      await finish(first, 'cancelled'); await finish(second, 'cancelled');
      const parameters = [scope, stream.streamId, 'bad-projection'];
      if (corruption === 'missing-target') {
        await fixture.query(`DELETE FROM ${fixture.prefix}mayura_execution_wait_targets WHERE scope = ? AND stream_id = ? AND wait_id = ? AND ordinal = 1`, parameters);
      } else if (corruption === 'wrong-ordinal') {
        await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_wait_targets SET ordinal = 3 WHERE scope = ? AND stream_id = ? AND wait_id = ? AND ordinal = 1`, parameters);
      } else if (corruption === 'version-column') {
        await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_waits SET version = 2 WHERE scope = ? AND stream_id = ? AND wait_id = ?`, parameters);
      } else {
        const rows = await fixture.query(`SELECT data FROM ${fixture.prefix}mayura_execution_waits WHERE scope = ? AND stream_id = ? AND wait_id = ?`, parameters);
        const snapshot = JSON.parse(rows[0]!['data'] as string) as JsonObject; snapshot['SECRET_unrecognized'] = 'SECRET_wait';
        await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_waits SET data = ? WHERE scope = ? AND stream_id = ? AND wait_id = ?`, [JSON.stringify(snapshot), ...parameters]);
      }
      const history = await fixture.query(`SELECT sequence, type, data FROM ${fixture.prefix}mayura_execution_wait_events WHERE scope = ? AND stream_id = ? ORDER BY sequence`, [scope, stream.streamId]);
      await expect(waits.inspect(key('bad-projection'))).rejects.toBeDefined();
      await expect(waits.drainReady({ ...stream, limit: 32 })).rejects.toBeDefined();
      expect(await fixture.query(`SELECT sequence, type, data FROM ${fixture.prefix}mayura_execution_wait_events WHERE scope = ? AND stream_id = ? ORDER BY sequence`, [scope, stream.streamId])).toEqual(history);
    });

    it('rejects corrupt event metadata without returning private fields', async () => {
      const target = await submit(); await register('event-corruption', [target]);
      await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_wait_events SET data = ? WHERE scope = ? AND stream_id = ? AND sequence = 2`,
        [JSON.stringify({ waitId: 'event-corruption', SECRET_extra: 'SECRET_event' }), scope, stream.streamId]);
      const result = await Promise.allSettled([waits.events({ ...stream, after: 0 })]);
      expect(result[0]?.status).toBe('rejected'); expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('rejects journal terminal labels inconsistent with the retained wait during reads and reopen', async () => {
      const target = await submit(); await finish(target, 'cancelled');
      const resolved = await register('journal-mismatch', [target]); expect(resolved.status).toBe('resolved');
      await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_wait_events SET type = ? WHERE scope = ? AND stream_id = ? AND type = ?`,
        ['wait.cancelled', scope, stream.streamId, 'wait.resolved']);
      // Only one redundant label is corrupt: the immutable wait and its fact remain unchanged.
      await expect(waits.inspect(key('journal-mismatch'))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      const replies = await Promise.allSettled([waits.events({ ...stream, after: 0 }), waits.open(stream)]);
      expect(replies.map(reply => reply.status)).toEqual(['rejected', 'rejected']);
      for (const reply of replies) if (reply.status === 'rejected') expect(reply.reason).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('rejects a redundant stream capacity counter inconsistent with retained wait rows', async () => {
      const target = await submit(); await register('counted', [target]);
      await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_streams SET wait_count = 0 WHERE scope = ? AND stream_id = ?`, [scope, stream.streamId]);
      await expect(register('not-counted', [target])).rejects.toBeDefined();
      const rows = await fixture.query(`SELECT wait_id FROM ${fixture.prefix}mayura_execution_waits WHERE scope = ? AND stream_id = ? ORDER BY wait_id`, [scope, stream.streamId]);
      expect(rows.map(item => item['wait_id'])).toEqual(['counted']);
    });

    it.each(['publication-before', 'publication-after', 'resolution-before', 'resolution-after'] as const)(
      'recovers atomic target facts and wait journals after a process kill at %s commit', async phase => {
        const target = await submit(); const pending = await register('process-boundary', [target]);
        if (phase.startsWith('resolution')) await finish(target, 'cancelled');
        const before = await store.workflows.inspect(target.access);
        const history = await waits.events({ ...stream, after: 0 });
        const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/execution-wait-child.mjs', import.meta.url))], {
          env: { ...process.env, MAYURA_EXECUTION_WAIT_FIXTURE: JSON.stringify({ ...fixture.childOptions, phase, stream,
            cancel: { ...target.access, commandId: 'child-cancel', expectedVersion: before.record.version } }) },
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            let output = '';
            child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('ready\n')) resolve(); });
            child.once('error', () => reject(new Error('Execution-wait fixture process could not start.')));
            child.once('exit', () => reject(new Error('Execution-wait fixture exited before its durable boundary.')));
            timer = setTimeout(() => reject(new Error('Execution-wait fixture did not reach its durable boundary.')), 8_000);
          });
        } finally { if (timer) clearTimeout(timer); child.kill('SIGKILL'); await exited; }
        if (phase === 'publication-before') {
          expect(await store.workflows.inspect(target.access)).toEqual(before);
          expect(await waits.materialize({ scope, reference: target.reference })).toBeUndefined();
          expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
          await finish(target, 'cancelled');
        } else {
          expect((await store.workflows.inspect(target.access)).record.state['status']).toBe('cancelled');
          expect(await waits.materialize({ scope, reference: target.reference })).toMatchObject({ outcome: 'cancelled' });
        }
        if (phase === 'resolution-after') {
          expect(await waits.inspect(key('process-boundary'))).toMatchObject({ status: 'resolved', version: 2 });
          expect(await waits.drainReady({ ...stream, limit: 32 })).toEqual([]);
        } else {
          expect(await waits.inspect(key('process-boundary'))).toEqual(pending);
          expect(await waits.events({ ...stream, after: 0 })).toEqual(history);
          expect(await waits.drainReady({ ...stream, limit: 32 })).toHaveLength(1);
        }
        const result = await waits.inspect(key('process-boundary'));
        expect(result).toMatchObject({ status: 'resolved', version: 2, observations: [{ outcome: 'cancelled' }] });
        expect((await waits.events({ ...stream, after: 0 })).filter(event => event.type === 'wait.resolved')).toHaveLength(1);
      }, 15_000,
    );
  });
}
