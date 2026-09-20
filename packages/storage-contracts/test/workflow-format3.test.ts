import { describe, expect, it, vi } from 'vitest';
import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError } from '../src/contracts.js';
import { workflowManifest, workflowState } from '../src/workflow-format2.js';
import { assertWorkflowGraphStateMatchesManifest, initialWorkflowGraphState, workflowGraphManifest,
  workflowGraphOutputs, workflowGraphResources, workflowGraphState, workflowGraphTargets } from '../src/workflow-format3.js';
import type { WorkflowGraphManifest } from '../src/workflow-graph-contracts.js';

const hash = 'a'.repeat(64); const policy = 'b'.repeat(64); const run = 'c'.repeat(64);
const ref = (id = 'd'.repeat(64)) => ({ kind: 'scheduled-workflow' as const, runId: id, definitionHash: hash, policyHash: policy });
const graph = (): WorkflowGraphManifest => ({ format: 3, id: 'waiting', version: '1', graph: [
  { kind: 'wait', id: 'observe', dependsOn: [], targets: { kind: 'input', path: [] } },
  { kind: 'join', id: 'done', dependsOn: ['observe'] },
], result: { kind: 'step', stepId: 'done', path: [] } });
const state = () => initialWorkflowGraphState(graph(), [ref()], hash, policy, 0);
const decode = (value: unknown) => workflowGraphState({ id: run, state: value as JsonObject });
const fact = () => ({ reference: ref(), outcome: 'outcome_unknown' as const, sourceVersion: 10, sourceEventSequence: 14 });

describe('explicit format-3 workflow graph metadata', () => {
  it('reuses only exact deeply owned manifests while fresh raw material gets a detached validation', () => {
    const raw = graph(); const owned = workflowGraphManifest(raw);
    expect(owned).not.toBe(raw);
    expect(workflowGraphManifest(owned)).toBe(owned);
    expect(Object.isFrozen(owned)).toBe(true); expect(Object.isFrozen(owned.graph)).toBe(true);
    expect(Object.isFrozen(owned.graph[0]!.dependsOn)).toBe(true);
    const copied = workflowGraphManifest(JSON.parse(JSON.stringify(owned)));
    expect(copied).toEqual(owned); expect(copied).not.toBe(owned);
    expect(workflowGraphManifest(copied)).toBe(copied);
  });
  it('fully validates externally shallow- or deep-frozen raw manifests', () => {
    const external = freezeJson(jsonValue(graph()));
    const parsed = workflowGraphManifest(external);
    expect(parsed).toEqual(external); expect(parsed).not.toBe(external);
    const cycle = { ...graph(), graph: [{ kind: 'wait', id: 'observe', dependsOn: ['observe'],
      targets: { kind: 'input', path: [] } }], result: { kind: 'input', path: [] } };
    expect(() => workflowGraphManifest(Object.freeze(cycle))).toThrow(StorageError);
    expect(() => workflowGraphManifest(freezeJson(jsonValue(cycle)))).toThrow(StorageError);
  });
  it('does not retain mutable descendants of a shallow-frozen caller manifest', () => {
    const path: string[] = []; const dependsOn: string[] = [];
    const raw = Object.freeze({ format: 3, id: 'caller', version: '1', graph: [{ kind: 'wait', id: 'observe',
      dependsOn, targets: { kind: 'input', path } }], result: { kind: 'input', path: [] } });
    const owned = workflowGraphManifest(raw);
    path.push('constructor'); dependsOn.push('observe');
    expect(owned.graph[0]).toMatchObject({ dependsOn: [], targets: { kind: 'input', path: [] } });
    expect(workflowGraphManifest(owned)).toBe(owned);
    expect(() => workflowGraphManifest(raw)).toThrow(StorageError);
  });
  it('does not trust frozen wrappers, accessor clones or mutable state because an owned manifest exists', () => {
    const owned = workflowGraphManifest(graph()); const getter = vi.fn(() => owned.graph);
    const wrapper = Object.freeze(Object.defineProperty({ ...owned }, 'graph', { enumerable: true, get: getter }));
    expect(() => workflowGraphManifest(wrapper)).toThrow(StorageError); expect(getter).not.toHaveBeenCalled();
    const mutable = state(); decode(mutable); mutable.steps['observe']!.candidateHash = hash;
    expect(() => decode(mutable)).toThrow(StorageError);
  });
  it('retains real wait nodes and pins immutable ordered target bindings', () => {
    const source = graph(); const parsed = workflowGraphManifest(source);
    expect(parsed).toEqual(source); expect(Object.isFrozen(parsed.graph[0])).toBe(true);
    expect(workflowGraphTargets(parsed, [ref(), ref('e'.repeat(64))])).toEqual({ observe: [ref(), ref('e'.repeat(64))] });
    expect(workflowGraphResources({}, parsed)).toEqual({});
    expect(() => workflowGraphResources({ observe: ['resource'] }, parsed)).toThrow(StorageError);
  });
  it('keeps both format boundaries strict', () => {
    expect(() => workflowManifest(graph())).toThrow(StorageError);
    expect(() => workflowState({ id: run, state: state() as unknown as JsonObject })).toThrow(StorageError);
    expect(() => workflowGraphManifest({ ...graph(), format: 2 })).toThrow(StorageError);
    expect(() => decode({ ...state(), format: 2 })).toThrow(StorageError);
  });
  it.each([
    { kind: 'step', stepId: 'done', path: [] }, { kind: 'input', path: ['constructor'] },
    { kind: 'input', path: [], extra: true }, { kind: 'literal', value: [] },
  ])('rejects unsafe target bindings (%#)', targets => {
    const value = graph(); expect(() => workflowGraphManifest({ ...value, graph: [{ ...value.graph[0], targets }, value.graph[1]] })).toThrow(StorageError);
  });
  it.each([[], [ref(), ref()], [ref(), { ...ref('e'.repeat(64)), policyHash: 'f'.repeat(64) }],
    Array.from({ length: 33 }, (_, i) => ref(i.toString(16).padStart(64, '0'))), [{ ...ref(), secret: 'private' }], null,
  ])('rejects malformed or unbounded resolved targets (%#)', value => {
    expect(() => workflowGraphTargets(graph(), value)).toThrow(StorageError);
  });
  it('accepts exactly 128 edges across waits and rejects 129', () => {
    const targets = Array.from({ length: 32 }, (_, i) => ref(i.toString(16).padStart(64, '0')));
    const value = { ...graph(), graph: Array.from({ length: 4 }, (_, i) => ({ kind: 'wait' as const, id: `n${i}`, dependsOn: [], targets: { kind: 'input' as const, path: [] } })), result: { kind: 'input' as const, path: [] } };
    expect(Object.values(workflowGraphTargets(value, targets)).flat()).toHaveLength(128);
    expect(() => workflowGraphTargets({ ...value, graph: [...value.graph, { kind: 'wait', id: 'extra', dependsOn: [], targets: { kind: 'literal', value: [ref()] } }] }, targets)).toThrow(StorageError);
  });
  it('creates detached format-3 state and only projects succeeded wait metadata', () => {
    const current = state(); expect(current.format).toBe(3); expect(current.steps['observe']?.kind).toBe('wait');
    expect(decode(current)).toEqual(current); expect(workflowGraphOutputs(current)).toEqual({});
    current.steps['observe']!.status = 'succeeded'; current.steps['observe']!.output = [fact()];
    assertWorkflowGraphStateMatchesManifest(current, graph());
    const outputs = workflowGraphOutputs(current); expect(outputs['observe']).toEqual([fact()]);
    (outputs['observe'] as JsonValue[]).push(null); expect(current.steps['observe']!.output).toEqual([fact()]);
  });
  it.each(['approved', 'dispatching', 'unknown', 'blocked'])('rejects impossible wait status %s', status => {
    const current = state(); Object.assign(current.steps['observe']!, { status }); expect(() => decode(current)).toThrow(StorageError);
  });
  it.each([
    { costReserved: 1 }, { candidateHash: hash }, { approval: { digest: hash, expiresAt: 100, humanId: null } },
    { receipt: { callId: `${run}/step:observe`, toolId: 'fake', execution: 'succeeded', disclosure: 'released' } },
    { output: [fact()] }, { secret: 'private' },
    { status: 'succeeded', output: [] }, { status: 'succeeded', output: [{ ...fact(), secret: 'private' }] },
  ])('rejects wait effect or disclosure forgery (%#)', patch => {
    const current = state(); Object.assign(current.steps['observe']!, patch); expect(() => decode(current)).toThrow(StorageError);
  });
  it('checks resolved observation identity/order, self-reference and pinned policy against the graph', () => {
    const current = state(); current.steps['observe']!.status = 'succeeded'; current.steps['observe']!.output = [{ ...fact(), reference: ref('e'.repeat(64)) }];
    expect(() => assertWorkflowGraphStateMatchesManifest(current, graph())).toThrow(StorageError);
    const self = initialWorkflowGraphState(graph(), [ref(run)], hash, policy, 0);
    self.steps['observe']!.status = 'succeeded'; self.steps['observe']!.output = [{ ...fact(), reference: ref(run) }];
    expect(() => decode(self)).toThrow(StorageError);
    expect(() => initialWorkflowGraphState(graph(), [ref()], hash, 'f'.repeat(64), 0)).toThrow(StorageError);
  });
  it('rejects premature dependency success and forged tool effects', () => {
    const current = state(); current.steps['done']!.status = 'succeeded'; current.steps['done']!.output = [[]];
    expect(() => assertWorkflowGraphStateMatchesManifest(current, graph())).toThrow(StorageError);
  });
  it.each(['waiting', 'failed', 'succeeded'] as const)('rejects premature wait activation (%s)', status => {
    const manifest = { ...graph(), graph: [
      { kind: 'join' as const, id: 'before', dependsOn: [] },
      { kind: 'wait' as const, id: 'observe', dependsOn: ['before'], targets: { kind: 'input' as const, path: [] } },
    ], result: { kind: 'input' as const, path: [] } };
    const current = initialWorkflowGraphState(manifest, [ref()], hash, policy, 0);
    current.steps['observe']!.status = status;
    if (status === 'succeeded') current.steps['observe']!.output = [fact()];
    expect(() => assertWorkflowGraphStateMatchesManifest(current, manifest)).toThrow(StorageError);
  });
  it.each(['cancelled', 'failed', 'blocked', 'outcome_unknown'] as const)('rejects unresolved waits on a terminal %s parent', status => {
    const current = state(); current.status = status; current.steps['observe']!.status = 'waiting';
    expect(() => decode(current)).toThrow(StorageError);
  });
  it('rejects a join that invents output instead of collecting its admitted dependencies', () => {
    const current = state(); current.steps['observe']!.status = 'succeeded'; current.steps['observe']!.output = [fact()];
    current.steps['done']!.status = 'succeeded'; current.steps['done']!.output = ['fabricated'];
    expect(() => assertWorkflowGraphStateMatchesManifest(current, graph())).toThrow(StorageError);
  });
  it('does not execute accessors or expose their content at codec boundaries', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE'); });
    const value = Object.defineProperty({}, 'format', { enumerable: true, get: getter });
    expect(() => workflowGraphManifest(value)).toThrow(StorageError);
    expect(() => workflowGraphTargets(graph(), value)).toThrow(StorageError);
    expect(() => decode(value)).toThrow(StorageError);
    expect(getter).not.toHaveBeenCalled();
  });
});
