import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecutionRef, type ScheduledWorkflowSnapshot, type WorkflowGraphStoreSnapshot,
  type WorkflowGraphManifest, type WorkflowPolicyManifest,
} from '@mayura/storage-contracts';
import {
  ScheduledWorkflowDatabase, SchedulerDatabase, scheduledFacade, workflowGraphFacade,
  type SchedulerBackend, type SchedulerSession,
} from '@mayura/storage-sql/host';

/** Real SQLite transactions; instrumentation counts reads without substituting data or a clock. */
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
  const targetIds = new Set<string>();
  const reads = { identity: 0, fact: 0 };
  const session: SchedulerSession = { async query<T>(sql: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
    if (targetIds.has(parameters[1] as string)) {
      if (sql.startsWith('SELECT scope,aggregate_id,profile,definition_hash,policy_hash FROM mayura_workflow_owners')) reads.identity++;
      if (sql.startsWith('SELECT * FROM mayura_execution_completions')) reads.fact++;
    }
    const statement = database.prepare(sql);
    if (statement.reader) return statement.all(...parameters) as T[];
    statement.run(...parameters); return [];
  } };
  const backend: SchedulerBackend = { dialect: 'sqlite', prefix: '', async transaction(body) {
    database.exec('BEGIN IMMEDIATE');
    try { const result = await body(session); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const coordinator = new ScheduledWorkflowDatabase(backend, new SchedulerDatabase(backend));
  return {
    database, reads, targetIds, reset() { reads.identity = 0; reads.fact = 0; }, close() { database.close(); },
    workflows: scheduledFacade((method,input) => coordinator.execute(method,input)),
    graphs: workflowGraphFacade((method,input) => coordinator.execute(method,input,2)),
  };
}

const policy: WorkflowPolicyManifest = { scope: { principalId: 'dedup', projectId: 'graph-read-dedup' },
  permissions: [], policyVersion: '1', maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 60_000 };
type Snapshot = ScheduledWorkflowSnapshot | WorkflowGraphStoreSnapshot;
const access = (snapshot: Snapshot) => ({ scope:snapshot.record.scope,id:snapshot.record.id,policyHash:snapshot.policyHash });
const write = (snapshot: Snapshot,commandId: string) => ({ ...access(snapshot),expectedVersion:snapshot.record.version,commandId });
const reference = (snapshot: Snapshot): ExecutionRef => ({ kind:'scheduled-workflow',runId:snapshot.record.id,definitionHash:snapshot.manifestHash,policyHash:snapshot.policyHash });

describe('graph target reads are bounded by unique references per locked load', () => {
  let current: ReturnType<typeof fixture>;
  beforeEach(async () => { current = fixture(); await current.graphs.initialize(); });
  afterEach(() => current.close());
  async function target(key: string) {
    const snapshot = (await current.workflows.submit({ manifest:{id:'target',version:'1',graph:[{kind:'join',id:'done',dependsOn:[]}],result:{kind:'literal',value:null}},
      policy,resources:{},input:null,idempotencyKey:key })).snapshot;
    current.targetIds.add(snapshot.record.id); return snapshot;
  }
  async function graph(targets: readonly ExecutionRef[]) {
    const manifest: WorkflowGraphManifest = {format:3,id:'dedup',version:'1',graph:Array.from({length:128},(_,index) => ({
      kind:'wait' as const,id:`wait${index}`,dependsOn:[],targets:{kind:'literal' as const,value:[targets[index % targets.length]!] },
    })),result:{kind:'literal',value:null}};
    return (await current.graphs.submit({manifest,policy,resources:{},input:null,idempotencyKey:'parent'})).snapshot;
  }

  it('reads one target identity and missing fact for 128 reused edges, including save revalidation', async () => {
    const child = await target('one'); const parent = await graph([reference(child)]);
    current.reset();
    await current.graphs.inspect(access(parent));
    expect(current.reads).toEqual({identity:1,fact:1});
    current.reset();
    const waiting = await current.graphs.advance(write(parent,'waiting'));
    expect(waiting.record.state['status']).toBe('waiting');
    expect(current.reads).toEqual({identity:1,fact:1});
  });

  it('keeps distinct references independent while preserving repeated target order', async () => {
    const first = await target('first'); const second = await target('second');
    const parent = await graph([reference(first),reference(second)]);
    current.reset(); await current.graphs.inspect(access(parent));
    expect(current.reads).toEqual({identity:2,fact:2});
  });

  it('does not reuse a missing observation across commands or erase already published facts', async () => {
    let child = await target('later'); const parent = await graph([reference(child)]);
    await current.graphs.inspect(access(parent));
    child = await current.workflows.advance(write(child,'child-advance'));
    child = await current.workflows.finalize({...write(child,'child-finalize'),validation:'passed',output:null});
    current.reset();
    const resolved = await current.graphs.advance(write(parent,'resolve'));
    const steps = resolved.record.state['steps'] as Record<string,{status:string;output:unknown}>;
    expect(Object.values(steps)).toHaveLength(128);
    expect(Object.values(steps).every(step => step.status === 'succeeded')).toBe(true);
    expect(steps['wait127']!.output).toMatchObject([{reference:reference(child),outcome:'succeeded'}]);
    expect(current.reads).toEqual({identity:1,fact:1});
    current.reset(); await current.graphs.inspect(access(resolved));
    expect(current.reads).toEqual({identity:1,fact:1});
  });

  it('still validates every repeated parent row instead of trusting the first matching target', async () => {
    const child = await target('tamper'); const parent = await graph([reference(child)]);
    current.database.prepare('UPDATE mayura_workflow_wait_targets SET definition_hash = ? WHERE scope = ? AND aggregate_id = ? AND node_id = ?')
      .run('f'.repeat(64),parent.record.scope,parent.record.id,'wait127');
    await expect(current.graphs.inspect(access(parent))).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  });
});
