import { MongoServerError, type ClientSession, type Collection, type Db, type Document } from 'mongodb';
import { StorageError } from 'mayura/storage-contracts';
import type { WorkflowOwnerRow, WorkflowTreeJobRow, WorkflowTreeMemberRow, WorkflowTreePersistence, WorkflowTreeTransaction } from 'mayura/storage-sql/host';
import { mongoBudgetRows } from './budget-rows.js';
import type { Transaction } from './memory.js';
import { serverClockOffset, touch } from './scheduler.js';
import { mongoScheduledRows } from './workflows.js';

const noId = { projection: { _id: 0, mayuraLocks: 0 } } as const;
const discoveryKey = { scope: 1, policy_hash: 1, profile: 1, aggregate_id: 1 } as const;

/** Workflow trees in MongoDB: members and their job links, beside the scheduled workflow, scheduler and budget documents. */
export function mongoWorkflowTreePersistence(db: Db, transaction: Transaction): WorkflowTreePersistence {
  const members: Collection<WorkflowTreeMemberRow> = db.collection('mayura_workflow_tree_members');
  const jobs: Collection<WorkflowTreeJobRow> = db.collection('mayura_workflow_tree_jobs');
  const owners = db.collection('mayura_workflow_owners');
  return {
    initialize: async () => {
      await owners.createIndexes([{ key: { scope: 1, aggregate_id: 1 }, name: 'mayura_workflow_owners_id', unique: true }]);
      // A member's parent and node are unique only where present: the root has neither.
      await members.createIndexes([{ key: { scope: 1, aggregate_id: 1 }, name: 'mayura_workflow_tree_members_id', unique: true },
        { key: { scope: 1, root_id: 1, account_id: 1 }, name: 'mayura_workflow_tree_members_account', unique: true },
        { key: { scope: 1, parent_id: 1, node_id: 1 }, name: 'mayura_workflow_tree_members_node', unique: true, partialFilterExpression: { parent_id: { $type: 'string' } } },
        { key: { scope: 1, root_id: 1, aggregate_id: 1 }, name: 'mayura_workflow_tree_members_root_idx' }]);
      await jobs.createIndexes([{ key: { scope: 1, aggregate_id: 1, node_id: 1 }, name: 'mayura_workflow_tree_jobs_id', unique: true },
        { key: { scope: 1, job_id: 1 }, name: 'mayura_workflow_tree_jobs_job', unique: true },
        { key: { scope: 1, root_id: 1, reservation_id: 1 }, name: 'mayura_workflow_tree_jobs_reservation', unique: true }]);
    },
    initializeDiscovery: async () => {
      // The same index graph discovery uses, checked the same way.
      const invalid = () => new StorageError('STORAGE_UNAVAILABLE', 'The workflow graph discovery index failed integrity validation.');
      try { await owners.createIndexes([{ key: discoveryKey, name: 'mayura_workflow_owners_discovery' }]); }
      catch (error) { if (error instanceof MongoServerError && [85, 86].includes(error.code as number)) throw invalid(); throw error; }
      const index = (await owners.listIndexes().toArray()).find(item => item['name'] === 'mayura_workflow_owners_discovery');
      if (!index || Object.keys(index).some(option => !['v', 'key', 'name'].includes(option)) || JSON.stringify(index['key']) !== JSON.stringify(discoveryKey)) throw invalid();
    },
    transaction: async body => { const skew = await serverClockOffset(db); return transaction(session => body(mongoWorkflowTreeRows(db, session, skew))); },
  };
}

function mongoWorkflowTreeRows(db: Db, session: ClientSession, skew: number): WorkflowTreeTransaction {
  const members: Collection<WorkflowTreeMemberRow> = db.collection('mayura_workflow_tree_members');
  const jobs: Collection<WorkflowTreeJobRow> = db.collection('mayura_workflow_tree_jobs');
  const owners: Collection<WorkflowOwnerRow> = db.collection('mayura_workflow_owners');
  const aggregates = db.collection('mayura_aggregates');
  const schedulerJobs = db.collection('mayura_scheduler_jobs');
  const resources = db.collection('mayura_scheduler_resources');
  /** Locks each document `filter` selects, in the order of its unique `key` within the scope, and returns them. */
  const lockAll = async <T extends Document>(collection: Collection<T>, filter: Document, key: string): Promise<T[]> => {
    const found = await (collection as unknown as Collection<Document>).find(filter, { ...noId, session }).sort({ [key]: 1 }).toArray() as unknown as T[];
    for (const document of found) await touch(collection as unknown as Collection<Document>, { scope: filter['scope'], [key]: document[key] }, session);
    return found;
  };
  return {
    ...mongoScheduledRows(db, session, skew),
    ...mongoBudgetRows(db, session, skew),
    lockedOwner: async (scope, id) => {
      if (!await touch(owners as unknown as Collection<Document>, { scope, aggregate_id: id }, session)) return undefined;
      return await owners.findOne({ scope, aggregate_id: id }, { ...noId, session }) ?? undefined;
    },
    setOwnerVersion: async (scope, id, version) => { await owners.updateOne({ scope, aggregate_id: id }, { $set: { aggregate_version: version } }, { session }); },
    updateOwnerDefinition: async (scope, id, version, definitionHash, resourceHash, data) => {
      await owners.updateOne({ scope, aggregate_id: id }, { $set: { aggregate_version: version, definition_hash: definitionHash, resource_hash: resourceHash, data } }, { session });
    },
    setAggregateDefinition: async (scope, id, definitionHash) => { await aggregates.updateOne({ scope, id }, { $set: { definitionHash } }, { session }); },
    treeMember: async (scope, id, lock) => {
      if (lock && !await touch(members as unknown as Collection<Document>, { scope, aggregate_id: id }, session)) return undefined;
      return await members.findOne({ scope, aggregate_id: id }, { ...noId, session }) ?? undefined;
    },
    treeMembers: (scope, rootId) => lockAll(members, { scope, root_id: rootId }, 'aggregate_id'),
    insertTreeMember: async row => { await members.insertOne({ ...row }, { session }); },
    setTreeMemberDefinition: async (scope, id, definitionHash, resourceHash) => {
      await members.updateOne({ scope, aggregate_id: id }, { $set: { definition_hash: definitionHash, resource_hash: resourceHash } }, { session });
    },
    treeJob: async (scope, aggregateId, nodeId) => {
      if (!await touch(jobs as unknown as Collection<Document>, { scope, aggregate_id: aggregateId, node_id: nodeId }, session)) return undefined;
      return await jobs.findOne({ scope, aggregate_id: aggregateId, node_id: nodeId }, { ...noId, session }) ?? undefined;
    },
    treeJobsOfRoot: (scope, rootId) => lockAll(jobs, { scope, root_id: rootId }, 'job_id'),
    treeJobsOf: (scope, aggregateId) => lockAll(jobs, { scope, aggregate_id: aggregateId }, 'job_id'),
    insertTreeJob: async row => { await jobs.insertOne({ ...row, cost_micros: Number(row.cost_micros) }, { session }); },
    lockSchedulerJobs: async (scope, jobIds) => (await lockAll(schedulerJobs, { scope, job_id: { $in: [...jobIds] } }, 'job_id')).map(job => job['job_id'] as string),
    lockSchedulerResources: async (scope, jobIds) => {
      const held = await resources.find({ scope, job_id: { $in: [...jobIds] } }, { projection: { _id: 0, resource_key: 1 }, session }).sort({ resource_key: 1, job_id: 1 }).toArray();
      for (const resource of held) await touch(resources, { scope, resource_key: resource['resource_key'] }, session);
    },
    discoverTrees: async (scope, policyHash, afterId, limit) => (await owners.find({ scope, policy_hash: policyHash, profile: 3, aggregate_id: { $gt: afterId } },
      { projection: { _id: 0, aggregate_id: 1 }, session }).sort({ aggregate_id: 1 }).limit(limit).toArray()).map(owner => owner.aggregate_id),
  };
}
