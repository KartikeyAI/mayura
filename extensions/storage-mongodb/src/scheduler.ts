import type { ClientSession, Collection, Db, Document } from 'mongodb';
import type { SchedulerCandidateFilter, SchedulerEventRow, SchedulerHeldRow, SchedulerJobRow, SchedulerPersistence, SchedulerTransaction } from 'mayura/storage-sql/host';
import type { Transaction } from './memory.js';

interface RequestDocument { scope: string; job_id: string; resource_key: string }
interface HeadDocument { scope: string; run_id: string; sequence: number }
interface EventDocument extends SchedulerEventRow { scope: string; run_id: string }
interface OwnerDocument { scope: string; aggregate_id: string }
interface LockDocument { _id: string; writes: number }

const noId = { projection: { _id: 0 } } as const;
const busy = ['leased', 'started', 'outcome_unknown'];

/**
 * The scheduler's rows in MongoDB, for the shared scheduler state machine. Transactions read a snapshot, and one that
 * writes a document another committed since conflicts and is run again by the driver, so two claims of one job never
 * both commit. Locking a row also writes its document at once, so a locked read that leads to no write of that row
 * still excludes other writers, and a conflict surfaces before any work. MongoDB has no SKIP LOCKED: a claim that meets
 * a locked job runs again and then finds it taken. Time is the server's, so every worker leases against one clock.
 */
export function mongoSchedulerPersistence(db: Db, transaction: Transaction): SchedulerPersistence {
  const jobs: Collection<SchedulerJobRow> = db.collection('mayura_scheduler_jobs');
  const requests: Collection<RequestDocument> = db.collection('mayura_scheduler_requests');
  const resources: Collection<SchedulerHeldRow & { scope: string; job_id: string }> = db.collection('mayura_scheduler_resources');
  const heads: Collection<HeadDocument> = db.collection('mayura_scheduler_heads');
  const events: Collection<EventDocument> = db.collection('mayura_scheduler_events');
  return {
    initialize: async () => {
      await jobs.createIndexes([{ key: { scope: 1, job_id: 1 }, name: 'mayura_scheduler_jobs_id', unique: true },
        { key: { scope: 1, reservation_key: 1 }, name: 'mayura_scheduler_jobs_reservation', unique: true },
        { key: { scope: 1, invocation_id: 1 }, name: 'mayura_scheduler_jobs_invocation', unique: true },
        { key: { scope: 1, state: 1, due_at: 1, job_id: 1 }, name: 'mayura_scheduler_ready' }, { key: { scope: 1, run_id: 1 }, name: 'mayura_scheduler_run' }]);
      await requests.createIndexes([{ key: { scope: 1, job_id: 1, resource_key: 1 }, name: 'mayura_scheduler_requests_id', unique: true },
        { key: { scope: 1, resource_key: 1, job_id: 1 }, name: 'mayura_scheduler_requested_resource' }]);
      await resources.createIndexes([{ key: { scope: 1, resource_key: 1 }, name: 'mayura_scheduler_resources_id', unique: true }, { key: { scope: 1, job_id: 1 }, name: 'mayura_scheduler_held_job' }]);
      await heads.createIndexes([{ key: { scope: 1, run_id: 1 }, name: 'mayura_scheduler_heads_id', unique: true }]);
      await events.createIndexes([{ key: { scope: 1, run_id: 1, sequence: 1 }, name: 'mayura_scheduler_events_sequence', unique: true }]);
    },
    transaction: async body => { const skew = await serverClockOffset(db); return transaction(session => body(mongoSchedulerRows(db, session, skew))); },
  };
}

/**
 * The server's clock, as an offset from this process's; a transaction reads it once, before it starts. The offset
 * changes only as the two clocks drift, so a measurement is reused for a second rather than costing every transaction
 * a round trip. Leases and deadlines are enforced against stored clock floors, which never move backwards.
 */
const offsets = new WeakMap<Db, { value: number; measuredAt: number }>();
export async function serverClockOffset(db: Db): Promise<number> {
  const cached = offsets.get(db); const now = Date.now();
  if (cached && now >= cached.measuredAt && now - cached.measuredAt < 1_000) return cached.value;
  const before = Date.now(); const hello = await db.admin().command({ hello: 1 }); const after = Date.now();
  const server = hello['localTime'] instanceof Date ? hello['localTime'].getTime() : after;
  const value = server - Math.round((before + after) / 2);
  offsets.set(db, { value, measuredAt: after }); return value;
}

/** Writes the document so another transaction that writes it conflicts; the value itself is never read. True when it exists. */
export async function touch(collection: Collection<Document>, filter: Document, session: ClientSession): Promise<boolean> {
  return (await collection.updateOne(filter, { $inc: { mayuraLocks: 1 } }, { session })).matchedCount === 1;
}

/** The scheduler's reads and writes in one transaction, on the server's clock (`skew` from `serverClockOffset`). */
export function mongoSchedulerRows(db: Db, session: ClientSession, skew: number): SchedulerTransaction {
  const jobs: Collection<SchedulerJobRow> = db.collection('mayura_scheduler_jobs');
  const requests: Collection<RequestDocument> = db.collection('mayura_scheduler_requests');
  const resources: Collection<SchedulerHeldRow & { scope: string; job_id: string }> = db.collection('mayura_scheduler_resources');
  const heads: Collection<HeadDocument> = db.collection('mayura_scheduler_heads');
  const events: Collection<EventDocument> = db.collection('mayura_scheduler_events');
  const owners: Collection<OwnerDocument> = db.collection('mayura_workflow_owners');
  const aggregates = db.collection('mayura_aggregates');
  const locks: Collection<LockDocument> = db.collection('mayura_locks');
  const lockRun = (scope: string, runId: string) => locks.updateOne({ _id: JSON.stringify(['mayura:workflow-run:v1', scope, runId]) }, { $inc: { writes: 1 } }, { upsert: true, session });
  const ownedRun = async (scope: string, runId: string) => (await owners.findOne({ scope, aggregate_id: runId }, { ...noId, session })) !== null;
  const requested = async (scope: string, jobId: string) => (await requests.find({ scope, job_id: jobId }, { ...noId, session }).sort({ resource_key: 1 }).toArray()).map(row => row.resource_key);
  const ownedElsewhere = async (scope: string, jobId: string): Promise<boolean> => {
    const keys = await requested(scope, jobId); if (keys.length === 0) return false;
    const others = [...new Set((await requests.find({ scope, resource_key: { $in: keys }, job_id: { $ne: jobId } }, { ...noId, session }).toArray()).map(row => row.job_id))];
    return others.length > 0 && (await jobs.findOne({ scope, job_id: { $in: others }, state: { $in: busy } }, { ...noId, session })) !== null;
  };
  const job = async (scope: string, jobId: string, lock: boolean): Promise<SchedulerJobRow | undefined> => {
    if (lock && !await touch(jobs as unknown as Collection<Document>, { scope, job_id: jobId }, session)) return undefined;
    return await jobs.findOne({ scope, job_id: jobId }, { projection: { _id: 0, mayuraLocks: 0 }, session }) ?? undefined;
  };
  /** Candidates in order, keeping those `keep` accepts, up to `limit`. */
  const select = async (filter: SchedulerCandidateFilter, query: Document, sort: Document, limit: number, keep: (row: SchedulerJobRow) => Promise<boolean>): Promise<string[]> => {
    const found: string[] = [];
    const cursor = jobs.find({ scope: filter.scope, ...query, ...(filter.runId === undefined ? {} : { run_id: filter.runId }), ...(filter.jobId === undefined ? {} : { job_id: filter.jobId }) },
      { projection: { _id: 0, job_id: 1, run_id: 1 }, session }).sort(sort);
    try {
      for (let row = await cursor.next(); row && found.length < limit; row = await cursor.next()) {
        // Outside a workflow, only jobs of runs no scheduled workflow writer owns.
        if (filter.runId === undefined && await ownedRun(filter.scope, row.run_id)) continue;
        if (await keep(row)) found.push(row.job_id);
      }
    } finally { await cursor.close(); }
    return found;
  };
  return {
    clock: async () => Date.now() + skew,
    lockRunIdentity: async (scope, runId) => { await lockRun(scope, runId); },
    lockAggregate: async (scope, runId) => { await touch(aggregates, { scope, id: runId }, session); },
    ownedRun,
    jobRunId: async key => (await jobs.findOne({ scope: key.scope, job_id: key.jobId }, { projection: { _id: 0, run_id: 1 }, session }))?.run_id,
    job: (key, lock) => job(key.scope, key.jobId, lock !== 'none'),
    jobByReservation: async (scope, reservationKey) => {
      const found = await jobs.findOne({ scope, reservation_key: reservationKey }, { projection: { _id: 0, job_id: 1 }, session });
      return found ? job(scope, found.job_id, true) : undefined;
    },
    requests: key => requested(key.scope, key.jobId),
    held: async (key, ordered) => {
      const cursor = resources.find({ scope: key.scope, job_id: key.jobId }, { projection: { _id: 0, resource_key: 1, fence: 1, disposition: 1 }, session });
      return (ordered ? cursor.sort({ resource_key: 1 }) : cursor).toArray();
    },
    insertJob: async row => {
      // Any identity already taken means no insert, as with the SQL tables' unique keys.
      if (await jobs.findOne({ scope: row.scope, $or: [{ job_id: row.job_id }, { reservation_key: row.reservation_key }, { invocation_id: row.invocation_id }] }, { ...noId, session })) return false;
      await jobs.insertOne({ ...row }, { session }); return true;
    },
    insertRequests: async (scope, jobId, keys) => { if (keys.length) await requests.insertMany(keys.map(resource_key => ({ scope, job_id: jobId, resource_key })), { session }); },
    updateJob: async row => { await jobs.updateOne({ scope: row.scope, job_id: row.job_id }, { $set: { state: row.state, lease_until: row.lease_until, revoked: row.revoked, version: row.version, data: row.data } }, { session }); },
    appendEvent: async (scope, runId, type, data, createdAt) => {
      const head = await heads.findOneAndUpdate({ scope, run_id: runId }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after', session });
      await events.insertOne({ scope, run_id: runId, sequence: head!.sequence, type, data, created_at: createdAt }, { session });
    },
    releaseResources: async (scope, jobId, fence, quarantine) => {
      if (quarantine) await resources.updateMany({ scope, job_id: jobId, fence }, { $set: { disposition: 'quarantined' } }, { session });
      else await resources.deleteMany({ scope, job_id: jobId, fence }, { session });
    },
    holdResource: async (scope, resourceKey, jobId, fence) => {
      if (await resources.findOne({ scope, resource_key: resourceKey }, { ...noId, session })) return false;
      await resources.insertOne({ scope, resource_key: resourceKey, job_id: jobId, fence, disposition: 'held' }, { session }); return true;
    },
    resourceOwnedElsewhere: ownedElsewhere,
    claimCandidates: filter => select(filter, { state: 'ready', due_at: { $lte: filter.now }, $or: [{ deadline_at: null }, { deadline_at: { $gt: filter.now } }] }, { due_at: 1, job_id: 1 }, 128,
      async row => {
        const keys = await requested(filter.scope, row.job_id);
        if (keys.length && await resources.findOne({ scope: filter.scope, resource_key: { $in: keys } }, { ...noId, session })) return false;
        return !await ownedElsewhere(filter.scope, row.job_id);
      }),
    recoverCandidates: filter => select(filter, { state: { $in: ['ready', 'leased', 'started'] }, $or: [{ revoked: 1 }, { lease_until: { $lte: filter.now } }, { deadline_at: { $lte: filter.now } }] },
      { job_id: 1 }, filter.limit, async () => true),
    events: async (scope, runId, after, limit) => events.find({ scope, run_id: runId, sequence: { $gt: after } }, { projection: { _id: 0, sequence: 1, type: 1, data: 1, created_at: 1 }, session })
      .sort({ sequence: 1 }).limit(limit).toArray(),
  };
}
