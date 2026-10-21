import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@mayura/core/host';
import { createAuthorizer, MayuraError, type Authorizer, type AuthorizationAuditEvent } from '@mayura/core';
import type { RunCheckpoint, RunCheckpointStore } from '@mayura/storage-contracts';
import { createApprovalReconciliation, type ReconcileClaimedApprovalRequest } from '../src/approval-reconciliation.js';
import type { RunRecordView } from '../src/index.js';

const scope = { principalId: 'alice', projectId: 'shop' }; const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const controls: ReturnType<typeof createApprovalReconciliation>[] = [];
afterEach(() => { controls.splice(0).forEach(control => control.stop()); vi.useRealTimers(); });
function fixture(authorization?: Authorizer) {
  let checkpoint: RunCheckpoint = { runId, scope: sha256Hex(`mayura:run-scope:v1\0alice\0shop`), version: 2, status: 'claimed', holderId: 'old-worker',
    leaseExpiresAtMs: Date.now() - 1000, createdAtMs: 1, updatedAtMs: 2, expiresAtMs: 3,
    body: { scope, agent: { id: 'support' }, pending: { callId: 'call-1', toolId: 'refund', toolVersion: '1', digest: 'a'.repeat(64) }, privateData: 'retained' } };
  let record: RunRecordView = { runId, agentId: 'support', replicaId: 'old-owner', status: 'waiting', leaseExpiresAtMs: Date.now() - 1000,
    cancelRequested: false, lastSequence: 3, snapshot: { id: runId, status: 'waiting', budget: {}, evidence: [] } };
  const noExecution = vi.fn(async () => { throw new Error('Execution must never be invoked'); });
  const store: RunCheckpointStore = { initialize: async () => {}, get: vi.fn(async () => checkpoint), put: noExecution, claim: noExecution,
    update: noExecution, delete: noExecution, due: noExecution, scan: noExecution, reconcile: vi.fn(async command => {
      if (command.expectedVersion !== checkpoint.version) throw new MayuraError('CONFLICT', 'Changed');
      const { runId: _runId, scope: _scope, ...facts } = command;
      const receipt = { format: 1, reconciledAtMs: Date.now(), ...facts };
      checkpoint = { ...checkpoint, version: checkpoint.version + 1, holderId: `reconcile:${sha256Hex(`${checkpoint.scope}\0${runId}\0${command.commandId}`)}`,
        body: { ...checkpoint.body, reconciliation: receipt } }; return checkpoint;
    }) };
  const authorize = vi.fn(async () => true);
  const hooks = { store, read: vi.fn(async () => record), abandon: vi.fn(async () => { record = { ...record, status: 'outcome_unknown', snapshot: { ...record.snapshot, status: 'outcome_unknown' } }; return record; }),
    agentExists: (id: string) => id === 'support', hasRecording: vi.fn(async () => false), record: vi.fn(async () => {}), timeoutMs: 1000, maxOperations: 2 };
  const control = createApprovalReconciliation({ permissions: { allow: ['conversations:reconcile'] }, authorize, ...(authorization ? { authorization } : {}) }, hooks); controls.push(control);
  const request = { scope, runId, actorId: 'operator' };
  const command = async (): Promise<ReconcileClaimedApprovalRequest> => ({ ...request, reviewDigest: (await control.inspect(request)).reviewDigest,
    commandId: 'incident-1', evidenceRef: 'external/receipt-1', effect: 'unknown', workerStopped: true });
  return { control, request, command, hooks, authorize, noExecution, change: (changes: Partial<RunCheckpoint>) => { checkpoint = { ...checkpoint, ...changes }; },
    changeRecord: (changes: Partial<RunRecordView>) => { record = { ...record, ...changes }; }, checkpoint: () => checkpoint };
}

describe('host-only claimed approval reconciliation', () => {
  it('isolates scopes, requires independent policy authorization, and owns command data', async () => {
    const f = fixture();
    await expect(f.control.inspect({ ...f.request, scope: { ...scope, principalId: 'bob' } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.authorize).not.toHaveBeenCalled(); f.authorize.mockResolvedValue(false);
    await expect(f.control.inspect(f.request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled(); expect(f.noExecution).not.toHaveBeenCalled();
    f.authorize.mockResolvedValue(true); const command = await f.command();
    const pending = f.control.reconcile(command); (command as { evidenceRef: string }).evidenceRef = 'mutated';
    expect((await pending).receipt['evidenceRef']).toBe('external/receipt-1');
  });

  it('refuses live leases, changed reviews, known terminal outcomes and existing completion journals', async () => {
    const f = fixture(); const command = await f.command();
    f.change({ leaseExpiresAtMs: Date.now() + 1000 });
    expect((await f.control.inspect(f.request)).blockers).toContain('checkpoint_live');
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'CONFLICT' });
    f.change({ leaseExpiresAtMs: 1 }); f.changeRecord({ leaseExpiresAtMs: Date.now() + 1000 });
    expect((await f.control.inspect(f.request)).blockers).toContain('run_live');
    f.changeRecord({ status: 'succeeded' }); expect((await f.control.inspect(f.request)).blockers).toContain('run_terminal');
    f.changeRecord({ status: 'waiting', leaseExpiresAtMs: 1 }); f.hooks.hasRecording.mockResolvedValue(true);
    expect((await f.control.inspect(f.request)).blockers).toContain('recording_pending');
    f.hooks.hasRecording.mockResolvedValue(false);
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled();
  });

  it('repairs interrupted recording using the same durable receipt, with no new fence or execution', async () => {
    const f = fixture(); const command = await f.command();
    f.hooks.record.mockRejectedValueOnce(new Error('PRIVATE_STORE_PASSWORD'));
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(f.checkpoint().body['reconciliation']).toMatchObject({ commandId: 'incident-1' });
    const result = await f.control.reconcile(command); expect(result.status).toBe('closed');
    expect(f.hooks.store.reconcile).toHaveBeenCalledTimes(1); expect(f.hooks.record).toHaveBeenCalledTimes(2);
    await expect(f.control.reconcile({ ...command, effect: 'succeeded' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.noExecution).not.toHaveBeenCalled();
  });

  it('honors cancellation after sealing and permits an identical retry to finish persistence', async () => {
    const f = fixture(); const command = await f.command(); const stop = new AbortController();
    const original = f.hooks.store.reconcile;
    f.hooks.store.reconcile = async value => { const sealed = await original(value); stop.abort(); return sealed; };
    await expect(f.control.reconcile({ ...command, signal: stop.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await f.control.settled(); expect(f.hooks.abandon).not.toHaveBeenCalled(); expect(f.hooks.record).not.toHaveBeenCalled();
    expect((await f.control.reconcile(command)).status).toBe('closed'); expect(f.noExecution).not.toHaveBeenCalled();
  });

  it('stops before mutation when authorization returns after shutdown', async () => {
    const f = fixture(); const command = await f.command(); let resolve!: (value: boolean) => void;
    f.authorize.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    const pending = f.control.reconcile(command); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.control.stop(); await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }); resolve(true); await f.control.settled();
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled(); expect(f.noExecution).not.toHaveBeenCalled();
  });

  it('sanitizes policy failures and requires stopped-worker evidence with bounded inputs', async () => {
    const f = fixture(); const command = await f.command();
    await expect(f.control.reconcile({ ...command, workerStopped: false } as unknown as ReconcileClaimedApprovalRequest)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.control.reconcile({ ...command, evidenceRef: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    f.authorize.mockRejectedValueOnce(new Error('PRIVATE_POLICY_SECRET'));
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    f.authorize.mockRejectedValueOnce(new MayuraError('PERMISSION_DENIED', 'PRIVATE_POLICY_SECRET'));
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Approval reconciliation is not authorized.' });
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled();
  });

  it('preserves a known outcome that wins the terminal-record race', async () => {
    const f = fixture(); const command = await f.command(); f.hooks.abandon.mockImplementationOnce(async () => ({ ...(await f.hooks.read()), status: 'succeeded' }));
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.hooks.record).not.toHaveBeenCalled(); expect(f.checkpoint().body['reconciliation']).toBeDefined();
  });
  it('rechecks the reviewed checkpoint after asynchronous authorization', async () => {
    const f = fixture(); const command = await f.command();
    f.authorize.mockImplementationOnce(async () => { f.change({ version: 3 }); return true; });
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled();
  });

  it('recovers a lost fence reply without writing a second receipt', async () => {
    const f = fixture(); const command = await f.command(); const reconcile = f.hooks.store.reconcile;
    f.hooks.store.reconcile = async value => { await reconcile(value); throw new Error('PRIVATE_REPLY_FAILURE'); };
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect((await f.control.reconcile(command)).status).toBe('closed');
    expect(reconcile).toHaveBeenCalledTimes(1); expect(f.noExecution).not.toHaveBeenCalled();
  });

  it('bounds hung authorization waits and retains capacity until the underlying operation settles', async () => {
    vi.useFakeTimers(); const f = fixture(); let release!: (value: boolean) => void;
    f.authorize.mockImplementation(() => new Promise<boolean>(resolve => { release = resolve; }));
    const pending = f.control.inspect(f.request); const assertion = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(1001); await assertion;
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled(); release(true); await f.control.settled();
    expect(f.noExecution).not.toHaveBeenCalled();
  });

  it('limits simultaneous operator work while cancelled storage/policy operations are still pending', async () => {
    const f = fixture(); const releases: ((value: boolean) => void)[] = [];
    f.authorize.mockImplementation(() => new Promise<boolean>(resolve => { releases.push(resolve); }));
    const first = f.control.inspect(f.request); const firstCheck = expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = f.control.inspect(f.request); const secondCheck = expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.control.inspect(f.request)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    f.control.stop(); await firstCheck; await secondCheck; releases.forEach(release => release(true)); await f.control.settled();
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled();
  });

});


it('applies core run policy before loading claimed approvals and preserves existing service authorization', async () => {
  const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate'] }, policy: { version: 'v1',
    authorize: () => ({ effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null }) } });
  try {
    const f = fixture(authorization);
    await expect(f.control.inspect(f.request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.hooks.store.get).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled(); expect(f.noExecution).not.toHaveBeenCalled();
  } finally { authorization.close(); }
});

it('requires core thread reconciliation authority before fencing and audits the verified scope without evidence content', async () => {
  let denied = true; const events: AuthorizationAuditEvent[] = [];
  const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } },
    policy: { version: 'v1', authorize: request => denied && request.resource.kind === 'thread' && request.action === 'reconcile_approval'
      ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null }
      : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } } });
  try {
    const f = fixture(authorization); f.change({ body: { ...f.checkpoint().body, recording: { threadId: 'chat', turnId: 'turn', startSequence: 0 } } });
    const command = await f.command();
    await expect(f.control.reconcile(command)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(f.hooks.store.reconcile).not.toHaveBeenCalled(); expect(f.hooks.abandon).not.toHaveBeenCalled(); expect(f.hooks.record).not.toHaveBeenCalled();
    denied = false; expect(await f.control.reconcile(command)).toMatchObject({ status: 'closed' });
    await f.control.reconcile(command); expect(f.hooks.store.reconcile).toHaveBeenCalledTimes(1); expect(f.noExecution).not.toHaveBeenCalled();
    await authorization.flushAudit();
    expect(events.some(event => event.request?.resource.kind === 'thread' && event.request.resource.id === 'chat')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('external/receipt-1'); expect(JSON.stringify(events)).not.toContain('privateData');
    expect(events.every(event => event.request?.subject.principalId === 'alice')).toBe(true);
  } finally { authorization.close(); }
});
