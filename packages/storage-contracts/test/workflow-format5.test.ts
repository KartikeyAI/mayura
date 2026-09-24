import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { StorageError } from '../src/contracts.js';
import { workflowManifest } from '../src/workflow-format2.js';
import { workflowGraphManifest } from '../src/workflow-format3.js';
import { assertWorkflowLifecycleStateMatchesManifest, initialWorkflowLifecycleState, workflowLifecycleManifest,
  workflowLifecycleOutputs, workflowLifecycleState, type WorkflowLifecycleManifest } from '../src/workflow-format5.js';

const hash = 'a'.repeat(64);
const policyHash = 'b'.repeat(64);
const runId = 'c'.repeat(64);
const decodeState = (state: unknown) => workflowLifecycleState({ id: runId, state: state as JsonObject });
const manifest = (): WorkflowLifecycleManifest => ({
  format: 5,
  id: 'review-flow',
  version: '1',
  graph: [
    { kind: 'join', id: 'prepared', dependsOn: [] },
    { kind: 'human', id: 'review', dependsOn: ['prepared'], requestKind: 'correction',
      schemaId: 'review/response', schemaDigest: hash, prompt: 'Review the proposed change.',
      context: { kind: 'step', stepId: 'prepared', path: [] },
      subjectDigest: { kind: 'input', path: ['digest'] }, deadlineAtMs: null },
    { kind: 'timer', id: 'deadline', dependsOn: ['review'],
      fireAtMs: { kind: 'input', path: ['deadlineAtMs'] } },
  ],
  result: { kind: 'step', stepId: 'review', path: [] },
});

describe('format-5 workflow lifecycle metadata', () => {
  it('decodes an exact detached and deeply immutable lifecycle manifest', () => {
    const source = manifest();
    const parsed = workflowLifecycleManifest(source);
    expect(parsed).toEqual(source); expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.graph)).toBe(true);
    expect(Object.isFrozen(parsed.graph[1])).toBe(true);
  });

  it('retains only data and enforces correction subject identity', () => {
    const value = manifest();
    expect(JSON.stringify(workflowLifecycleManifest(value))).not.toContain('validate');
    const review = value.graph[1] as Extract<WorkflowLifecycleManifest['graph'][number], { kind: 'human' }>;
    expect(() => workflowLifecycleManifest({ ...value, graph: [value.graph[0], { ...review, subjectDigest: null }, value.graph[2]] })).toThrow(StorageError);
    expect(() => workflowLifecycleManifest({ ...value, graph: [value.graph[0], { ...review, requestKind: 'information' }, value.graph[2]] })).toThrow(StorageError);
  });

  it('requires step bindings to name declared dependencies', () => {
    const value = manifest();
    const timer = value.graph[2] as Extract<WorkflowLifecycleManifest['graph'][number], { kind: 'timer' }>;
    expect(() => workflowLifecycleManifest({ ...value, graph: [value.graph[0], value.graph[1], {
      ...timer, fireAtMs: { kind: 'step', stepId: 'prepared', path: [] },
    }] })).toThrow(StorageError);
  });

  it('validates known literal deadline and subject types at definition admission', () => {
    const value = manifest(); const review = value.graph[1] as Extract<WorkflowLifecycleManifest['graph'][number], { kind: 'human' }>;
    const timer = value.graph[2] as Extract<WorkflowLifecycleManifest['graph'][number], { kind: 'timer' }>;
    expect(() => workflowLifecycleManifest({ ...value, graph: [value.graph[0], review, {
      ...timer, fireAtMs: { kind: 'literal', value: -1 },
    }] })).toThrow(StorageError);
    expect(() => workflowLifecycleManifest({ ...value, graph: [value.graph[0], {
      ...review, subjectDigest: { kind: 'literal', value: 'not-a-digest' },
    }, timer] })).toThrow(StorageError);
  });

  it.each([
    { requestKind: 'approval' }, { schemaDigest: 'A'.repeat(64) }, { schemaId: '../private' },
    { prompt: '' }, { prompt: 'x'.repeat(4_097) }, { extra: true },
  ])('rejects malformed human material (%#)', patch => {
    const value = manifest(); const review = value.graph[1] as object;
    expect(() => workflowLifecycleManifest({ ...value, graph: [value.graph[0], { ...review, ...patch }, value.graph[2]] })).toThrow(StorageError);
  });

  it('bounds lifecycle node cardinality independently of total graph size', () => {
    const humans = Array.from({ length: 33 }, (_, index) => ({ kind: 'human' as const, id: `human${index}`,
      dependsOn: [], requestKind: 'information' as const, schemaId: 'response', schemaDigest: hash,
      prompt: 'Respond.', context: null, subjectDigest: null, deadlineAtMs: null }));
    expect(() => workflowLifecycleManifest({ format: 5, id: 'many', version: '1', graph: humans,
      result: { kind: 'literal', value: null } })).toThrow(StorageError);
  });

  it('keeps all historical format boundaries exact', () => {
    const value = manifest();
    expect(() => workflowManifest(value)).toThrow(StorageError);
    expect(() => workflowGraphManifest(value)).toThrow(StorageError);
    expect(() => workflowLifecycleManifest({ ...value, format: 3 })).toThrow(StorageError);
  });

  it('does not execute accessors at the decoder boundary', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    const value = Object.defineProperty({}, 'format', { enumerable: true, get: getter });
    expect(() => workflowLifecycleManifest(value)).toThrow(StorageError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('creates and decodes a detached dormant lifecycle state', () => {
    const state = initialWorkflowLifecycleState(manifest(), { digest: hash, deadlineAtMs: 100 }, hash, policyHash, 0);
    expect(state).toMatchObject({ format: 5, status: 'running', steps: {
      prepared: { kind: 'join', status: 'pending' }, review: { kind: 'human', status: 'pending' },
      deadline: { kind: 'timer', status: 'pending' },
    } });
    const decoded = decodeState(state);
    expect(decoded).toEqual(state); expect(decoded).not.toBe(state);
    expect(workflowLifecycleOutputs(decoded)).toEqual({});
    assertWorkflowLifecycleStateMatchesManifest(decoded, manifest());
  });

  it('accepts exact human and timer evidence and projects only successful output', () => {
    const state = initialWorkflowLifecycleState(manifest(), { digest: hash, deadlineAtMs: 100 }, hash, policyHash, 0);
    Object.assign(state.steps['prepared']!, { status: 'succeeded', output: [] });
    Object.assign(state.steps['review']!, { status: 'succeeded', requestDigest: hash,
      responseDigest: 'd'.repeat(64), actorId: 'reviewer', output: { accepted: true } });
    Object.assign(state.steps['deadline']!, { status: 'succeeded', fireAtMs: 100, firedAtMs: 101,
      output: { fireAtMs: 100, firedAtMs: 101 } });
    state.status = 'succeeded'; state.output = { accepted: true };
    const decoded = decodeState(state);
    assertWorkflowLifecycleStateMatchesManifest(decoded, manifest());
    expect(workflowLifecycleOutputs(decoded)).toEqual({ prepared: [], review: { accepted: true },
      deadline: { fireAtMs: 100, firedAtMs: 101 } });
  });

  it('accepts restart-safe waiting evidence but rejects invented or inconsistent evidence', () => {
    const state = initialWorkflowLifecycleState(manifest(), { digest: hash, deadlineAtMs: 100 }, hash, policyHash, 0);
    Object.assign(state.steps['prepared']!, { status: 'succeeded', output: [] });
    Object.assign(state.steps['review']!, { status: 'waiting', requestDigest: hash, deadlineAtMs: 100 });
    state.status = 'waiting';
    expect(decodeState(state)).toEqual(state);
    for (const patch of [
      { responseDigest: 'd'.repeat(64) }, { actorId: 'reviewer' }, { output: false }, { requestDigest: 'invalid' },
    ]) {
      const changed = structuredClone(state); Object.assign(changed.steps['review']!, patch);
      expect(() => decodeState(changed)).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    }
    const wrongTimer = structuredClone(state); Object.assign(wrongTimer.steps['review']!, {
      status: 'succeeded', responseDigest: 'd'.repeat(64), actorId: 'reviewer', output: true,
    }); Object.assign(wrongTimer.steps['deadline']!, { status: 'succeeded', fireAtMs: 100, firedAtMs: 101,
      output: { fireAtMs: 99, firedAtMs: 101 } }); wrongTimer.status = 'running';
    expect(() => decodeState(wrongTimer)).toThrow(StorageError);
  });

  it('rejects premature lifecycle success against declared dependencies', () => {
    const state = initialWorkflowLifecycleState(manifest(), { digest: hash, deadlineAtMs: 100 }, hash, policyHash, 0);
    Object.assign(state.steps['review']!, { status: 'succeeded', requestDigest: hash,
      responseDigest: 'd'.repeat(64), actorId: 'reviewer', output: true });
    expect(() => assertWorkflowLifecycleStateMatchesManifest(state, manifest())).toThrow(StorageError);
  });
});
