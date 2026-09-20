import { describe, expect, it, vi } from 'vitest';
import type { JsonObject, JsonValue, Schema } from '@mayura/core';
import { initialWorkflowState, workflowPolicy, type ScheduledWorkflowAggregateStore, type ScheduledWorkflowSnapshot, type ScheduledWorkflowStore } from '@mayura/storage-contracts';
import { createScheduledWorkflowRuntime, defineWorkflow } from '../src/index.js';
import { digest } from '../src/definition.js';
import { scheduledManifest } from '../src/scheduled-helpers.js';

const scope = { principalId: 'reference-principal', projectId: 'reference-project' };
const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'reference-test', validate: value => ({ value: value as JsonValue }) } };

/** Structural adapter tests the public boundary; SQL ownership is qualified independently. */
function fixture() {
  const definition = defineWorkflow({ id: 'reference', version: '1', input: schema, output: schema,
    nodes: [{ id: 'joined', kind: 'join', dependsOn: [] }], result: { kind: 'literal', value: 1 } });
  const policy = workflowPolicy({ scope, permissions: [], policyVersion: 'v1', maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 3_600_000 });
  const scopeKey = digest('mayura:scope:v1', scope); const policyHash = digest('mayura:policy:v1', policy); const id = 'a'.repeat(64);
  const current: ScheduledWorkflowSnapshot = { profile: 'scheduled-v1', manifestHash: definition.digest, policyHash,
    resourceHash: digest('mayura:workflow-resources:v1', {}), jobs: [],
    record: { scope: scopeKey, id, version: 1, definitionHash: definition.digest, idempotencyKey: 'key',
      state: initialWorkflowState(scheduledManifest(definition), 'PRIVATE workflow input', definition.digest, policyHash, 0) as unknown as JsonObject } };
  const inspect = vi.fn(async (_command: unknown) => structuredClone(current));
  const mutations = vi.fn(async () => { throw new Error('References must not mutate state.'); });
  const api = { ...Object.fromEntries(['submit', 'attach', 'requestApproval', 'approve', 'prepare', 'claim', 'renew', 'start', 'recordReceipt', 'complete', 'abandon', 'failNode', 'advance', 'finalize', 'cancel', 'recover'].map(name => [name, mutations])),
    initialize: vi.fn(async () => undefined), inspect } as unknown as ScheduledWorkflowStore;
  const store = { workflows: api, read: vi.fn(async () => current.record), events: vi.fn(async () => []), close: vi.fn(async () => undefined) } as unknown as ScheduledWorkflowAggregateStore;
  const worker = createScheduledWorkflowRuntime({ store, scope, permissions: { allow: [] }, policyVersion: 'v1', maxCostMicros: 0, workerId: 'reader' });
  return { worker, current, inspect, mutations, id, scopeKey, policyHash, definition };
}

describe('scheduled workflow execution references', () => {
  it('uses exact scoped policy-checked load and returns only immutable identity metadata', async () => {
    const source = fixture();
    try {
      const reference = await source.worker.reference(source.id);
      expect(reference).toEqual({ kind: 'scheduled-workflow', runId: source.id, definitionHash: source.definition.digest, policyHash: source.policyHash });
      expect(Object.isFrozen(reference)).toBe(true); expect(JSON.stringify(reference)).not.toContain('PRIVATE');
      expect(source.inspect).toHaveBeenCalledWith({ scope: source.scopeKey, id: source.id, policyHash: source.policyHash });
      expect(source.mutations).not.toHaveBeenCalled();
    } finally { await source.worker.close(); }
  });

  it.each(['scope', 'policy', 'definition'] as const)('rejects an adapter response with the wrong %s identity', async mismatch => {
    const source = fixture(); const bad = structuredClone(source.current);
    source.inspect.mockResolvedValue(mismatch === 'scope' ? { ...bad, record: { ...bad.record, scope: '0'.repeat(64) } }
      : mismatch === 'policy' ? { ...bad, policyHash: '0'.repeat(64) } : { ...bad, record: { ...bad.record, definitionHash: '0'.repeat(64) } });
    try { await expect(source.worker.reference(source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
    finally { await source.worker.close(); }
  });

  it('rejects malformed and post-close reference commands without accessing storage', async () => {
    const source = fixture();
    await expect(source.worker.reference('invalid')).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(source.inspect).not.toHaveBeenCalled();
    await source.worker.close(); await expect(source.worker.reference(source.id)).rejects.toMatchObject({ code: 'CANCELLED' }); expect(source.inspect).not.toHaveBeenCalled();
  });
});
