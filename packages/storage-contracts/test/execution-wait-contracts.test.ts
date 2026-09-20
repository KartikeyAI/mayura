import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { StorageError } from '../src/contracts.js';
import {
  executionCompletion, executionRef, executionWaitCommand, executionWaitHashMaterial, executionWaitSnapshot,
  type ExecutionCompletion, type ExecutionRef, type ExecutionWaitMethod, type ExecutionWaitSnapshot,
} from '../src/execution-wait-contracts.js';
import { workflowHashMaterial } from '../src/workflow-format2.js';

const key = { scope: 'a'.repeat(64), streamId: 'release.joins', policyHash: 'b'.repeat(64) };
function reference(index = 1): ExecutionRef {
  return { kind: 'scheduled-workflow', runId: index.toString(16).padStart(64, '0'), definitionHash: 'c'.repeat(64), policyHash: key.policyHash };
}
function completion(index = 1, outcome: ExecutionCompletion['outcome'] = 'succeeded'): ExecutionCompletion {
  return { reference: reference(index), outcome, sourceVersion: 3, sourceEventSequence: 4 };
}
function snapshot(status: ExecutionWaitSnapshot['status'] = 'waiting'): ExecutionWaitSnapshot {
  return { id: 'join.release', version: status === 'cancelled' ? 2 : 1, definitionHash: 'd'.repeat(64), status,
    targets: [reference()], observations: status === 'resolved' ? [completion()] : [] };
}
function invalid(call: () => unknown): void {
  expect(call).toThrow(StorageError);
  try { call(); } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid bounded execution-wait metadata.' });
  }
}

describe('execution completion references and observations', () => {
  it('returns owned immutable references and observations without freezing caller objects', () => {
    const original = completion(); const value = executionCompletion(original);
    expect(value).toEqual(original); expect(value).not.toBe(original); expect(value.reference).not.toBe(original.reference);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.reference)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    expect(executionRef(reference())).toEqual(reference());
  });
  it.each([
    null, [], { ...reference(), kind: 'agent' }, { ...reference(), runId: 'A'.repeat(64) },
    { ...reference(), runId: 'a'.repeat(63) }, { ...reference(), definitionHash: 1 },
    { ...reference(), policyHash: 'b'.repeat(65) }, { ...reference(), output: 'SECRET' },
  ])('rejects malformed or payload-bearing references (%#)', value => invalid(() => executionRef(value)));
  it.each(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'] as const)('retains terminal outcome %s', outcome => {
    expect(executionCompletion(completion(1, outcome)).outcome).toBe(outcome);
  });
  it.each([
    { ...completion(), outcome: 'running' }, { ...completion(), sourceVersion: 0 },
    { ...completion(), sourceVersion: 1.5 }, { ...completion(), sourceEventSequence: -1 },
    { ...completion(), sourceEventSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...completion(), error: 'SECRET' },
  ])('rejects nonterminal, unbounded or payload-bearing facts (%#)', value => invalid(() => executionCompletion(value)));
  it('never invokes getters, toJSON, custom array iteration or arbitrary thrown diagnostics', () => {
    const getter = vi.fn(() => { throw new Error('SECRET'); });
    const accessor = { ...reference() }; Object.defineProperty(accessor, 'runId', { enumerable: true, get: getter });
    invalid(() => executionRef(accessor)); expect(getter).not.toHaveBeenCalled();
    invalid(() => executionRef({ ...reference(), toJSON: getter })); expect(getter).not.toHaveBeenCalled();
    const targets = [reference()]; Object.defineProperty(targets, Symbol.iterator, { value: getter });
    invalid(() => executionWaitSnapshot({ ...snapshot(), targets })); expect(getter).not.toHaveBeenCalled();
    invalid(() => executionRef(new Proxy({}, { ownKeys: getter })));
  });
});

describe('execution wait snapshots', () => {
  it.each(['waiting', 'resolved', 'cancelled'] as const)('validates %s with exact immutable nested metadata', status => {
    const original = snapshot(status); const value = executionWaitSnapshot(original);
    expect(value).toEqual(original); expect(Object.isFrozen(value.targets)).toBe(true);
    expect(Object.isFrozen(value.targets[0])).toBe(true); expect(Object.isFrozen(value.observations)).toBe(true);
    expect(Object.isFrozen(original.targets)).toBe(false);
  });
  it('allows only initial or later resolved versions and keeps declared target order', () => {
    const original = { ...snapshot('resolved'), version: 2, targets: [reference(2), reference(1)], observations: [completion(2), completion(1)] };
    expect(executionWaitSnapshot(original)).toEqual(original);
    expect(executionWaitSnapshot(snapshot('resolved')).version).toBe(1);
  });
  it.each([
    { ...snapshot(), version: 2 }, { ...snapshot('cancelled'), version: 1 }, { ...snapshot('resolved'), version: 3 },
    { ...snapshot(), status: 'succeeded' }, { ...snapshot(), observations: [completion()] },
    { ...snapshot('cancelled'), observations: [completion()] }, { ...snapshot('resolved'), observations: [] },
    { ...snapshot('resolved'), observations: [completion(2)] },
    { ...snapshot('resolved'), observations: [{ ...completion(), reference: { ...reference(), definitionHash: 'e'.repeat(64) } }] },
    { ...snapshot('resolved'), targets: [reference(2), reference(1)], observations: [completion(1), completion(2)] },
    { ...snapshot(), targets: [] }, { ...snapshot(), targets: Array.from({ length: 33 }, (_, i) => reference(i)) },
    { ...snapshot(), targets: [reference(), reference()] },
    { ...snapshot(), targets: [reference(), { ...reference(), definitionHash: 'e'.repeat(64) }] },
    { ...snapshot(), targets: [reference(), { ...reference(2), policyHash: 'e'.repeat(64) }] },
    { ...snapshot(), id: 'bad space' }, { ...snapshot(), id: 'x'.repeat(129) },
    { ...snapshot(), definitionHash: 'D'.repeat(64) }, { ...snapshot(), credentials: 'SECRET'.repeat(20_000) },
  ])('rejects invalid state, identity or continuity (%#)', value => invalid(() => executionWaitSnapshot(value)));
  it('supports the full 32-target bounded result without mutation', () => {
    const targets = Array.from({ length: 32 }, (_, i) => reference(i));
    const observations = Array.from({ length: 32 }, (_, i) => completion(i));
    const source = { ...snapshot('resolved'), targets, observations };
    const value = executionWaitSnapshot(source); targets.reverse(); observations.reverse();
    expect(value.targets[0]?.runId).toBe(reference(0).runId); expect(value.observations[31]?.reference.runId).toBe(reference(31).runId);
  });
});

describe('finite execution wait commands and digest material', () => {
  it.each([
    ['initialize', {}], ['open', key], ['materialize', { scope: key.scope, reference: reference() }],
    ['register', { ...key, id: 'join.release', targets: [reference()] }],
    ['inspect', { ...key, id: 'join.release' }], ['cancel', { ...key, id: 'join.release' }],
    ['drainReady', { ...key, limit: 32 }], ['events', { ...key, after: 0 }],
  ] as const)('snapshots exact %s commands', (method, command) => {
    const value = executionWaitCommand(method, command); expect(value).toEqual(command); expect(value).not.toBe(command);
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(command)).toBe(false);
  });
  it.each([
    ['initialize', { arbitrary: true }], ['open', { ...key, scope: 'scope' }], ['open', { ...key, streamId: '' }],
    ['open', { ...key, callback: () => {} }], ['materialize', { ...key, reference: reference() }],
    ['register', { ...key, id: 'wait', targets: [reference(), reference()] }],
    ['inspect', { ...key, id: 'wait', expectedVersion: 1 }], ['cancel', { ...key, id: 'wait', targets: [] }],
    ['drainReady', { ...key, limit: 0 }], ['drainReady', { ...key, limit: 33 }], ['drainReady', key],
    ['events', { ...key, after: -1 }], ['events', { ...key, after: 0.5 }], ['events', key],
    ['unknown' as ExecutionWaitMethod, key],
  ] as const)('rejects unsupported or malformed finite commands (%#)', (method, command) => invalid(() => executionWaitCommand(method, command)));
  it('leaves well-formed policy mismatches to authoritative storage conflict checks', () => {
    const command = { ...key, id: 'wait', targets: [reference(), { ...reference(2), policyHash: 'e'.repeat(64) }] };
    expect(executionWaitCommand('register', command)).toEqual(command);
    invalid(() => executionWaitHashMaterial(key, command.id, command.targets));
  });
  it('uses the exact domain-separated format/key/id/ordered-target digest material', () => {
    const targets = [reference(2), reference(1)];
    const expected = workflowHashMaterial('mayura:execution-wait:v1', { format: 1, key, id: 'join.release', targets });
    expect(executionWaitHashMaterial(key, 'join.release', targets)).toBe(expected);
    expect(executionWaitHashMaterial({ policyHash: key.policyHash, streamId: key.streamId, scope: key.scope }, 'join.release', targets)).toBe(expected);
    for (const value of [
      executionWaitHashMaterial({ ...key, scope: 'f'.repeat(64) }, 'join.release', targets),
      executionWaitHashMaterial({ ...key, streamId: 'other' }, 'join.release', targets),
      executionWaitHashMaterial(key, 'other', targets), executionWaitHashMaterial(key, 'join.release', [...targets].reverse()),
    ]) expect(value).not.toBe(expected);
    invalid(() => executionWaitHashMaterial({ ...key, extra: 'SECRET' } as typeof key, 'join.release', targets));
  });
  it('conserves ordered metadata and immutable identity for generated terminal joins', () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 65_535 }), { minLength: 1, maxLength: 32 }), values => {
      const targets = values.map(reference); const observations = values.map(value => completion(value, 'outcome_unknown'));
      const result = executionWaitSnapshot({ ...snapshot('resolved'), targets, observations });
      expect(result.targets.map(target => target.runId)).toEqual(targets.map(target => target.runId));
      expect(result.observations.every((observation, index) => observation.reference.runId === result.targets[index]?.runId)).toBe(true);
      expect(executionWaitHashMaterial(key, result.id, result.targets)).toBe(executionWaitHashMaterial(key, result.id, targets));
    }), { numRuns: 100 });
  });
});
