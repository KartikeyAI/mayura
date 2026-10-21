import type { ClientSession, Collection, Db } from 'mongodb';
import type { CheckpointRow, ConversationPersistence, ConversationTransaction, ThreadEntryRow, ThreadRow } from 'mayura/storage-sql/host';
import type { Transaction } from './memory.js';
import { serverClockOffset } from './scheduler.js';

interface ThreadDocument {
  scope: string; id: string; version: number; status: string; agentId: string | null; title: string | null; metadata: string;
  createdAtMs: number; updatedAtMs: number; entryCount: number; lastSequence: number;
  leaseRunId: string | null; leaseHolderId: string | null; leaseExpiresAtMs: number | null;
}
interface EntryDocument { scope: string; threadId: string; sequence: number; runId: string; kind: string; data: string; createdAtMs: number }
interface CheckpointDocument {
  runId: string; scope: string; version: number; status: string; holderId: string | null; leaseExpiresAtMs: number | null;
  createdAtMs: number; updatedAtMs: number; expiresAtMs: number; parts: number;
}
interface PartDocument { runId: string; part: number; data: string }

const noId = { projection: { _id: 0 } } as const;
const collections = (db: Db) => ({
  threads: db.collection('mayura_threads') as Collection<ThreadDocument>,
  entries: db.collection('mayura_thread_entries') as Collection<EntryDocument>,
  checkpoints: db.collection('mayura_run_checkpoints') as Collection<CheckpointDocument>,
  parts: db.collection('mayura_run_checkpoint_parts') as Collection<PartDocument>,
  locks: db.collection('mayura_locks') as Collection<{ _id: string; writes: number }>,
});
const threadRow = (item: ThreadDocument): ThreadRow => ({
  scope: item.scope, id: item.id, version: item.version, status: item.status, agent_id: item.agentId, title: item.title, metadata: item.metadata,
  created_at_ms: item.createdAtMs, updated_at_ms: item.updatedAtMs, entry_count: item.entryCount, last_sequence: item.lastSequence,
  lease_run_id: item.leaseRunId, lease_holder_id: item.leaseHolderId, lease_expires_at_ms: item.leaseExpiresAtMs,
});
const threadDocument = (row: ThreadRow): ThreadDocument => ({
  scope: row.scope, id: row.id, version: Number(row.version), status: row.status, agentId: row.agent_id, title: row.title, metadata: row.metadata,
  createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms), entryCount: Number(row.entry_count), lastSequence: Number(row.last_sequence),
  leaseRunId: row.lease_run_id, leaseHolderId: row.lease_holder_id, leaseExpiresAtMs: row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms),
});
const entryRow = (item: EntryDocument): ThreadEntryRow => ({ sequence: item.sequence, run_id: item.runId, kind: item.kind, data: item.data, created_at_ms: item.createdAtMs });
const checkpointRow = (item: CheckpointDocument): CheckpointRow => ({
  run_id: item.runId, scope: item.scope, version: item.version, status: item.status, holder_id: item.holderId, lease_expires_at_ms: item.leaseExpiresAtMs,
  created_at_ms: item.createdAtMs, updated_at_ms: item.updatedAtMs, expires_at_ms: item.expiresAtMs, parts: item.parts,
});
const checkpointDocument = (row: CheckpointRow): CheckpointDocument => ({
  runId: row.run_id, scope: row.scope, version: Number(row.version), status: row.status, holderId: row.holder_id,
  leaseExpiresAtMs: row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms),
  createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms), expiresAtMs: Number(row.expires_at_ms), parts: Number(row.parts),
});

/** Threads and run checkpoints in MongoDB, in one multi-document transaction per call. Documents name fields in camelCase. */
export function mongoConversationPersistence(db: Db, transaction: Transaction): ConversationPersistence {
  return {
    initialize: async () => {
      const { threads, entries, checkpoints, parts } = collections(db);
      await threads.createIndexes([
        { key: { scope: 1, id: 1 }, name: 'mayura_threads_id', unique: true },
        { key: { scope: 1, updatedAtMs: -1, id: -1 }, name: 'mayura_threads_recent' },
        { key: { status: 1, updatedAtMs: 1 }, name: 'mayura_threads_idle' },
      ]);
      await entries.createIndexes([{ key: { scope: 1, threadId: 1, sequence: 1 }, name: 'mayura_thread_entries_sequence', unique: true }]);
      await checkpoints.createIndexes([
        { key: { runId: 1 }, name: 'mayura_run_checkpoints_id', unique: true },
        { key: { status: 1, expiresAtMs: 1 }, name: 'mayura_run_checkpoints_due' },
        { key: { expiresAtMs: 1, runId: 1 }, name: 'mayura_run_checkpoints_scan', collation: { locale: 'simple' } },
      ]);
      await parts.createIndexes([{ key: { runId: 1, part: 1 }, name: 'mayura_run_checkpoint_parts_part', unique: true }]);
    },
    transaction: async body => { const skew = await serverClockOffset(db); return transaction(session => body(mongoConversationRows(db, session, skew))); },
  };
}

export function mongoConversationRows(db: Db, session: ClientSession, skew: number): ConversationTransaction {
  const { threads, entries, checkpoints, parts, locks } = collections(db);
  const lock = async (...key: string[]) => { await locks.updateOne({ _id: JSON.stringify(key) }, { $inc: { writes: 1 } }, { upsert: true, session }); };
  return {
    clock: async () => Date.now() + skew,
    lockThread: (scope, id) => lock('mayura:thread:v1', scope, id),
    thread: async (scope, id) => { const found = await threads.findOne({ scope, id }, { ...noId, session }); return found ? threadRow(found) : undefined; },
    insertThread: async row => { await threads.insertOne(threadDocument(row), { session }); },
    updateThread: async row => { await threads.replaceOne({ scope: row.scope, id: row.id }, threadDocument(row), { session }); },
    listThreads: async (scope, statuses, before, limit) => {
      const page = before ? { $or: [{ updatedAtMs: { $lt: before[0] } }, { updatedAtMs: before[0], id: { $lt: before[1] } }] } : {};
      return (await threads.find({ scope, status: { $in: [...statuses] }, ...page }, { ...noId, session }).sort({ updatedAtMs: -1, id: -1 }).limit(limit).toArray()).map(threadRow);
    },
    insertEntries: async (scope, threadId, rows) => {
      if (!rows.length) return;
      await entries.insertMany(rows.map(row => ({ scope, threadId, sequence: Number(row.sequence), runId: row.run_id, kind: row.kind, data: row.data, createdAtMs: Number(row.created_at_ms) })),
        { session, ordered: true });
    },
    entries: async (scope, threadId, range, limit) => {
      if (range.before !== undefined) {
        const newest = await entries.find({ scope, threadId, sequence: { $lt: range.before } }, { ...noId, session }).sort({ sequence: -1 }).limit(limit).toArray();
        return newest.reverse().map(entryRow);
      }
      return (await entries.find({ scope, threadId, sequence: { $gt: range.after ?? 0 } }, { ...noId, session }).sort({ sequence: 1 }).limit(limit).toArray()).map(entryRow);
    },
    deleteEntries: async (scope, threadId, limit) => {
      const oldest = await entries.find({ scope, threadId }, { projection: { _id: 0, sequence: 1 }, session }).sort({ sequence: 1 }).limit(limit).toArray();
      if (!oldest.length) return 0;
      await entries.deleteMany({ scope, threadId, sequence: { $lte: oldest[oldest.length - 1]!.sequence } }, { session });
      return oldest.length;
    },
    idleThreads: async (idleBeforeMs, limit) => (await threads.find({ status: { $in: ['active', 'archived'] }, updatedAtMs: { $lt: idleBeforeMs } },
      { projection: { _id: 0, scope: 1, id: 1 }, session }).sort({ updatedAtMs: 1, scope: 1, id: 1 }).limit(limit).toArray()).map(item => ({ scope: item.scope, id: item.id })),

    lockCheckpoint: runId => lock('mayura:run-checkpoint:v1', runId),
    checkpoint: async runId => { const found = await checkpoints.findOne({ runId }, { ...noId, session }); return found ? checkpointRow(found) : undefined; },
    checkpointParts: async runId => (await parts.find({ runId }, { ...noId, session }).sort({ part: 1 }).toArray()).map(item => item.data),
    insertCheckpoint: async (row, data) => {
      await checkpoints.insertOne(checkpointDocument(row), { session });
      if (data.length) await parts.insertMany(data.map((text, part) => ({ runId: row.run_id, part, data: text })), { session, ordered: true });
    },
    updateCheckpoint: async (row, data) => {
      await checkpoints.replaceOne({ runId: row.run_id }, checkpointDocument(row), { session });
      if (!data) return;
      await parts.deleteMany({ runId: row.run_id }, { session });
      if (data.length) await parts.insertMany(data.map((text, part) => ({ runId: row.run_id, part, data: text })), { session, ordered: true });
    },
    deleteCheckpoint: async row => {
      await parts.deleteMany({ runId: row.run_id }, { session });
      await checkpoints.deleteOne({ runId: row.run_id }, { session });
    },
    scanCheckpoints: async (after, limit) => (await checkpoints.find(after ? { $or: [
      { expiresAtMs: { $gt: after.expiresAtMs } }, { expiresAtMs: after.expiresAtMs, runId: { $gt: after.runId } },
    ] } : {}, { projection: { _id: 0, runId: 1, expiresAtMs: 1 }, collation: { locale: 'simple' }, session }).sort({ expiresAtMs: 1, runId: 1 }).limit(limit).toArray())
      .map(item => ({ runId: item.runId, expiresAtMs: item.expiresAtMs })),
    dueCheckpoints: async (expiresBeforeMs, limit) => (await checkpoints.find({ status: 'waiting', expiresAtMs: { $lt: expiresBeforeMs } },
      { projection: { _id: 0, runId: 1 }, session }).sort({ expiresAtMs: 1, runId: 1 }).limit(limit).toArray()).map(item => item.runId),
  };
}
