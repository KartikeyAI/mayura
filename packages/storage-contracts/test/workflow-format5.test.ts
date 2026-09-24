import { describe, expect, it, vi } from 'vitest';
import { StorageError } from '../src/contracts.js';
import { workflowManifest } from '../src/workflow-format2.js';
import { workflowGraphManifest } from '../src/workflow-format3.js';
import { workflowLifecycleManifest, type WorkflowLifecycleManifest } from '../src/workflow-format5.js';

const hash = 'a'.repeat(64);
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
});
