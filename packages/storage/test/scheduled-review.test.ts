import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workflowState, type ScheduledWorkflowSnapshot, type WorkflowManifest, type WorkflowPolicyManifest } from '@mayura/storage-contracts';
import { ScheduledWorkflowDatabase, scheduledFacade, SchedulerDatabase, type SchedulerBackend, type SchedulerSession } from '@mayura/storage-sql/host';

/** Real transactional SQLite with only the internal storage-clock query made deterministic. */
function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE mayura_aggregates (
    scope TEXT NOT NULL, id TEXT NOT NULL, idempotency_key TEXT NOT NULL, definition_hash TEXT NOT NULL,
    submission_digest TEXT NOT NULL, version INTEGER NOT NULL, event_sequence INTEGER NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(scope,id), UNIQUE(scope,idempotency_key));
    CREATE TABLE mayura_events (scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,aggregate_id,sequence),
      FOREIGN KEY(scope,aggregate_id) REFERENCES mayura_aggregates(scope,id));`);
  let time = 1_000;
  const session: SchedulerSession = { async query<T>(sql: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
    if (sql.endsWith(' AS now_ms')) return [{ now_ms: time }] as T[];
    const statement = database.prepare(sql);
    if (statement.reader) return statement.all(...parameters) as T[];
    statement.run(...parameters); return [];
  } };
  const backend: SchedulerBackend = { dialect: 'sqlite', prefix: '', async transaction(body) {
    database.exec('BEGIN IMMEDIATE');
    try { const result = await body(session); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const scheduler = new SchedulerDatabase(backend);
  const coordinator = new ScheduledWorkflowDatabase(backend, scheduler);
  return { store: scheduledFacade((method, input) => coordinator.execute(method, input)), scheduler,
    setTime(value: number) { time = value; }, close() { database.close(); } };
}

const manifest: WorkflowManifest = { id: 'clock-review', version: '1', graph: [{ kind: 'tool', id: 'action',
  dependsOn: [], tool: 'action', toolVersion: '1', effects: 'none', capabilities: [], costMicros: 7, approval: true,
  input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'action', path: [] } };
const policy: WorkflowPolicyManifest = { scope: { principalId: 'reviewer', projectId: 'clock-review' },
  permissions: ['tool:action'], policyVersion: '1', maxCostMicros: 7, maxOutputBytes: 65_536, approvalTtlMs: 100 };
function access(snapshot: ScheduledWorkflowSnapshot) {
  return { scope: snapshot.record.scope, id: snapshot.record.id, policyHash: snapshot.policyHash };
}
function write(snapshot: ScheduledWorkflowSnapshot, commandId: string) {
  return { ...access(snapshot), expectedVersion: snapshot.record.version, commandId };
}

describe('scheduled storage clock and evidence review', () => {
  let current: ReturnType<typeof fixture>;
  beforeEach(async () => { current = fixture(); await current.store.initialize(); });
  afterEach(() => current.close());
  async function waiting(idempotencyKey = 'clock', resourceKeys: readonly string[] = []) {
    const submitted = (await current.store.submit({ manifest, policy, resources: { action: resourceKeys }, input: { safe: true }, idempotencyKey })).snapshot;
    const snapshot = await current.store.requestApproval({ ...write(submitted, 'review'), nodeId: 'action', input: { safe: true } });
    return { snapshot, digest: workflowState(snapshot.record).steps['action']!.approval!.digest };
  }
  async function prepared(idempotencyKey = 'clock', resourceKeys: readonly string[] = []) {
    const { snapshot, digest } = await waiting(idempotencyKey, resourceKeys);
    const approved = await current.store.approve({ ...write(snapshot, 'approve'), nodeId: 'action', digest, humanId: 'human' });
    return current.store.prepare({ ...write(approved, 'prepare'), nodeId: 'action', input: { safe: true } });
  }
  async function started() {
    const ready = await prepared('clock', ['shared-resource']);
    const claims = await current.store.claim({ ...access(ready), workerId: 'worker', limit: 1, leaseMs: 1_000 });
    const token = claims[0]!.claim;
    const leased = await current.store.inspect(access(ready));
    const snapshot = (await current.store.start({ ...write(leased, 'start'), claim: token, input: { safe: true } })).snapshot;
    const receipt = { toolId: 'action', callId: `${snapshot.record.id}/step:action`, disclosure: 'withheld' as const };
    return { snapshot, token, receipt, evidence: { ...access(snapshot), jobId: token.jobId, fence: token.fence } };
  }

  it('does not resurrect an approval after rejected expiry and clock rollback', async () => {
    const { snapshot, digest } = await waiting();
    current.setTime(1_101);
    await expect(current.store.approve({ ...write(snapshot, 'expired'), nodeId: 'action', digest, humanId: 'human' })).rejects.toMatchObject({ code: 'CONFLICT' });
    current.setTime(1_050);
    const refreshed = await current.store.inspect(access(snapshot));
    await expect(current.store.approve({ ...write(refreshed, 'rolled-back'), nodeId: 'action', digest, humanId: 'human' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not resurrect an approved candidate after prepare observes expiry', async () => {
    const { snapshot, digest } = await waiting();
    const approved = await current.store.approve({ ...write(snapshot, 'approve'), nodeId: 'action', digest, humanId: 'human' });
    current.setTime(1_101);
    await expect(current.store.prepare({ ...write(approved, 'expired'), nodeId: 'action', input: { safe: true } })).rejects.toMatchObject({ code: 'CONFLICT' });
    current.setTime(1_050);
    const refreshed = await current.store.inspect(access(approved));
    await expect(current.store.prepare({ ...write(refreshed, 'rolled-back'), nodeId: 'action', input: { safe: true } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await current.store.inspect(access(approved))).jobs).toHaveLength(0);
  });

  it('requires a fresh digest and fresh human decision after observing unprepared expiry', async () => {
    const { snapshot, digest } = await waiting();
    const approved = await current.store.approve({ ...write(snapshot, 'approve'), nodeId: 'action', digest, humanId: 'first-human' });
    current.setTime(1_101);
    await expect(current.store.prepare({ ...write(approved, 'expired'), nodeId: 'action', input: { safe: true } })).rejects.toMatchObject({ code: 'CONFLICT' });
    current.setTime(1_050);
    const observed = await current.store.inspect(access(approved));
    const requested = await current.store.requestApproval({ ...write(observed, 'fresh-review'), nodeId: 'action', input: { safe: true } });
    const review = workflowState(requested.record).steps['action']!.approval!;
    expect(review.digest).not.toBe(digest);
    expect(review.expiresAt).toBeGreaterThanOrEqual(1_201);
    expect(review.humanId).toBeNull();
    await expect(current.store.approve({ ...write(requested, 'old-digest'), nodeId: 'action', digest, humanId: 'second-human' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const refreshed = await current.store.inspect(access(requested));
    const accepted = await current.store.approve({ ...write(refreshed, 'fresh-digest'), nodeId: 'action', digest: review.digest, humanId: 'second-human' });
    expect(workflowState(accepted.record).steps['action']!.approval!.humanId).toBe('second-human');
  });

  it('keeps prepared approval expiry sticky, refunds once, and never reclaims its job', async () => {
    const ready = await prepared();
    current.setTime(1_101);
    expect(await current.store.claim({ ...access(ready), workerId: 'worker', limit: 1, leaseMs: 1_000 })).toEqual([]);
    current.setTime(1_050);
    expect(await current.store.claim({ ...access(ready), workerId: 'worker', limit: 1, leaseMs: 1_000 })).toEqual([]);
    const observed = await current.store.inspect(access(ready));
    expect(observed.jobs[0]).toMatchObject({ state: 'cancelled', startedAtMs: null });
    expect(workflowState(observed.record)).toMatchObject({ reservedMicros: 0, spentMicros: 0, steps: { action: { status: 'blocked' } } });
    await expect(current.store.prepare({ ...write(observed, 'reprepare'), nodeId: 'action', input: { safe: true } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('retains a successful late fact and fixed cost once while output and resource stay quarantined', async () => {
    const run = await started();
    await current.store.recordReceipt({ ...run.evidence, evidenceId: 'unknown', receipt: { ...run.receipt, execution: 'unknown' } });
    const known = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'known', receipt: { ...run.receipt, execution: 'succeeded' } });
    expect(workflowState(known.record)).toMatchObject({ spentMicros: 7, reservedMicros: 0, output: null,
      steps: { action: { status: 'unknown', output: null, receipt: { execution: 'succeeded', disclosure: 'withheld' } } } });
    const retried = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'known', receipt: { ...run.receipt, execution: 'succeeded' } });
    expect(retried.record.version).toBe(known.record.version);
    const contradicted = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'contradicted', receipt: { ...run.receipt, execution: 'failed' } });
    expect(workflowState(contradicted.record)).toMatchObject({ spentMicros: 7, reservedMicros: 0,
      steps: { action: { receipt: { execution: 'succeeded', disclosure: 'withheld' } } } });
    const journal = await current.scheduler.execute('receipts', { scope: run.token.scope, jobId: run.token.jobId, fence: run.token.fence });
    expect(journal).toMatchObject([{ disposition: 'current' }, { disposition: 'late' }, { disposition: 'conflicting' }]);
    await expect(current.store.complete({ ...write(contradicted, 'complete'), claim: run.token, evidenceId: 'known', outcome: 'succeeded', output: 'hidden' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const competitor = await prepared('competitor', ['shared-resource']);
    expect(await current.store.claim({ ...access(competitor), workerId: 'other-worker', limit: 1, leaseMs: 1_000 })).toEqual([]);
    expect(await current.scheduler.execute('claim', { scope: competitor.record.scope, workerId: 'standalone', limit: 32, leaseMs: 1_000 })).toEqual([]);
  });

  it('accepts monotonic unknown-cost refinement without reopening an uncertain effect', async () => {
    const run = await started();
    await current.store.recordReceipt({ ...run.evidence, evidenceId: 'coarse', receipt: { ...run.receipt, execution: 'unknown' },
      settlement: { knownCostMicros: 0, unknownCostMicros: 7 } });
    const refined = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'refined', receipt: { ...run.receipt, execution: 'unknown' },
      settlement: { knownCostMicros: 3, unknownCostMicros: 2 } });
    expect(workflowState(refined.record)).toMatchObject({ status: 'running', spentMicros: 3, reservedMicros: 2,
      steps: { action: { status: 'unknown', costReserved: 2, receipt: { execution: 'unknown' } } } });
    const stale = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'stale-coarse', receipt: { ...run.receipt, execution: 'unknown' },
      settlement: { knownCostMicros: 0, unknownCostMicros: 7 } });
    expect(workflowState(stale.record)).toMatchObject({ spentMicros: 3, reservedMicros: 2,
      steps: { action: { status: 'unknown', costReserved: 2 } } });
  });

  it('keeps proven not-started settlement free under a later contradictory success claim', async () => {
    const run = await started();
    const notStarted = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'not-started', receipt: { ...run.receipt, execution: 'not_started' } });
    expect(workflowState(notStarted.record)).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
    const contradicted = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'success', receipt: { ...run.receipt, execution: 'succeeded' } });
    expect(workflowState(contradicted.record)).toMatchObject({ spentMicros: 0, reservedMicros: 0,
      steps: { action: { status: 'unknown', output: null, receipt: { execution: 'not_started', disclosure: 'withheld' } } } });
  });

  it('acknowledges committed completion before stale versions but rejects changed output and never reopens admission', async () => {
    const run = await started();
    const known = await current.store.recordReceipt({ ...run.evidence, evidenceId: 'known', receipt: { ...run.receipt, execution: 'succeeded' } });
    const command = { ...write(known, 'complete'), claim: run.token, evidenceId: 'known', outcome: 'succeeded' as const, output: { accepted: true } };
    const completed = await current.store.complete(command);
    current.setTime(3_000);
    const retried = await current.store.complete({ ...command, claim: { ...run.token, leaseUntilMs: 9_000 } });
    expect(retried.record.version).toBe(completed.record.version);
    expect(workflowState(retried.record)).toMatchObject({ spentMicros: 7, reservedMicros: 0,
      steps: { action: { status: 'succeeded', output: { accepted: true }, receipt: { execution: 'succeeded', disclosure: 'released' } } } });
    await expect(current.store.complete({ ...command, output: { accepted: false } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await current.store.claim({ ...access(completed), workerId: 'other-worker', limit: 1, leaseMs: 1_000 })).toEqual([]);
  });
});
