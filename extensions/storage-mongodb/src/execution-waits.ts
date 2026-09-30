import type { ClientSession, Collection, Db, Document } from 'mongodb';
import type {
  CompletionRow, ExecutionStreamRow, ExecutionWaitEventRow, ExecutionWaitPersistence, ExecutionWaitRow, ExecutionWaitTargetRow, ExecutionWaitTransaction,
} from 'mayura/storage-sql/host';
import type { Transaction } from './memory.js';
import { serverClockOffset, touch } from './scheduler.js';

const noId = { projection: { _id: 0, mayuraLocks: 0 } } as const;

/** Execution wait streams in MongoDB: each stream, its waits and their targets, and its bounded journal. */
export function mongoExecutionWaitPersistence(db: Db, transaction: Transaction): ExecutionWaitPersistence {
  const streams: Collection<ExecutionStreamRow> = db.collection('mayura_execution_streams');
  const waits: Collection<ExecutionWaitRow> = db.collection('mayura_execution_waits');
  const targets: Collection<ExecutionWaitTargetRow> = db.collection('mayura_execution_wait_targets');
  const events: Collection<ExecutionWaitEventRow & { scope: string; stream_id: string }> = db.collection('mayura_execution_wait_events');
  return {
    initialize: async () => {
      await streams.createIndexes([{ key: { scope: 1, stream_id: 1 }, name: 'mayura_execution_streams_id', unique: true }]);
      await waits.createIndexes([{ key: { scope: 1, stream_id: 1, wait_id: 1 }, name: 'mayura_execution_waits_id', unique: true },
        { key: { scope: 1, stream_id: 1, registration_sequence: 1 }, name: 'mayura_execution_waits_registration', unique: true },
        { key: { scope: 1, stream_id: 1, status: 1, registration_sequence: 1 }, name: 'mayura_execution_waits_ready' }]);
      await targets.createIndexes([{ key: { scope: 1, stream_id: 1, wait_id: 1, ordinal: 1 }, name: 'mayura_execution_wait_targets_id', unique: true },
        { key: { scope: 1, stream_id: 1, wait_id: 1, run_id: 1 }, name: 'mayura_execution_wait_targets_run', unique: true },
        { key: { scope: 1, run_id: 1 }, name: 'mayura_execution_wait_targets_target' }]);
      await events.createIndexes([{ key: { scope: 1, stream_id: 1, sequence: 1 }, name: 'mayura_execution_wait_events_sequence', unique: true }]);
    },
    transaction: async body => { const skew = await serverClockOffset(db); return transaction(session => body(mongoExecutionWaitRows(db, session, skew))); },
  };
}

function mongoExecutionWaitRows(db: Db, session: ClientSession, skew: number): ExecutionWaitTransaction {
  const streams: Collection<ExecutionStreamRow> = db.collection('mayura_execution_streams');
  const waits: Collection<ExecutionWaitRow> = db.collection('mayura_execution_waits');
  const targets: Collection<ExecutionWaitTargetRow> = db.collection('mayura_execution_wait_targets');
  const events: Collection<ExecutionWaitEventRow & { scope: string; stream_id: string }> = db.collection('mayura_execution_wait_events');
  const completions: Collection<CompletionRow> = db.collection('mayura_execution_completions');
  const locks: Collection<{ _id: string; writes: number }> = db.collection('mayura_locks');
  return {
    clock: async () => Date.now() + skew,
    lockStreamIdentity: async (scope, streamId) => {
      await locks.updateOne({ _id: JSON.stringify(['mayura:execution-stream:v1', scope, streamId]) }, { $inc: { writes: 1 } }, { upsert: true, session });
    },
    streamExists: async (scope, streamId) => (await streams.findOne({ scope, stream_id: streamId }, { projection: { _id: 1 }, session })) !== null,
    stream: async (scope, streamId) => {
      if (!await touch(streams as unknown as Collection<Document>, { scope, stream_id: streamId }, session)) return undefined;
      return await streams.findOne({ scope, stream_id: streamId }, { ...noId, session }) ?? undefined;
    },
    insertStream: async row => { await streams.insertOne({ scope: row.scope, stream_id: row.stream_id, policy_hash: row.policy_hash, format: 1, wait_count: 0, event_sequence: 0 }, { session }); },
    setWaitCount: async (scope, streamId, count) => { await streams.updateOne({ scope, stream_id: streamId }, { $set: { wait_count: count } }, { session }); },
    setEventSequence: async (scope, streamId, sequence) => { await streams.updateOne({ scope, stream_id: streamId }, { $set: { event_sequence: sequence } }, { session }); },
    waits: async (scope, streamId) => waits.find({ scope, stream_id: streamId }, { ...noId, session }).limit(129).toArray(),
    events: async (scope, streamId) => events.find({ scope, stream_id: streamId }, { projection: { _id: 0, sequence: 1, type: 1, data: 1, created_at: 1 }, session })
      .sort({ sequence: 1 }).limit(258).toArray(),
    appendEvent: async (scope, streamId, event) => { await events.insertOne({ scope, stream_id: streamId, ...event }, { session }); },
    wait: async (scope, streamId, waitId) => await waits.findOne({ scope, stream_id: streamId, wait_id: waitId }, { ...noId, session }) ?? undefined,
    insertWait: async row => { await waits.insertOne({ ...row, version: 1 }, { session }); },
    updateWait: async (scope, streamId, waitId, version, status, data) => {
      await waits.updateOne({ scope, stream_id: streamId, wait_id: waitId }, { $set: { version, status, data } }, { session });
    },
    targets: async (scope, streamId, waitId) => targets.find({ scope, stream_id: streamId, wait_id: waitId }, { ...noId, session }).sort({ ordinal: 1 }).limit(33).toArray(),
    insertTarget: async row => { await targets.insertOne({ ...row }, { session }); },
    readyWaits: async (scope, streamId, limit) => {
      const ready: string[] = [];
      // Waiting waits in registration order; a stream holds at most 128, each with at most 32 targets.
      const candidates = await waits.find({ scope, stream_id: streamId, status: 'waiting' }, { projection: { _id: 0, wait_id: 1 }, session }).sort({ registration_sequence: 1 }).toArray();
      for (const candidate of candidates) {
        if (ready.length >= limit) break;
        const edges = await targets.find({ scope, stream_id: streamId, wait_id: candidate.wait_id }, { ...noId, session }).toArray();
        let complete = edges.length > 0;
        for (const edge of edges) {
          if (!complete) break;
          complete = (await completions.findOne({ scope, run_id: edge.run_id, definition_hash: edge.definition_hash, policy_hash: edge.policy_hash }, { projection: { _id: 1 }, session })) !== null;
        }
        if (complete) ready.push(candidate.wait_id);
      }
      return ready;
    },
    completion: async (scope, runId) => await completions.findOne({ scope, run_id: runId }, { ...noId, session }) ?? undefined,
    insertCompletion: async row => { await completions.insertOne({ ...row }, { session }); },
  };
}
