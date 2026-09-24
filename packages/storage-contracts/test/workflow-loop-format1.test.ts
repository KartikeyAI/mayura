import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { StorageError } from '../src/contracts.js';
import { assertWorkflowLoopStateMatchesManifest, initialWorkflowLoopState, workflowLoopManifest,
  workflowLoopState, type WorkflowLoopManifest } from '../src/workflow-loop-format1.js';

const hash = 'a'.repeat(64); const policy = 'b'.repeat(64); const id = 'c'.repeat(64);
const manifest = (): WorkflowLoopManifest => ({ format: 1, id: 'poll', version: '1',
  body: { definitionHash: hash, maxCostMicros: 2, maxCalls: 1 }, maxIterations: 3,
  initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] },
  continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: ['value'] },
  maxCostMicros: 6, maxCalls: 3 });

describe('format-1 workflow loop persistence', () => {
  it('enforces exact static bounds, safe bindings and finite iterations', () => {
    expect(workflowLoopManifest(manifest())).toEqual(manifest());
    expect(() => workflowLoopManifest({ ...manifest(), maxCostMicros: 5 })).toThrow(StorageError);
    expect(() => workflowLoopManifest({ ...manifest(), maxIterations: 1_025, maxCostMicros: 2, maxCalls: 1 })).toThrow(StorageError);
    expect(() => workflowLoopManifest({ ...manifest(), initial: { kind: 'current', path: [] } })).toThrow(StorageError);
  });

  it('decodes restart-safe active-child accounting', () => {
    const state = initialWorkflowLoopState(manifest(), { value: 0 }, hash, policy, 6);
    Object.assign(state, { status: 'waiting', childRunId: 'd'.repeat(64), spentMicros: 2, activeSpentMicros: 2 });
    const decoded = workflowLoopState({ id, state: state as unknown as JsonObject });
    assertWorkflowLoopStateMatchesManifest(decoded, manifest()); expect(decoded).toEqual(state);
    const forged = structuredClone(state); forged.activeSpentMicros = 3;
    expect(() => workflowLoopState({ id, state: forged as unknown as JsonObject })).toThrow(StorageError);
  });
});
