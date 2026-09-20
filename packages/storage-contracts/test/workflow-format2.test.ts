import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import type { ExecutionReceipt, JsonObject, JsonValue } from '@mayura/core';
import { StorageError } from '../src/contracts.js';
import type { WorkflowManifest, WorkflowPolicyManifest } from '../src/scheduled-workflow-contracts.js';
import {
  assertWorkflowStateMatchesManifest, initialWorkflowState, mergeWorkflowReceipt, resolveWorkflowBinding,
  workflowHashMaterial, workflowManifest, workflowOutputs, workflowPolicy, workflowResources, workflowState,
  type WorkflowFormat2State,
} from '../src/workflow-format2.js';

function manifest(): WorkflowManifest {
  return { id: 'calc', version: '1', graph: [
    { id: 'first', kind: 'tool', dependsOn: [], tool: 'increment', toolVersion: '1', effects: 'none', capabilities: [], costMicros: 3, approval: false, input: { kind: 'input', path: [] } },
    { id: 'done', kind: 'join', dependsOn: ['first'] },
  ], result: { kind: 'step', stepId: 'done', path: ['0'] } };
}
function policy(): WorkflowPolicyManifest {
  return { scope: { principalId: 'principal', projectId: 'project' }, permissions: ['tool:increment', 'model:unused', 'tool:increment'],
    policyVersion: 'v1', maxCostMicros: 10, maxOutputBytes: 65_536, approvalTtlMs: 60_000 };
}
const definitionHash = 'f1176344dc47feaa6af76c16b8f8b25d3ef45f64b26e237fc6fc7e9a745dcf38';
const policyHash = 'f254f17bcc536ccc456cc45f8eaf8519c18536850551d38b04b03df64a21f303';
const runId = '9b447b9fc665e6447a23a6f6a67526bbe435a725b9b349fc615d04e301f3b075';
const candidate = 'a'.repeat(64);
function initial(): WorkflowFormat2State { return initialWorkflowState(manifest(), 4, definitionHash, policyHash, 10); }
function decode(value: unknown): WorkflowFormat2State { return workflowState({ id: runId, state: value as JsonObject }); }
function evidence(execution: ExecutionReceipt['execution'] = 'succeeded', disclosure: ExecutionReceipt['disclosure'] = 'withheld'): ExecutionReceipt {
  return { callId: `${runId}/step:first`, toolId: 'increment', execution, disclosure };
}
function success(): WorkflowFormat2State {
  const value = initial(); value.steps['first'] = { ...value.steps['first']!, status: 'succeeded', receipt: evidence('succeeded', 'released'), candidateHash: candidate, output: 5 };
  value.steps['done'] = { ...value.steps['done']!, status: 'succeeded', output: [5] }; value.status = 'succeeded'; value.output = 5; value.spentMicros = 3;
  return value;
}
const hash = (domain: string, value: unknown): string => createHash('sha256').update(workflowHashMaterial(domain, value)).digest('hex');
function badManifest(change: (value: Record<string, unknown>) => void): unknown { const value = structuredClone(manifest()) as unknown as Record<string, unknown>; change(value); return value; }

describe('strict scheduled workflow metadata', () => {
  it('preserves graph order and optional-free legacy digest material in deeply frozen snapshots', () => {
    const source = manifest(); const result = workflowManifest(source); expect(result).toEqual(source); expect(hash('mayura:workflow:v1', result)).toBe(definitionHash);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.graph)).toBe(true); expect(Object.isFrozen(result.graph[0]?.dependsOn)).toBe(true);
    expect(Object.isFrozen(result.graph[0]?.kind === 'tool' ? result.graph[0].input : null)).toBe(true);
    expect(() => Object.assign(result.graph[0]!, { costMicros: 0 })).toThrow(); expect(Object.isFrozen(source)).toBe(false);
  });

  it('accepts forward declarations and repeated immutable tool metadata, without requiring unique tool IDs', () => {
    const value = manifest(); const repeated = value.graph[0]!;
    const result = workflowManifest({ ...value, graph: [value.graph[1], repeated, { ...repeated, id: 'second' }] });
    expect(result.graph.map(node => node.id)).toEqual(['done', 'first', 'second']);
  });

  it.each([
    badManifest(value => { value['extra'] = 'SECRET'; }), badManifest(value => { value['id'] = 'invalid space'; }),
    badManifest(value => { value['graph'] = []; }), badManifest(value => { value['graph'] = Array.from({ length: 129 }, (_, index) => ({ kind: 'join', id: `node${index}`, dependsOn: [] })); }),
    badManifest(value => { value['graph'] = [{ kind: 'join', id: 'constructor', dependsOn: [] }]; }),
    badManifest(value => { value['graph'] = [{ kind: 'join', id: 'first', dependsOn: [] }, { kind: 'join', id: 'first', dependsOn: [] }]; }),
    badManifest(value => { value['graph'] = [{ kind: 'join', id: 'first', dependsOn: ['missing'] }]; }),
    badManifest(value => { value['graph'] = [{ kind: 'join', id: 'first', dependsOn: ['first'] }]; }),
    badManifest(value => { value['graph'] = [{ kind: 'join', id: 'first', dependsOn: ['done'] }, { kind: 'join', id: 'done', dependsOn: ['first'] }]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], costMicros: -1 }, manifest().graph[1]]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], approval: 'yes' }, manifest().graph[1]]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], capabilities: ['same', 'same'] }, manifest().graph[1]]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], effects: 'root' }, manifest().graph[1]]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], tool: 'has space' }, manifest().graph[1]]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], dependsOn: ['done', 'done'] }, manifest().graph[1]]; }),
    badManifest(value => { value['graph'] = [{ ...manifest().graph[0], input: { kind: 'step', stepId: 'done', path: [] } }, manifest().graph[1]]; }),
    badManifest(value => { value['result'] = { kind: 'step', stepId: 'missing', path: [] }; }),
    badManifest(value => { value['result'] = { kind: 'input', path: ['constructor'] }; }),
    badManifest(value => { value['result'] = { kind: 'input', path: Array(33).fill('x') }; }),
    badManifest(value => { value['result'] = { kind: 'literal', value: 'x', extra: 'SECRET' }; }),
    badManifest(value => { value['result'] = { kind: 'literal', value: 'x'.repeat(1_048_576) }; }),
  ])('rejects ambiguous, cyclic or unbounded manifests (%#)', value => {
    expect(() => workflowManifest(value)).toThrow(StorageError);
    expect(() => workflowManifest(value)).toThrow('Invalid bounded workflow metadata.');
  });

  it('sorts permissions without deduplicating and retains the exact legacy policy hash', () => {
    const original = policy(); const value = workflowPolicy(original);
    expect(value.permissions).toEqual(['model:unused', 'tool:increment', 'tool:increment']);
    expect(original.permissions).toEqual(['tool:increment', 'model:unused', 'tool:increment']);
    expect(hash('mayura:policy:v1', value)).toBe(policyHash); expect(Object.isFrozen(value.scope)).toBe(true); expect(Object.isFrozen(value.permissions)).toBe(true);
    expect(hash('mayura:policy:v1', { ...value, permissions: [...new Set(value.permissions)] })).not.toBe(policyHash);
  });

  it.each([
    { ...policy(), extra: true }, { ...policy(), scope: { principalId: 'p', projectId: 'x', credential: 'SECRET' } },
    { ...policy(), policyVersion: '' }, { ...policy(), permissions: Array(4_097).fill('grant') }, { ...policy(), permissions: [null] },
    { ...policy(), maxCostMicros: -1 }, { ...policy(), maxOutputBytes: 65_537 }, { ...policy(), maxOutputBytes: 0 },
    { ...policy(), approvalTtlMs: 0 }, { ...policy(), approvalTtlMs: 0.5 },
  ])('rejects invalid scheduled policy bounds and fields (%#)', value => { expect(() => workflowPolicy(value)).toThrow(StorageError); });

  it('normalizes absent resources, deduplicates exact names and detaches mutable input', () => {
    expect(workflowResources({}, manifest())).toEqual({ first: [] });
    const source = { first: ['z', 'a', 'z'] }; const value = workflowResources(source, manifest());
    expect(value).toEqual({ first: ['a', 'z'] }); source.first.push('later'); expect(value['first']).toEqual(['a', 'z']);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value['first'])).toBe(true);
    expect(workflowResources({ first: ['x'.repeat(256)] }, manifest())['first']?.[0]).toHaveLength(256);
    expect(workflowResources({ first: Array.from({ length: 32 }, (_, index) => `${index}`) }, manifest())['first']).toHaveLength(32);
  });

  it.each([{ unknown: [] }, { done: [] }, { first: 'not-array' }, { first: [''] }, { first: ['a\0b'] },
    { first: ['x'.repeat(257)] }, { first: ['é'.repeat(129)] }, { first: Array(33).fill('same') }])('rejects invalid resource identities/maps (%#)', value => {
    expect(() => workflowResources(value, manifest())).toThrow(StorageError);
  });

  it('rejects metadata getters without invoking or exposing them', () => {
    const getter = vi.fn(() => { throw new Error('SECRET'); });
    for (const verify of [workflowManifest, workflowPolicy, (value: unknown) => workflowResources(value, manifest())]) {
      const value = Object.defineProperty({}, 'secret', { enumerable: true, get: getter });
      expect(() => verify(value)).toThrow('Invalid bounded workflow metadata.');
    }
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('format-2 hash and state parity', () => {
  it('preserves fixed pre-extraction scope, run, approval and policy hashes', () => {
    const scope = policy().scope; const normalized = workflowPolicy(policy());
    const scopeHash = hash('mayura:scope:v1', scope);
    expect(scopeHash).toBe('3812fc94de4219e5aa437abb3ba4de5f80229295bdb394708347cd00326f290c');
    expect(hash('mayura:run-id:v1', { scope: scopeHash, submissionKey: 'one' })).toBe(runId);
    expect(hash('mayura:policy:v1', normalized)).toBe(policyHash);
    expect(hash('mayura:approval:v1', { runId, nodeId: 'first', tool: 'increment', toolVersion: '1', input: 4, policy: policyHash, expiresAt: 100_000 }))
      .toBe('4e13c4eb054da399b275a681b2642087a6cc7bce8a12e1154e78a74b884ce37e');
    // The general material helper remains compatible with conservative 1 MiB policies.
    expect(workflowHashMaterial('mayura:policy:v1', { ...normalized, maxOutputBytes: 1_048_576 })).toContain('1048576');
  });

  it('canonicalizes nested keys without changing array order, Unicode encoding or negative-zero behavior', () => {
    expect(workflowHashMaterial('test:v1', { z: [-0, 'é', { b: true, a: null }], a: 2 }))
      .toBe('test:v1\n{"a":2,"z":[0,"é",{"a":null,"b":true}]}');
    expect(hash('test:v1', { b: 2, a: 1 })).toBe(hash('test:v1', { a: 1, b: 2 }));
    expect(hash('test:v1', [1, 2])).not.toBe(hash('test:v1', [2, 1]));
    expect(() => workflowHashMaterial('bad\ndomain', {})).toThrow(StorageError);
  });

  it('constructs the exact legacy initial state shape with detached input', () => {
    const input = { nested: [1] }; const value = initialWorkflowState(manifest(), input, definitionHash, policyHash, 10); input.nested.push(2);
    expect(value).toEqual({ format: 2, definition: definitionHash, policy: policyHash, input: { nested: [1] }, status: 'running',
      maxCostMicros: 10, spentMicros: 0, reservedMicros: 0, output: null,
      steps: {
        first: { kind: 'tool', status: 'pending', callId: 'step:first', output: null, receipt: null, approval: null, costReserved: 0, candidateHash: null },
        done: { kind: 'join', status: 'pending', callId: 'step:done', output: null, receipt: null, approval: null, costReserved: 0, candidateHash: null },
      } });
    expect(decode(value)).toEqual(value); expect(Object.keys(value)).not.toContain('scheduler');
  });

  it.each(['pending', 'waiting', 'approved', 'dispatching', 'unknown', 'blocked', 'failed', 'skipped'] as const)('decodes a valid legacy %s step and never mutates source state', status => {
    const value = initial(); const first = value.steps['first']!; first.status = status;
    if (status === 'waiting' || status === 'approved') first.approval = { digest: candidate, expiresAt: 10_000, humanId: status === 'approved' ? 'human' : null };
    if (status === 'dispatching' || status === 'unknown') { first.candidateHash = candidate; first.costReserved = 3; value.reservedMicros = 3; }
    if (status === 'unknown') first.receipt = evidence('unknown');
    const source = structuredClone(value); const decoded = decode(value); expect(decoded).toEqual(value); decoded.steps['first']!.status = 'failed';
    expect(value).toEqual(source); expect(Object.isFrozen(decoded)).toBe(false);
  });

  it('decodes scheduled preparation without adding a prepared status or hiding reservation', () => {
    const value = initial(); value.steps['first']!.costReserved = 3; value.steps['first']!.candidateHash = candidate; value.reservedMicros = 3;
    const result = decode(value); expect(result.steps['first']!.status).toBe('pending'); expect(result.reservedMicros).toBe(3);
    assertWorkflowStateMatchesManifest(result, manifest());
  });

  it('retains successful effects with withheld output and cancellation without inventing success', () => {
    const value = initial(); value.status = 'cancelled'; const first = value.steps['first']!;
    first.status = 'blocked'; first.receipt = evidence(); first.candidateHash = candidate; value.spentMicros = 3;
    const result = decode(value); expect(result.status).toBe('cancelled'); expect(result.steps['first']?.receipt?.execution).toBe('succeeded');
    expect(result.output).toBeNull(); expect(workflowOutputs(result)).toEqual({});
  });

  it('retains a valid successful graph and projects detached released outputs', () => {
    const value = decode(success()); assertWorkflowStateMatchesManifest(value, manifest());
    const projected = workflowOutputs(value); expect(projected).toEqual({ first: 5, done: [5] });
    (projected['done'] as JsonValue[]).push(9); expect(value.steps['done']?.output).toEqual([5]);
  });

  const invalidStates: [string, (value: WorkflowFormat2State) => void][] = [
    ['format', value => { (value as unknown as Record<string, unknown>)['format'] = 3; }],
    ['unknown-field', value => { (value as unknown as Record<string, unknown>)['secret'] = 'SECRET'; }],
    ['definition', value => { value.definition = 'not-a-hash'; }],
    ['budget-overrun', value => { value.spentMicros = 11; }],
    ['reservation-mismatch', value => { value.reservedMicros = 3; }],
    ['negative-reservation', value => { value.steps['first']!.costReserved = -1; }],
    ['call-id', value => { value.steps['first']!.callId = 'other'; }],
    ['candidate', value => { value.steps['first']!.candidateHash = 'SECRET'; }],
    ['disclosed-pending-output', value => { value.steps['first']!.output = 5; }],
    ['disclosed-run-output', value => { value.output = 5; }],
    ['premature-success', value => { value.status = 'succeeded'; }],
    ['success-without-receipt', value => { value.steps['first']!.status = 'succeeded'; }],
    ['approved-without-human', value => { value.steps['first']!.status = 'approved'; value.steps['first']!.approval = { digest: candidate, expiresAt: 10_000, humanId: null }; }],
    ['approval-extra', value => { value.steps['first']!.approval = { digest: candidate, expiresAt: 1, humanId: null, secret: 'SECRET' } as typeof value.steps[string]['approval']; }],
    ['foreign-receipt', value => { value.steps['first']!.receipt = { ...evidence(), callId: 'other/step:first' }; }],
    ['released-unknown', value => { value.steps['first']!.receipt = evidence('unknown', 'released'); }],
    ['receipt-extra', value => { value.steps['first']!.receipt = { ...evidence(), secret: 'SECRET' } as ExecutionReceipt; }],
    ['join-evidence', value => { value.steps['done']!.receipt = { ...evidence(), callId: `${runId}/step:done` }; }],
    ['join-candidate', value => { value.steps['done']!.candidateHash = candidate; }],
    ['missing-step-field', value => { delete (value.steps['first'] as unknown as Record<string, unknown>)['receipt']; }],
  ];
  it.each(invalidStates)('rejects invalid persisted state (%s) with fixed safe diagnostics', (_label, change) => {
    const value = initial(); change(value); expect(() => decode(value)).toThrow('Stored workflow state failed integrity validation.');
  });

  it('rejects overflow in the reservation sum and independent released-receipt requirements', () => {
    const value = initial(); value.maxCostMicros = Number.MAX_SAFE_INTEGER;
    value.steps['first']!.costReserved = Number.MAX_SAFE_INTEGER; value.steps['done']!.costReserved = 1;
    expect(() => decode(value)).toThrow(StorageError);
    const succeeded = success(); succeeded.steps['first']!.receipt = evidence('succeeded', 'withheld'); expect(() => decode(succeeded)).toThrow(StorageError);
    const reserved = success(); reserved.steps['first']!.costReserved = 1; reserved.reservedMicros = 1; expect(() => decode(reserved)).toThrow(StorageError);
  });

  it('rejects record/state accessors without executing them or retaining messages', () => {
    const getter = vi.fn(() => { throw new Error('SECRET'); });
    const record = Object.defineProperty({ id: runId }, 'state', { enumerable: true, get: getter });
    expect(() => workflowState(record as { id: string; state: JsonObject })).toThrow('Stored workflow state failed integrity validation.');
    const state = Object.defineProperty(initial(), 'input', { enumerable: true, get: getter }); expect(() => decode(state)).toThrow(StorageError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['missing-node', 'kind', 'tool', 'dependency', 'unrequested-approval', 'cost', 'partial-cost'] as const)('matches graph identity and evidence (%s)', change => {
    const value = success();
    if (change === 'missing-node') delete value.steps['first'];
    if (change === 'kind') value.steps['first']!.kind = 'join';
    if (change === 'tool') value.steps['first']!.receipt = { ...evidence('succeeded', 'released'), toolId: 'other' };
    if (change === 'dependency') value.steps['first']!.status = 'pending';
    if (change === 'unrequested-approval') value.steps['first']!.approval = { digest: candidate, expiresAt: 1, humanId: 'human' };
    if (change === 'cost') value.steps['first']!.costReserved = 4;
    if (change === 'partial-cost') value.steps['first']!.costReserved = 1;
    expect(() => assertWorkflowStateMatchesManifest(value, manifest())).toThrow(StorageError);
  });

  it('rejects prepared approval hashes that do not match the pinned review digest', () => {
    const definition = manifest(); const first = definition.graph[0]!;
    const approved = workflowManifest({ ...definition, graph: [{ ...first, approval: true }, definition.graph[1]] });
    const state = initial(); state.steps['first']!.candidateHash = candidate;
    state.steps['first']!.approval = { digest: candidate, expiresAt: 10_000, humanId: 'human' };
    assertWorkflowStateMatchesManifest(state, approved);
    state.steps['first']!.approval!.digest = 'b'.repeat(64);
    expect(() => assertWorkflowStateMatchesManifest(state, approved)).toThrow(StorageError);
  });

  it('does not project a forged successful step without released receipt evidence', () => {
    const state = success(); state.steps['first']!.receipt = evidence('succeeded', 'withheld');
    expect(() => workflowOutputs(state)).toThrow(StorageError);
  });
});

describe('receipt and binding helpers', () => {
  it('merges unknown to known evidence monotonically and never regresses released disclosure', () => {
    expect(mergeWorkflowReceipt(null, evidence('unknown'))).toEqual(evidence('unknown'));
    expect(mergeWorkflowReceipt(evidence('unknown'), evidence())).toEqual(evidence());
    expect(mergeWorkflowReceipt(evidence(), evidence('unknown'))).toEqual(evidence());
    expect(mergeWorkflowReceipt(evidence(), evidence('succeeded', 'released'))).toEqual(evidence('succeeded', 'released'));
    expect(mergeWorkflowReceipt(evidence('succeeded', 'released'), evidence())).toEqual(evidence('succeeded', 'released'));
    expect(Object.isFrozen(mergeWorkflowReceipt(null, evidence()))).toBe(true);
  });

  it.each(['failed', 'not_started'] as const)('rejects conflicting known %s evidence and identities', execution => {
    expect(() => mergeWorkflowReceipt(evidence(), evidence(execution))).toThrow(StorageError);
    expect(() => mergeWorkflowReceipt(evidence(), { ...evidence(), toolId: 'different' })).toThrow(StorageError);
    expect(() => mergeWorkflowReceipt(evidence(), { ...evidence(), callId: 'other' })).toThrow(StorageError);
  });

  it('resolves literals, input and step array/object paths without retaining references', () => {
    const input = { outer: [1, { text: 'ok' }] }; const outputs = { one: input };
    expect(resolveWorkflowBinding({ kind: 'input', path: ['outer', '1', 'text'] }, input, {})).toBe('ok');
    expect(resolveWorkflowBinding({ kind: 'step', stepId: 'one', path: ['outer', '0'] }, null, outputs)).toBe(1);
    expect(resolveWorkflowBinding({ kind: 'literal', value: 4 }, null, {})).toBe(4);
    const copy = resolveWorkflowBinding({ kind: 'input', path: [] }, input, {}) as { outer: JsonValue[] }; copy.outer.push(9); expect(input.outer).toHaveLength(2);
  });

  it('rejects missing paths, forbidden traversal, and accessor-bearing bindings safely', () => {
    expect(() => resolveWorkflowBinding({ kind: 'input', path: ['missing'] }, {}, {})).toThrow('Workflow binding cannot resolve its path.');
    expect(() => resolveWorkflowBinding({ kind: 'input', path: ['constructor'] }, {}, {})).toThrow(StorageError);
    expect(() => resolveWorkflowBinding({ kind: 'step', stepId: 'missing', path: [] }, {}, {})).toThrow(StorageError);
    const getter = vi.fn(() => 'SECRET'); const raw = Object.defineProperty({ kind: 'literal' }, 'value', { enumerable: true, get: getter });
    expect(() => resolveWorkflowBinding(raw as { kind: 'literal'; value: JsonValue }, null, {})).toThrow(StorageError); expect(getter).not.toHaveBeenCalled();
  });

  it('property-checks canonical insertion-order independence, state copying and receipt monotonicity', () => {
    fc.assert(fc.property(fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.integer()), dictionary => {
      const reversed = Object.fromEntries(Object.entries(dictionary).reverse());
      expect(workflowHashMaterial('property:v1', dictionary)).toBe(workflowHashMaterial('property:v1', reversed));
      const state = initialWorkflowState(manifest(), dictionary, definitionHash, policyHash, 10); const copy = decode(state);
      expect(copy).toEqual(state); expect(copy).not.toBe(state); expect(copy.steps).not.toBe(state.steps);
    }), { numRuns: 100 });
    fc.assert(fc.property(fc.array(fc.constantFrom('unknown', 'succeeded') as fc.Arbitrary<'unknown' | 'succeeded'>, { minLength: 1, maxLength: 50 }), sequence => {
      let previous: ExecutionReceipt | null = null; let known = false;
      for (const execution of sequence) {
        previous = mergeWorkflowReceipt(previous, evidence(execution)); known ||= execution === 'succeeded';
        expect(previous.execution).toBe(known ? 'succeeded' : 'unknown');
      }
    }), { numRuns: 100 });
  });
});
