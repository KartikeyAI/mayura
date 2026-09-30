import { MongoServerError, type ClientSession, type Collection, type Db, type Document } from 'mongodb';
import { StorageError } from 'mayura/storage-contracts';
import {
  identifier, nextCounter, storedObject, submissionDigest,
  type AggregateRow, type CompletionRow, type ScheduledPersistence, type ScheduledTransaction, type WorkflowOwnerRow, type WorkflowWaitTargetRow,
} from 'mayura/storage-sql/host';
import type { Transaction } from './memory.js';
import { mongoSchedulerRows, serverClockOffset, touch } from './scheduler.js';

interface AggregateDocument {
  scope: string; id: string; idempotencyKey: string; definitionHash: string; submissionDigest: string;
  version: number; eventSequence: number; state: string;
}
interface LinkDocument { scope: string; aggregate_id: string; node_id: string; job_id: string }

const noId = { projection: { _id: 0, mayuraLocks: 0 } } as const;
function row(document: AggregateDocument): AggregateRow {
  return { scope: document.scope, id: document.id, idempotency_key: document.idempotencyKey, definition_hash: document.definitionHash,
    submission_digest: document.submissionDigest, version: document.version, event_sequence: document.eventSequence, state: document.state };
}
function counter(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored aggregate counter is invalid.');
  return result;
}

/**
 * Scheduled workflows in MongoDB: enrollment, node-to-job links, wait edges and published completions, beside the
 * scheduler's documents and the store's aggregates. Locking a document writes it, as the scheduler does.
 */
export function mongoScheduledPersistence(db: Db, transaction: Transaction): ScheduledPersistence {
  const owners: Collection<WorkflowOwnerRow> = db.collection('mayura_workflow_owners');
  const links: Collection<LinkDocument> = db.collection('mayura_workflow_jobs');
  const waits: Collection<WorkflowWaitTargetRow> = db.collection('mayura_workflow_wait_targets');
  const completions: Collection<CompletionRow> = db.collection('mayura_execution_completions');
  return {
    initialize: async () => {
      await owners.createIndexes([{ key: { scope: 1, aggregate_id: 1 }, name: 'mayura_workflow_owners_id', unique: true }]);
      await links.createIndexes([{ key: { scope: 1, aggregate_id: 1, node_id: 1 }, name: 'mayura_workflow_jobs_id', unique: true },
        { key: { scope: 1, job_id: 1 }, name: 'mayura_workflow_jobs_job', unique: true }]);
      await waits.createIndexes([{ key: { scope: 1, aggregate_id: 1, node_id: 1, ordinal: 1 }, name: 'mayura_workflow_wait_targets_id', unique: true },
        { key: { scope: 1, aggregate_id: 1, node_id: 1, run_id: 1 }, name: 'mayura_workflow_wait_targets_run', unique: true },
        { key: { scope: 1, run_id: 1 }, name: 'mayura_workflow_wait_targets_target' }]);
      await completions.createIndexes([{ key: { scope: 1, run_id: 1 }, name: 'mayura_execution_completions_id', unique: true }]);
    },
    initializeDiscovery: async () => {
      // A same-named index is not proof of a usable access path: an existing one must be exactly this one.
      const invalid = () => new StorageError('STORAGE_UNAVAILABLE', 'The workflow graph discovery index failed integrity validation.');
      try { await owners.createIndexes([{ key: { scope: 1, policy_hash: 1, profile: 1, aggregate_id: 1 }, name: 'mayura_workflow_owners_discovery' }]); }
      catch (error) { if (error instanceof MongoServerError && [85, 86].includes(error.code as number)) throw invalid(); throw error; }
      const index = (await owners.listIndexes().toArray()).find(item => item['name'] === 'mayura_workflow_owners_discovery');
      const allowed = new Set(['v', 'key', 'name']);
      if (!index || Object.keys(index).some(option => !allowed.has(option))
        || JSON.stringify(index['key']) !== JSON.stringify({ scope: 1, policy_hash: 1, profile: 1, aggregate_id: 1 })) throw invalid();
    },
    transaction: async body => { const skew = await serverClockOffset(db); return transaction(session => body(mongoScheduledRows(db, session, skew))); },
  };
}

export function mongoScheduledRows(db: Db, session: ClientSession, skew: number): ScheduledTransaction {
  const aggregates: Collection<AggregateDocument> = db.collection('mayura_aggregates');
  const events = db.collection('mayura_events');
  const owners: Collection<WorkflowOwnerRow> = db.collection('mayura_workflow_owners');
  const links: Collection<LinkDocument> = db.collection('mayura_workflow_jobs');
  const waits: Collection<WorkflowWaitTargetRow> = db.collection('mayura_workflow_wait_targets');
  const executionWaits = db.collection('mayura_execution_wait_targets');
  const completions: Collection<CompletionRow> = db.collection('mayura_execution_completions');
  const jobs = db.collection('mayura_scheduler_jobs');
  const resources = db.collection('mayura_scheduler_resources');
  const lockAggregate = async (scope: string, id: string): Promise<AggregateRow | undefined> => {
    if (!await touch(aggregates as unknown as Collection<Document>, { scope, id }, session)) return undefined;
    const found = await aggregates.findOne({ scope, id }, { ...noId, session });
    return found ? row(found) : undefined;
  };
  const append = async (scope: string, id: string, sequence: number, input: readonly { type: string; data: unknown }[], now: number) => {
    if (input.length === 0) return;
    const createdAt = new Date(now).toISOString();
    await events.insertMany(input.map((event, index) => ({ scope, aggregateId: id, sequence: nextCounter(sequence, index + 1), type: identifier(event.type, 'Event'),
      data: JSON.stringify(event.data), createdAt })), { session, ordered: true });
  };
  return {
    ...mongoSchedulerRows(db, session, skew),
    // MongoDB has no SKIP LOCKED: a locked record conflicts, and the transaction runs again once it is free.
    aggregate: (scope, id) => lockAggregate(scope, id),
    createAggregate: async (input, now) => {
      const digest = submissionDigest(input);
      const existing = await aggregates.findOne({ scope: input.scope, idempotencyKey: input.idempotencyKey }, { ...noId, session });
      if (existing) {
        if (existing.submissionDigest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
        return { row: (await lockAggregate(existing.scope, existing.id))!, created: false };
      }
      if (await aggregates.findOne({ scope: input.scope, id: input.id }, { ...noId, session })) throw new StorageError('CONFLICT', 'A record with this ID already exists in this scope under another idempotency key; use a different ID.');
      const document: AggregateDocument = { scope: input.scope, id: input.id, idempotencyKey: input.idempotencyKey, definitionHash: input.definitionHash,
        submissionDigest: digest, version: 1, eventSequence: input.events.length, state: JSON.stringify(input.state) };
      await aggregates.insertOne({ ...document }, { session });
      await append(input.scope, input.id, 0, input.events, now);
      return { row: row(document), created: true };
    },
    writeAggregate: async (current, state, input, now) => {
      const version = nextCounter(counter(current.version), 1); const sequence = counter(current.event_sequence);
      const next = { state: JSON.stringify(storedObject(state)), version, eventSequence: nextCounter(sequence, input.length) };
      // The record is locked: the new row is known without reading back its (up to megabytes of) state.
      const updated = await aggregates.updateOne({ scope: current.scope, id: current.id }, { $set: next }, { session });
      if (updated.matchedCount !== 1) throw new StorageError('STORAGE_UNAVAILABLE', 'Locked aggregate disappeared.');
      await append(current.scope, current.id, sequence, input, now);
      return { ...current, state: next.state, version: next.version, event_sequence: next.eventSequence };
    },
    redefine: async (scope, id, definitionHash, resourceHash) => {
      await aggregates.updateOne({ scope, id }, { $set: { definitionHash } }, { session });
      await owners.updateOne({ scope, aggregate_id: id }, { $set: { definition_hash: definitionHash, resource_hash: resourceHash } }, { session });
    },
    owner: async (scope, id) => await owners.findOne({ scope, aggregate_id: id }, { ...noId, session }) ?? undefined,
    ownerIdentity: async (scope, id) => await owners.findOne({ scope, aggregate_id: id },
      { projection: { _id: 0, scope: 1, aggregate_id: 1, profile: 1, definition_hash: 1, policy_hash: 1 }, session }) ?? undefined,
    insertOwner: async owner => { await owners.insertOne({ ...owner }, { session }); },
    updateOwner: async (scope, id, aggregateVersion, data) => {
      await owners.updateOne({ scope, aggregate_id: id }, { $set: { aggregate_version: aggregateVersion, data } }, { session });
    },
    lockRunJobs: async (scope, runId) => {
      const ids = (await jobs.find({ scope, run_id: runId }, { projection: { _id: 0, job_id: 1 }, session }).sort({ job_id: 1 }).toArray()).map(job => job['job_id'] as string);
      for (const jobId of ids) await touch(jobs, { scope, job_id: jobId }, session);
      // A control command may release several jobs' holds: take those documents in one global key order.
      const held = ids.length === 0 ? [] : await resources.find({ scope, job_id: { $in: ids } }, { projection: { _id: 0, resource_key: 1 }, session }).sort({ resource_key: 1 }).toArray();
      for (const resource of held) await touch(resources, { scope, resource_key: resource['resource_key'] }, session);
      return ids;
    },
    runHasJobs: async (scope, runId) => (await jobs.findOne({ scope, run_id: runId }, { projection: { _id: 0, job_id: 1 }, session })) !== null,
    links: async (scope, id) => (await links.find({ scope, aggregate_id: id }, { projection: { _id: 0, node_id: 1, job_id: 1 }, session }).sort({ job_id: 1 }).toArray()),
    insertLink: async (scope, id, nodeId, jobId) => { await links.insertOne({ scope, aggregate_id: id, node_id: nodeId, job_id: jobId }, { session }); },
    waitTargets: async (scope, id) => waits.find({ scope, aggregate_id: id }, { ...noId, session }).limit(129).toArray(),
    deleteWaitTargets: async (scope, id) => { await waits.deleteMany({ scope, aggregate_id: id }, { session }); },
    insertWaitTarget: async target => { await waits.insertOne({ ...target }, { session }); },
    workflowWaitsOn: async (scope, runId) => (await waits.findOne({ scope, run_id: runId }, { ...noId, session })) !== null,
    executionWaitTargets: async (scope, runId) => (await executionWaits.findOne({ scope, run_id: runId }, { projection: { _id: 1 }, session })) !== null,
    completion: async (scope, runId) => await completions.findOne({ scope, run_id: runId }, { ...noId, session }) ?? undefined,
    insertCompletion: async completion => { await completions.insertOne({ ...completion }, { session }); },
    discoverRuns: async (scope, policyHash, afterId, limit) => (await owners.find({ scope, policy_hash: policyHash, profile: 2, aggregate_id: { $gt: afterId } },
      { projection: { _id: 0, aggregate_id: 1 }, session }).sort({ aggregate_id: 1 }).limit(limit).toArray()).map(owner => owner.aggregate_id),
  };
}
