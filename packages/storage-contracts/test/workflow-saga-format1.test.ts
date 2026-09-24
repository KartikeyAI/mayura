import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { StorageError } from '../src/contracts.js';
import { assertWorkflowSagaStateMatchesManifest, initialWorkflowSagaState, workflowSagaManifest,
  workflowSagaState, type WorkflowSagaManifest } from '../src/workflow-saga-format1.js';

const hash = 'a'.repeat(64); const policy = 'b'.repeat(64); const id = 'c'.repeat(64);
const manifest = (): WorkflowSagaManifest => ({ format: 1, id: 'billing-change', version: '1', steps: [
  { id: 'reserve', forward: { definitionHash: hash, maxCostMicros: 2, maxCalls: 1 },
    input: { kind: 'input', path: [] }, compensation: { definitionHash: hash, maxCostMicros: 1, maxCalls: 1 },
    compensationInput: { kind: 'step', stepId: 'reserve', path: [] } },
  { id: 'publish', forward: { definitionHash: hash, maxCostMicros: 3, maxCalls: 1 },
    input: { kind: 'step', stepId: 'reserve', path: [] }, compensation: null, compensationInput: null },
], result: { kind: 'step', stepId: 'publish', path: [] }, maxCostMicros: 6, maxCalls: 3 });

describe('format-1 workflow saga persistence', () => {
  it('accepts strict backward-only bindings and exact aggregate bounds', () => {
    const parsed = workflowSagaManifest(manifest());
    expect(parsed).toEqual(manifest()); expect(Object.isFrozen(parsed.steps)).toBe(true);
    expect(() => workflowSagaManifest({ ...manifest(), maxCostMicros: 5 })).toThrow(StorageError);
    const forwardReference = structuredClone(manifest()) as unknown as { steps: { input: unknown }[] };
    forwardReference.steps[0]!.input = { kind: 'step', stepId: 'publish', path: [] };
    expect(() => workflowSagaManifest(forwardReference)).toThrow(StorageError);
  });

  it('decodes restart-safe compensation state and rejects forged accounting', () => {
    const state = initialWorkflowSagaState(manifest(), { amount: 1 }, hash, policy, 6);
    Object.assign(state.steps['reserve']!, { status: 'compensated', forwardRunId: hash,
      compensationRunId: 'd'.repeat(64), output: { reservation: 'r1' }, forwardSpentMicros: 2,
      compensationSpentMicros: 1 });
    Object.assign(state.steps['publish']!, { status: 'failed', forwardRunId: 'e'.repeat(64), forwardSpentMicros: 3 });
    state.status = 'compensated'; state.spentMicros = 6;
    const decoded = workflowSagaState({ id, state: state as unknown as JsonObject });
    assertWorkflowSagaStateMatchesManifest(decoded, manifest());
    const forged = structuredClone(state); forged.spentMicros = 5;
    expect(() => workflowSagaState({ id, state: forged as unknown as JsonObject })).toThrow(StorageError);
  });

  it('keeps format and shape exact', () => {
    expect(() => workflowSagaManifest({ ...manifest(), format: 5 })).toThrow(StorageError);
    expect(() => workflowSagaManifest({ ...manifest(), extra: true })).toThrow(StorageError);
  });
});
