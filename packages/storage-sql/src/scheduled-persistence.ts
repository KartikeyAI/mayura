import type { CreateRecord, StoredEventInput, StoredRecord } from './contracts.js';
import { createAggregate, initializeOwnership, loadAggregate, writeAggregate, type AggregateRow } from './aggregate-session.js';
import { advisoryLock, binaryCollation, rowLock } from './dialect.js';
import { initializeCompletions, sqlCompletions, type CompletionRow } from './execution-completions.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';
import { sqlSchedulerTransaction, type SchedulerTransaction } from './scheduler-persistence.js';
import { initializeWorkflowGraphDiscoveryIndex } from './workflow-graph-discovery-index.js';

/** A run's enrollment in scheduled execution: its pinned definition, policy and resources, and its command journal (`data`). */
export interface WorkflowOwnerRow {
  scope: string; aggregate_id: string; profile: number | string; aggregate_version: number | string;
  definition_hash: string; policy_hash: string; resource_hash: string; data: string;
}
/** One edge from a waiting graph node to the run it waits on. */
export interface WorkflowWaitTargetRow {
  scope: string; aggregate_id: string; node_id: string; ordinal: number | string; run_id: string; definition_hash: string; policy_hash: string;
}

/**
 * The reads and writes the scheduled workflow state machine makes inside one transaction, besides the scheduler's
 * own. Aggregate reads lock the record until the transaction ends (`skip`: or return nothing if another holds it).
 */
export interface ScheduledTransaction extends SchedulerTransaction {
  aggregate(scope: string, id: string, skip: boolean): Promise<AggregateRow | undefined>;
  /** Creates the record unless its idempotency key is taken; otherwise returns the existing record, locked. */
  createAggregate(input: CreateRecord, now: number): Promise<{ row: AggregateRow; created: boolean }>;
  /** Writes the locked record's next state and version, and appends its events. */
  writeAggregate(row: AggregateRow, state: StoredRecord['state'], events: readonly StoredEventInput[], now: number): Promise<AggregateRow>;
  /** Moves a migrated run to its new definition: the record's definition hash and the owner's definition and resource hashes. */
  redefine(scope: string, id: string, definitionHash: string, resourceHash: string): Promise<void>;
  owner(scope: string, id: string): Promise<WorkflowOwnerRow | undefined>;
  /** Another run's immutable enrollment identity, read without its state or journal and without locking it. */
  ownerIdentity(scope: string, id: string): Promise<Pick<WorkflowOwnerRow, 'scope' | 'aggregate_id' | 'profile' | 'definition_hash' | 'policy_hash'> | undefined>;
  insertOwner(row: WorkflowOwnerRow): Promise<void>;
  updateOwner(scope: string, id: string, aggregateVersion: number | string, data: string): Promise<void>;
  /** Locks the run's scheduler jobs in id order, then the resources they hold in key order; returns the job ids. */
  lockRunJobs(scope: string, runId: string): Promise<string[]>;
  /** Whether any scheduler job belongs to the run. */
  runHasJobs(scope: string, runId: string): Promise<boolean>;
  /** The run's node-to-job links, in job id order. */
  links(scope: string, id: string): Promise<{ node_id: string; job_id: string }[]>;
  insertLink(scope: string, id: string, nodeId: string, jobId: string): Promise<void>;
  /** Up to 129 of the run's wait edges. */
  waitTargets(scope: string, id: string): Promise<WorkflowWaitTargetRow[]>;
  deleteWaitTargets(scope: string, id: string): Promise<void>;
  insertWaitTarget(row: WorkflowWaitTargetRow): Promise<void>;
  /** Whether another workflow waits on the run. */
  workflowWaitsOn(scope: string, runId: string): Promise<boolean>;
  /** Whether an execution wait targets the run (execution waits are optional storage). */
  executionWaitTargets(scope: string, runId: string): Promise<boolean>;
  completion(scope: string, runId: string): Promise<CompletionRow | undefined>;
  insertCompletion(row: CompletionRow): Promise<void>;
  /** Up to `limit` graph runs (profile 2) under one policy with ids above `afterId`, in byte order. */
  discoverRuns(scope: string, policyHash: string, afterId: string, limit: number): Promise<string[]>;
}
export interface ScheduledPersistence {
  /** Creates the owner, completion, link and wait-target storage. */
  initialize(): Promise<void>;
  /** Creates the index graph discovery scans; only on request, never as an unindexed fallback. */
  initializeDiscovery(): Promise<void>;
  transaction<T>(body: (tx: ScheduledTransaction) => Promise<T>): Promise<T>;
}

/** The scheduled workflow rows in the SQL layer's tables: the SQL every SQL adapter has always run for them. */
export function sqlScheduledTransaction(backend: SchedulerBackend, tx: SchedulerSession): ScheduledTransaction {
  const table = (name: 'owners' | 'jobs' | 'wait_targets') => `${backend.prefix}mayura_workflow_${name}`;
  return {
    ...sqlSchedulerTransaction(backend, tx),
    aggregate: (scope, id, skip) => loadAggregate(tx, backend, scope, id, skip),
    createAggregate: (input, now) => createAggregate(tx, backend, input, now),
    writeAggregate: (row, state, events, now) => writeAggregate(tx, backend, row, state, events, now),
    redefine: async (scope, id, definitionHash, resourceHash) => {
      await tx.query(`UPDATE ${backend.prefix}mayura_aggregates SET definition_hash = ? WHERE scope = ? AND id = ?`,[definitionHash,scope,id]);
      await tx.query(`UPDATE ${table('owners')} SET definition_hash = ?, resource_hash = ? WHERE scope = ? AND aggregate_id = ?`,[definitionHash,resourceHash,scope,id]);
    },
    owner: async (scope, id) => (await tx.query<WorkflowOwnerRow>(`SELECT * FROM ${table('owners')} WHERE scope = ? AND aggregate_id = ?`,[scope,id]))[0],
    ownerIdentity: async (scope, id) => (await tx.query<Pick<WorkflowOwnerRow,'scope'|'aggregate_id'|'profile'|'definition_hash'|'policy_hash'>>(
      `SELECT scope,aggregate_id,profile,definition_hash,policy_hash FROM ${table('owners')} WHERE scope = ? AND aggregate_id = ?`,[scope,id]))[0],
    insertOwner: async row => {
      await tx.query(`INSERT INTO ${table('owners')} (scope,aggregate_id,profile,aggregate_version,definition_hash,policy_hash,resource_hash,data) VALUES (?,?,?,?,?,?,?,?)`,
        [row.scope,row.aggregate_id,row.profile,row.aggregate_version,row.definition_hash,row.policy_hash,row.resource_hash,row.data]);
    },
    updateOwner: async (scope, id, aggregateVersion, data) => {
      await tx.query(`UPDATE ${table('owners')} SET aggregate_version = ?, data = ? WHERE scope = ? AND aggregate_id = ?`,[aggregateVersion,data,scope,id]);
    },
    lockRunJobs: async (scope, runId) => {
      const jobs = await tx.query<{ job_id: string }>(`SELECT job_id FROM ${backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND run_id = ? ORDER BY job_id${rowLock(backend)}`,[scope,runId]);
      // A control command may release several jobs' holds: acquire those rows in one global key order.
      await tx.query(`SELECT resource_key FROM ${backend.prefix}mayura_scheduler_resources WHERE scope = ? AND job_id IN (SELECT job_id FROM ${backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND run_id = ?) ORDER BY resource_key${rowLock(backend)}`,[scope,scope,runId]);
      return jobs.map(row => row.job_id);
    },
    runHasJobs: async (scope, runId) => (await tx.query(`SELECT job_id FROM ${backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND run_id = ? LIMIT 1`,[scope,runId])).length > 0,
    links: async (scope, id) => [...await tx.query<{ node_id: string; job_id: string }>(`SELECT node_id, job_id FROM ${table('jobs')} WHERE scope = ? AND aggregate_id = ? ORDER BY job_id`,[scope,id])],
    insertLink: async (scope, id, nodeId, jobId) => { await tx.query(`INSERT INTO ${table('jobs')} (scope,aggregate_id,node_id,job_id) VALUES (?,?,?,?)`,[scope,id,nodeId,jobId]); },
    waitTargets: async (scope, id) => [...await tx.query<WorkflowWaitTargetRow>(`SELECT * FROM ${table('wait_targets')} WHERE scope = ? AND aggregate_id = ? LIMIT 129`,[scope,id])],
    deleteWaitTargets: async (scope, id) => { await tx.query(`DELETE FROM ${table('wait_targets')} WHERE scope = ? AND aggregate_id = ?`,[scope,id]); },
    insertWaitTarget: async row => {
      await tx.query(`INSERT INTO ${table('wait_targets')} (scope,aggregate_id,node_id,ordinal,run_id,definition_hash,policy_hash) VALUES (?,?,?,?,?,?,?)`,
        [row.scope,row.aggregate_id,row.node_id,row.ordinal,row.run_id,row.definition_hash,row.policy_hash]);
    },
    workflowWaitsOn: async (scope, runId) => (await tx.query(`SELECT aggregate_id FROM ${table('wait_targets')} WHERE scope = ? AND run_id = ? LIMIT 1`,[scope,runId])).length > 0,
    executionWaitTargets: async (scope, runId) => {
      // Probe the table without failing the transaction when it was never created.
      const waitTable = `${backend.prefix}mayura_execution_wait_targets`;
      const present = backend.dialect === 'postgres'
        ? (await tx.query<{ found: string | null }>('SELECT to_regclass(?)::text AS found',[waitTable]))[0]?.found
        : backend.dialect === 'mysql'
          ? (await tx.query<{ name: string }>('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',[waitTable]))[0]?.name
          : (await tx.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",[waitTable]))[0]?.name;
      return Boolean(present) && (await tx.query(`SELECT run_id FROM ${waitTable} WHERE scope = ? AND run_id = ? LIMIT 1`,[scope,runId])).length > 0;
    },
    ...sqlCompletions(tx, backend),
    discoverRuns: async (scope, policyHash, afterId, limit) => {
      const collation = binaryCollation(backend);
      return (await tx.query<{ aggregate_id: string }>(
        `SELECT aggregate_id FROM ${table('owners')} WHERE scope = ? AND policy_hash = ? AND profile = 2
          AND aggregate_id COLLATE ${collation} > ? ORDER BY aggregate_id COLLATE ${collation} LIMIT ?`,
        [scope,policyHash,afterId,limit])).map(row => row.aggregate_id);
    },
  };
}

/** The SQL layer's scheduled workflow tables on a backend. */
export function sqlScheduledPersistence(backend: SchedulerBackend): ScheduledPersistence {
  const table = (name: 'owners' | 'jobs' | 'wait_targets') => `${backend.prefix}mayura_workflow_${name}`;
  return {
    transaction: body => backend.transaction(tx => body(sqlScheduledTransaction(backend, tx))),
    initialize: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:scheduled-schema:${backend.prefix}`);
      await initializeOwnership(tx,backend);
      await initializeCompletions(tx,backend);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table('jobs')} (scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, node_id TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(scope,aggregate_id,node_id), UNIQUE(scope,job_id), FOREIGN KEY(scope,aggregate_id) REFERENCES ${table('owners')}(scope,aggregate_id),
        FOREIGN KEY(scope,job_id) REFERENCES ${backend.prefix}mayura_scheduler_jobs(scope,job_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table('wait_targets')} (
        scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, node_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
        run_id TEXT NOT NULL, definition_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
        PRIMARY KEY(scope,aggregate_id,node_id,ordinal), UNIQUE(scope,aggregate_id,node_id,run_id),
        FOREIGN KEY(scope,aggregate_id) REFERENCES ${table('owners')}(scope,aggregate_id))`);
    }),
    initializeDiscovery: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:scheduled-schema:${backend.prefix}`);
      await initializeWorkflowGraphDiscoveryIndex(tx,backend);
    }),
  };
}
