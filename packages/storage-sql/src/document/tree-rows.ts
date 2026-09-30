import { StorageError } from '../contracts.js';
import type { AggregateRow } from '../aggregate-session.js';
import type { WorkflowOwnerRow } from '../scheduled-persistence.js';
import type { WorkflowTreeJobRow, WorkflowTreeMemberRow, WorkflowTreeTransaction } from '../workflow-tree-persistence.js';
import { compareKeys, key, parts } from './keys.js';
import { at, json, kind, sort } from './layout.js';
import { documentBudgetRows } from './budget-rows.js';
import { documentScheduledRows } from './scheduled-rows.js';
import type { DocumentSession } from './session.js';

/** A tree: `m`+member its members, `j`+job its job links, `a`+account and `n`+parent+node its unique member identities, `r`+reservation. */
const tree = (scope: string, rootId: string) => key('tree', scope, rootId);
const place = { member: key('m'), treeJob: (nodeId: string) => key('t', nodeId), index: (id: string) => key('m', id), job: (jobId: string) => key('j', jobId),
  account: (accountId: string) => key('a', accountId), node: (parentId: string, nodeId: string) => key('n', parentId, nodeId), reservation: (id: string) => key('r', id) };
const kinds = { member: key('m'), job: key('j'), treeJob: key('t') };
function conflict(): never { throw new StorageError('CONFLICT', 'Workflow-tree identity or immutable content changed.'); }
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored workflow tree failed integrity validation.'); }

/** Workflow tree rows as documents, beside the scheduled workflow and budget rows. */
export function documentTreeRows(session: DocumentSession): WorkflowTreeTransaction {
  const scheduled = documentScheduledRows(session);
  const owner = async (scope: string, id: string, lock = false) => json<WorkflowOwnerRow>(await session.get(at.run(scope, id), sort.owner, lock));
  const setOwner = async (scope: string, id: string, change: Partial<WorkflowOwnerRow>) => {
    const row = await owner(scope, id); if (!row) failed();
    await session.put(at.run(scope, id), sort.owner, JSON.stringify({ ...row, ...change }));
  };
  const treeJob = async (scope: string, aggregateId: string, nodeId: string) => json<WorkflowTreeJobRow>(await session.get(at.run(scope, aggregateId), place.treeJob(nodeId), true));
  const byJobId = (a: WorkflowTreeJobRow, b: WorkflowTreeJobRow) => compareKeys(a.job_id, b.job_id);
  return {
    ...scheduled,
    ...documentBudgetRows(session),
    lockedOwner: (scope, id) => owner(scope, id, true),
    setOwnerVersion: (scope, id, aggregateVersion) => setOwner(scope, id, { aggregate_version: aggregateVersion }),
    updateOwnerDefinition: (scope, id, aggregateVersion, definitionHash, resourceHash, data) =>
      setOwner(scope, id, { aggregate_version: aggregateVersion, definition_hash: definitionHash, resource_hash: resourceHash, data }),
    setAggregateDefinition: async (scope, id, definitionHash) => {
      const record = json<AggregateRow>(await session.get(at.run(scope, id), sort.record)); if (!record) failed();
      await session.put(at.run(scope, id), sort.record, JSON.stringify({ ...record, definition_hash: definitionHash }));
    },
    treeMember: async (scope, id, lock) => json<WorkflowTreeMemberRow>(await session.get(at.run(scope, id), place.member, lock)),
    treeMembers: async (scope, rootId) => {
      const ids = (await session.query(tree(scope, rootId), { prefix: kinds.member })).map(item => parts(item.sort)[1]!).sort(compareKeys);
      const rows = await session.getMany(ids.map(id => ({ partition: at.run(scope, id), sort: place.member })), true);
      return rows.map(text => json<WorkflowTreeMemberRow>(text) ?? failed());
    },
    insertTreeMember: async row => {
      const partition = tree(row.scope, row.root_id);
      const identities = [place.index(row.aggregate_id), place.account(row.account_id), ...(row.parent_id === null || row.node_id === null ? [] : [place.node(row.parent_id, row.node_id)])];
      if ((await session.getMany([{ partition: at.run(row.scope, row.aggregate_id), sort: place.member }, ...identities.map(sort => ({ partition, sort }))])).some(found => found !== undefined)) conflict();
      await session.put(at.run(row.scope, row.aggregate_id), place.member, JSON.stringify(row));
      for (const identity of identities) await session.put(partition, identity, JSON.stringify({ aggregate_id: row.aggregate_id }));
    },
    setTreeMemberDefinition: async (scope, id, definitionHash, resourceHash) => {
      const row = json<WorkflowTreeMemberRow>(await session.get(at.run(scope, id), place.member)); if (!row) failed();
      await session.put(at.run(scope, id), place.member, JSON.stringify({ ...row, definition_hash: definitionHash, resource_hash: resourceHash }));
    },
    treeJob,
    treeJobsOfRoot: async (scope, rootId) => {
      const links = (await session.query(tree(scope, rootId), { prefix: kinds.job })).map(item => json<{ aggregate_id: string; node_id: string }>(item.body)!);
      const rows = await session.getMany(links.map(link => ({ partition: at.run(scope, link.aggregate_id), sort: place.treeJob(link.node_id) })), true);
      return rows.map(text => json<WorkflowTreeJobRow>(text) ?? failed()).sort(byJobId);
    },
    treeJobsOf: async (scope, aggregateId) => (await session.query(at.run(scope, aggregateId), { prefix: kinds.treeJob }, true)).map(item => json<WorkflowTreeJobRow>(item.body)!).sort(byJobId),
    insertTreeJob: async row => {
      const partition = tree(row.scope, row.root_id);
      if ((await session.getMany([{ partition: at.run(row.scope, row.aggregate_id), sort: place.treeJob(row.node_id) }, { partition, sort: place.job(row.job_id) },
        { partition, sort: place.reservation(row.reservation_id) }])).some(found => found !== undefined)) conflict();
      await session.put(at.run(row.scope, row.aggregate_id), place.treeJob(row.node_id), JSON.stringify({ ...row, cost_micros: Number(row.cost_micros) }));
      await session.put(partition, place.job(row.job_id), JSON.stringify({ aggregate_id: row.aggregate_id, node_id: row.node_id }));
      await session.put(partition, place.reservation(row.reservation_id), JSON.stringify({ job_id: row.job_id }));
    },
    lockSchedulerJobs: async (scope, jobIds) => {
      const found: string[] = [];
      for (const jobId of [...jobIds].sort(compareKeys)) if (await scheduled.lockJob(scope, jobId)) found.push(jobId);
      return found;
    },
    lockSchedulerResources: async (scope, jobIds) => {
      const held = new Set<string>();
      for (const jobId of jobIds) {
        const runId = await scheduled.runOf(scope, jobId); if (runId === undefined) continue;
        for (const resourceKey of await scheduled.heldKeys(scope, runId, jobId)) held.add(resourceKey);
      }
      for (const resourceKey of [...held].sort(compareKeys)) await session.get(at.resource(scope, resourceKey), sort.head, true);
    },
    discoverTrees: async (scope, policyHash, afterId, limit) => (await session.query(at.discovery(scope, policyHash, 3), { prefix: kind.discovered,
      ...(afterId === '' ? {} : { after: sort.discovered(afterId) }), limit })).map(item => parts(item.sort)[1]!),
  };
}
