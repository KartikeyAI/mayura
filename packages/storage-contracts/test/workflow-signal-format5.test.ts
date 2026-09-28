import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { StorageError } from '../src/contracts.js';
import { assertWorkflowLifecycleStateMatchesManifest, initialWorkflowLifecycleState, workflowLifecycleManifest,
  workflowLifecycleOutputs, workflowLifecycleState, type WorkflowLifecycleManifest } from '../src/workflow-format5.js';

const hash = 'a'.repeat(64);
const runId = 'c'.repeat(64);
const manifest = (signal: Record<string, unknown> = {}): WorkflowLifecycleManifest => ({
  format: 5, id: 'orders', version: '1',
  graph: [
    { kind: 'join', id: 'placed', dependsOn: [] },
    { kind: 'signal', id: 'paid', dependsOn: ['placed'], name: 'payment.received', deadlineAtMs: { kind: 'input', path: ['payBy'] }, ...signal } as never,
  ],
  result: { kind: 'step', stepId: 'paid', path: [] },
});
const decode = (state: unknown) => workflowLifecycleState({ id: runId, state: state as JsonObject });
const fresh = () => initialWorkflowLifecycleState(manifest(), {}, hash, hash, 0);

describe('format-5 signal steps', () => {
  it('admits exact signal node material and refuses malformed, duplicate or extra fields', () => {
    expect(workflowLifecycleManifest(manifest()).graph[1]).toEqual(manifest().graph[1]);
    expect(workflowLifecycleManifest(manifest({ deadlineAtMs: null })).graph[1]).toMatchObject({ deadlineAtMs: null });
    for (const bad of [{ name: '../x' }, { name: '' }, { name: 7 }, { deadlineAtMs: { kind: 'literal', value: -1 } }, { payload: 'x' },
      { deadlineAtMs: { kind: 'step', stepId: 'other', path: [] } }]) {
      expect(() => workflowLifecycleManifest(manifest(bad))).toThrow(StorageError);
    }
    const duplicate = manifest(); const second = { ...duplicate.graph[1], id: 'paid2' };
    expect(() => workflowLifecycleManifest({ ...duplicate, graph: [...duplicate.graph, second] })).toThrow(StorageError);
  });

  it('starts pending with no signal and accepts every consistent status', () => {
    const state = fresh();
    expect(state.steps['paid']).toEqual({ kind: 'signal', status: 'pending', callId: 'step:paid', output: null,
      signalId: null, payloadDigest: null, receivedAtMs: null, deadlineAtMs: null });
    const received = { signalId: 'pay-1', payloadDigest: hash, receivedAtMs: 5, output: { amountCents: 1 } };
    const valid = [
      { status: 'pending', ...received },
      { status: 'waiting', deadlineAtMs: 10 },
      { status: 'succeeded', deadlineAtMs: 10, ...received },
      { status: 'timed_out', deadlineAtMs: 10 },
      { status: 'skipped' }, { status: 'bypassed' },
    ];
    for (const change of valid) {
      const next = structuredClone(state) as unknown as { status: string; steps: Record<string, Record<string, unknown>> };
      Object.assign(next.steps['paid']!, change);
      if (change.status === 'waiting') next.status = 'waiting';
      if (change.status === 'succeeded' || change.status === 'bypassed') Object.assign(next.steps['placed']!, { status: 'succeeded', candidateHash: null });
      expect(() => decode(next)).not.toThrow();
    }
  });

  it('refuses states whose signal fields contradict their status', () => {
    const received = { signalId: 'pay-1', payloadDigest: hash, receivedAtMs: 5, output: 1 };
    const invalid = [
      { status: 'waiting', ...received }, { status: 'succeeded' }, { status: 'succeeded', ...received, payloadDigest: null },
      { status: 'timed_out' }, { status: 'timed_out', deadlineAtMs: 1, ...received }, { status: 'pending', deadlineAtMs: 1 },
      { status: 'skipped', ...received }, { status: 'bypassed', deadlineAtMs: 1 }, { status: 'pending', output: 1 },
      { status: 'pending', ...received, signalId: '../x' }, { status: 'pending', ...received, payloadDigest: 'x' }, { status: 'unknown' },
      { extra: true },
    ];
    for (const change of invalid) {
      const next = structuredClone(fresh()) as unknown as { status: string; steps: Record<string, Record<string, unknown>> };
      Object.assign(next.steps['paid']!, change);
      if (change.status === 'waiting') next.status = 'waiting';
      expect(() => decode(next), JSON.stringify(change)).toThrow(StorageError);
    }
  });

  it('exposes a received payload as the step output and requires a declared deadline for a recorded one', () => {
    const state = fresh();
    Object.assign(state.steps['placed']!, { status: 'succeeded' });
    Object.assign(state.steps['paid']!, { status: 'succeeded', signalId: 'pay-1', payloadDigest: hash, receivedAtMs: 5, output: { amountCents: 3 } });
    expect(workflowLifecycleOutputs(state)['paid']).toEqual({ amountCents: 3 });
    const withDeadline = structuredClone(state); Object.assign(withDeadline.steps['paid']!, { deadlineAtMs: 10 });
    expect(() => assertWorkflowLifecycleStateMatchesManifest(withDeadline, manifest())).not.toThrow();
    expect(() => assertWorkflowLifecycleStateMatchesManifest(withDeadline, manifest({ deadlineAtMs: null }))).toThrow(StorageError);
  });
});
