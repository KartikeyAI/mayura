import { initializeOwnership, lockSql } from './aggregate-session.js';
import { advisoryLock, binaryCollation } from './dialect.js';
import { sqlDurableBudgetTransaction, type DurableBudgetTransaction } from './durable-budget-persistence.js';
import { sqlScheduledTransaction, type ScheduledTransaction, type WorkflowOwnerRow } from './scheduled-persistence.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';
import { initializeWorkflowGraphDiscoveryIndex } from './workflow-graph-discovery-index.js';

/** A run's place in a workflow tree: the root (no parent or node, account `root`) or a child admitted by a root node. */
export interface WorkflowTreeMemberRow {
  scope: string; root_id: string; aggregate_id: string; parent_id: string | null; node_id: string | null; account_id: string;
  definition_hash: string; policy_hash: string; resource_hash: string;
}
/** A tree member's tool node, its scheduler job and its budget reservation. */
export interface WorkflowTreeJobRow {
  scope: string; root_id: string; aggregate_id: string; node_id: string; job_id: string; account_id: string; reservation_id: string; cost_micros: number | string;
}

/**
 * The reads and writes the workflow tree state machine makes inside one transaction, besides the scheduled workflow
 * and budget ones. Reads marked locked hold their rows until the transaction ends.
 */
export interface WorkflowTreeTransaction extends ScheduledTransaction, DurableBudgetTransaction {
  /** The run's enrollment, locked. */
  lockedOwner(scope: string, id: string): Promise<WorkflowOwnerRow | undefined>;
  setOwnerVersion(scope: string, id: string, aggregateVersion: number | string): Promise<void>;
  /** Moves a migrated root's enrollment to its new definition, resources and journal. */
  updateOwnerDefinition(scope: string, id: string, aggregateVersion: number | string, definitionHash: string, resourceHash: string, data: string): Promise<void>;
  /** Moves a migrated root's record to its new definition hash. */
  setAggregateDefinition(scope: string, id: string, definitionHash: string): Promise<void>;
  treeMember(scope: string, id: string, lock: boolean): Promise<WorkflowTreeMemberRow | undefined>;
  /** Every member of the tree, locked, in id order. */
  treeMembers(scope: string, rootId: string): Promise<WorkflowTreeMemberRow[]>;
  insertTreeMember(row: WorkflowTreeMemberRow): Promise<void>;
  setTreeMemberDefinition(scope: string, id: string, definitionHash: string, resourceHash: string): Promise<void>;
  /** One member node's job link, locked. */
  treeJob(scope: string, aggregateId: string, nodeId: string): Promise<WorkflowTreeJobRow | undefined>;
  /** Every job link of the tree, locked, in job id order. */
  treeJobsOfRoot(scope: string, rootId: string): Promise<WorkflowTreeJobRow[]>;
  /** Every job link of one member, locked, in job id order. */
  treeJobsOf(scope: string, aggregateId: string): Promise<WorkflowTreeJobRow[]>;
  insertTreeJob(row: WorkflowTreeJobRow): Promise<void>;
  /** Locks these scheduler jobs in id order; returns the ids found. */
  lockSchedulerJobs(scope: string, jobIds: readonly string[]): Promise<string[]>;
  /** Locks the resources these jobs hold, in key order. */
  lockSchedulerResources(scope: string, jobIds: readonly string[]): Promise<void>;
  /** Up to `limit` tree roots and members (profile 3) under one policy with ids above `afterId`, in byte order. */
  discoverTrees(scope: string, policyHash: string, afterId: string, limit: number): Promise<string[]>;
}
export interface WorkflowTreePersistence {
  /** Creates the member and job-link storage. */
  initialize(): Promise<void>;
  /** Creates the index tree discovery scans; only on request. */
  initializeDiscovery(): Promise<void>;
  transaction<T>(body: (tx: WorkflowTreeTransaction) => Promise<T>): Promise<T>;
}

/** The workflow tree rows in the SQL layer's tables: the SQL every SQL adapter has always run for them. */
export function sqlWorkflowTreeTransaction(backend: SchedulerBackend, tx: SchedulerSession): WorkflowTreeTransaction {
  const members = `${backend.prefix}mayura_workflow_tree_members`; const owners = `${backend.prefix}mayura_workflow_owners`;
  const jobs = `${backend.prefix}mayura_workflow_tree_jobs`;
  return {
    ...sqlScheduledTransaction(backend, tx),
    ...sqlDurableBudgetTransaction(backend, tx),
    lockedOwner: async (scope, id) => (await tx.query<WorkflowOwnerRow>(`SELECT * FROM ${owners} WHERE scope = ? AND aggregate_id = ?${lockSql(backend)}`,[scope,id]))[0],
    setOwnerVersion: async (scope, id, version) => { await tx.query(`UPDATE ${owners} SET aggregate_version = ? WHERE scope = ? AND aggregate_id = ?`,[version,scope,id]); },
    updateOwnerDefinition: async (scope, id, version, definitionHash, resourceHash, data) => {
      await tx.query(`UPDATE ${owners} SET aggregate_version = ?, definition_hash = ?, resource_hash = ?, data = ? WHERE scope = ? AND aggregate_id = ?`,[version,definitionHash,resourceHash,data,scope,id]);
    },
    setAggregateDefinition: async (scope, id, definitionHash) => { await tx.query(`UPDATE ${backend.prefix}mayura_aggregates SET definition_hash = ? WHERE scope = ? AND id = ?`,[definitionHash,scope,id]); },
    treeMember: async (scope, id, lock) => (await tx.query<WorkflowTreeMemberRow>(`SELECT * FROM ${members} WHERE scope = ? AND aggregate_id = ?${lock ? lockSql(backend) : ''}`,[scope,id]))[0],
    treeMembers: async (scope, rootId) => [...await tx.query<WorkflowTreeMemberRow>(`SELECT * FROM ${members} WHERE scope = ? AND root_id = ? ORDER BY aggregate_id${lockSql(backend)}`,[scope,rootId])],
    insertTreeMember: async row => {
      await tx.query(`INSERT INTO ${members} (scope,root_id,aggregate_id,parent_id,node_id,account_id,definition_hash,policy_hash,resource_hash) VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.scope,row.root_id,row.aggregate_id,row.parent_id,row.node_id,row.account_id,row.definition_hash,row.policy_hash,row.resource_hash]);
    },
    setTreeMemberDefinition: async (scope, id, definitionHash, resourceHash) => {
      await tx.query(`UPDATE ${members} SET definition_hash = ?, resource_hash = ? WHERE scope = ? AND aggregate_id = ?`,[definitionHash,resourceHash,scope,id]);
    },
    treeJob: async (scope, aggregateId, nodeId) => (await tx.query<WorkflowTreeJobRow>(`SELECT * FROM ${jobs} WHERE scope = ? AND aggregate_id = ? AND node_id = ?${lockSql(backend)}`,[scope,aggregateId,nodeId]))[0],
    treeJobsOfRoot: async (scope, rootId) => [...await tx.query<WorkflowTreeJobRow>(`SELECT * FROM ${jobs} WHERE scope = ? AND root_id = ? ORDER BY job_id${lockSql(backend)}`,[scope,rootId])],
    treeJobsOf: async (scope, aggregateId) => [...await tx.query<WorkflowTreeJobRow>(`SELECT * FROM ${jobs} WHERE scope = ? AND aggregate_id = ? ORDER BY job_id${lockSql(backend)}`,[scope,aggregateId])],
    insertTreeJob: async row => {
      await tx.query(`INSERT INTO ${jobs} (scope,root_id,aggregate_id,node_id,job_id,account_id,reservation_id,cost_micros) VALUES (?,?,?,?,?,?,?,?)`,
        [row.scope,row.root_id,row.aggregate_id,row.node_id,row.job_id,row.account_id,row.reservation_id,row.cost_micros]);
    },
    lockSchedulerJobs: async (scope, jobIds) => {
      const placeholders = jobIds.map(() => '?').join(',');
      return (await tx.query<{ job_id: string }>(`SELECT job_id FROM ${backend.prefix}mayura_scheduler_jobs WHERE scope = ? AND job_id IN (${placeholders}) ORDER BY job_id${lockSql(backend)}`,[scope,...jobIds])).map(row => row.job_id);
    },
    lockSchedulerResources: async (scope, jobIds) => {
      const placeholders = jobIds.map(() => '?').join(',');
      await tx.query(`SELECT resource_key FROM ${backend.prefix}mayura_scheduler_resources WHERE scope = ? AND job_id IN (${placeholders}) ORDER BY resource_key,job_id${lockSql(backend)}`,[scope,...jobIds]);
    },
    discoverTrees: async (scope, policyHash, afterId, limit) => {
      const collation = binaryCollation(backend);
      return (await tx.query<{ aggregate_id: string }>(`SELECT aggregate_id FROM ${owners} WHERE scope = ? AND policy_hash = ? AND profile = 3 AND aggregate_id COLLATE ${collation} > ? ORDER BY aggregate_id COLLATE ${collation} LIMIT ?`,
        [scope,policyHash,afterId,limit])).map(row => row.aggregate_id);
    },
  };
}

/** The SQL layer's workflow tree tables on a backend. */
export function sqlWorkflowTreePersistence(backend: SchedulerBackend): WorkflowTreePersistence {
  const members = `${backend.prefix}mayura_workflow_tree_members`; const owners = `${backend.prefix}mayura_workflow_owners`;
  return {
    transaction: body => backend.transaction(tx => body(sqlWorkflowTreeTransaction(backend, tx))),
    initialize: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:workflow-tree-schema:${backend.prefix}`);
      await initializeOwnership(tx,backend);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${members} (
        scope TEXT NOT NULL,root_id TEXT NOT NULL,aggregate_id TEXT NOT NULL,parent_id TEXT,node_id TEXT,account_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,resource_hash TEXT NOT NULL,
        PRIMARY KEY(scope,aggregate_id),UNIQUE(scope,root_id,account_id),UNIQUE(scope,parent_id,node_id),
        FOREIGN KEY(scope,aggregate_id) REFERENCES ${owners}(scope,aggregate_id),
        CHECK((parent_id IS NULL AND node_id IS NULL AND aggregate_id = root_id AND account_id = 'root') OR (parent_id IS NOT NULL AND node_id IS NOT NULL AND aggregate_id <> root_id AND account_id <> 'root')))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_workflow_tree_members_root_idx ON ${members}(scope,root_id,aggregate_id)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${backend.prefix}mayura_workflow_tree_jobs (
        scope TEXT NOT NULL,root_id TEXT NOT NULL,aggregate_id TEXT NOT NULL,node_id TEXT NOT NULL,job_id TEXT NOT NULL,
        account_id TEXT NOT NULL,reservation_id TEXT NOT NULL,cost_micros BIGINT NOT NULL CHECK(cost_micros >= 0),
        PRIMARY KEY(scope,aggregate_id,node_id),UNIQUE(scope,job_id),UNIQUE(scope,root_id,reservation_id),
        FOREIGN KEY(scope,aggregate_id) REFERENCES ${members}(scope,aggregate_id),
        FOREIGN KEY(scope,job_id) REFERENCES ${backend.prefix}mayura_scheduler_jobs(scope,job_id))`);
    }),
    initializeDiscovery: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:workflow-tree-discovery:${backend.prefix}`);
      await initializeWorkflowGraphDiscoveryIndex(tx,backend);
    }),
  };
}
