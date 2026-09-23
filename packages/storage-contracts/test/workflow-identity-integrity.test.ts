import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import type { WorkflowManifest } from '../src/scheduled-workflow-contracts.js';
import { initialWorkflowState, mergeWorkflowReceipt, workflowHashMaterial, workflowResources, workflowState } from '../src/workflow-format2.js';

const definition: WorkflowManifest = { id: 'identity', version: '1', graph: [
  { id: 'first', kind: 'tool', dependsOn: [], tool: 'echo', toolVersion: '1', effects: 'none', capabilities: [], costMicros: 0, approval: false, input: { kind: 'input', path: [] } },
], result: { kind: 'step', stepId: 'first', path: [] } };
const initial = () => initialWorkflowState(definition, { text: '\ud800' }, 'a'.repeat(64), 'b'.repeat(64), 1);
const malformed = ['\ud800', '\udfff', 'a\ud800b', '\udc00\ud800', '\ud800\ud800', '\udc00\udc00', '\ud83d\ude80\ud800'];

describe('driver-free workflow SQL identity integrity', () => {
  it.each(malformed)('rejects malformed resources, stored run identities and receipt identities (%#)', value => {
    expect(() => workflowResources({ first: [value] }, definition)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => workflowState({ id: value, state: initial() as unknown as JsonObject })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => mergeWorkflowReceipt(null, { callId: value, toolId: 'echo', execution: 'unknown', disclosure: 'withheld' }))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('retains valid supplementary characters, replacement characters and exact normalization forms', () => {
    const identities = ['\ud83d\ude80'.repeat(64), '\ud800\udc00', '\udbff\udfff', '\ufffd', 'é', 'e\u0301'];
    expect(workflowResources({ first: identities }, definition)['first']).toEqual([...identities].sort());
    for (const id of identities) expect(workflowState({ id, state: initial() as unknown as JsonObject })).toEqual(initial());
    const callId = '\ud83d\ude80'.repeat(128);
    expect(mergeWorkflowReceipt(null, { callId, toolId: 'echo', execution: 'unknown', disclosure: 'withheld' }).callId).toBe(callId);
    expect(() => mergeWorkflowReceipt(null, { callId: callId + 'x', toolId: 'echo', execution: 'unknown', disclosure: 'withheld' })).toThrow();
    expect(() => workflowResources({ first: ['\ud83d\ude80'.repeat(64) + 'x'] }, definition)).toThrow();
  });

  it('does not extend identity rejection to payload strings or canonical hash material', () => {
    const state = initial();
    expect(workflowState({ id: 'run', state: state as unknown as JsonObject }).input).toEqual({ text: '\ud800' });
    expect(workflowHashMaterial('test:v1', { text: '\ud800' })).toBe('test:v1\n{"text":"\\ud800"}');
    expect(workflowHashMaterial('test:v1', { text: '\ud800' })).not.toBe(workflowHashMaterial('test:v1', { text: '\ufffd' }));
    expect(workflowHashMaterial('test:v1', { text: 'é' })).not.toBe(workflowHashMaterial('test:v1', { text: 'e\u0301' }));
  });
});
