import type { CheckpointRow, ConversationTransaction, ThreadEntryRow, ThreadRow } from '../conversation-persistence.js';
import { above, key } from './keys.js';
import { at, json, sort } from './layout.js';
import type { DocumentSession } from './session.js';

// Layout:
//   thread (scope, id):        `r` the thread row, `e`+sequence its entries
//   threads (scope):           `u`+updatedAt+id, one per active or archived thread, for listing newest first
//   thread-idle (shard):       `u`+hour+scope+id, for retention; the hour moves rarely, so appends seldom touch it
//   checkpoint (runId):        `r` the row, `p`+part the body's parts
//   checkpoint-due (shard):    `d`+expiresAt+runId, one per checkpoint, including claimed rows
// The two global indexes are spread over 16 shards, so no single partition takes every write.
const SHARDS = 16;
const HOUR = 3_600_000;
/** Most entries a document transaction deletes, so a commit stays inside a 100-action transaction. */
const DELETE_BATCH = 64;
const listable = (status: string) => status === 'active' || status === 'archived';
function shard(...parts: string[]): number {
  let hash = 2_166_136_261;
  for (const char of parts.join('\u0000')) hash = Math.imul(hash ^ char.codePointAt(0)!, 16_777_619);
  return (hash >>> 0) % SHARDS;
}
const place = {
  thread: (scope: string, id: string) => key('thread', scope, id),
  recent: (scope: string) => key('threads', scope),
  idle: (scope: string, id: string) => key('thread-idle', shard(scope, id)),
  checkpoint: (runId: string) => key('checkpoint', runId),
  due: (runId: string) => key('checkpoint-due', shard(runId)),
};
const recentKey = (row: ThreadRow) => key('u', Number(row.updated_at_ms), row.id);
const idleKey = (row: ThreadRow) => key('u', Math.floor(Number(row.updated_at_ms) / HOUR), row.scope, row.id);
const dueKey = (row: CheckpointRow) => key('d', Number(row.expires_at_ms), row.run_id);

/** Threads and run checkpoints as documents, inside one optimistic transaction. */
export function documentConversationRows(session: DocumentSession): ConversationTransaction {
  /** Keeps a thread's listing and retention index entries in step with its row. */
  const index = async (row: ThreadRow | undefined, previous: ThreadRow | undefined) => {
    if (previous && listable(previous.status) && (!row || !listable(row.status) || recentKey(row) !== recentKey(previous))) {
      await session.delete(place.recent(previous.scope), recentKey(previous));
    }
    if (row && listable(row.status) && (!previous || !listable(previous.status) || recentKey(row) !== recentKey(previous))) {
      session.insert(place.recent(row.scope), recentKey(row), JSON.stringify({ id: row.id }));
    }
    if (previous && listable(previous.status) && (!row || !listable(row.status) || idleKey(row) !== idleKey(previous))) {
      await session.delete(place.idle(previous.scope, previous.id), idleKey(previous));
    }
    if (row && listable(row.status) && (!previous || !listable(previous.status) || idleKey(row) !== idleKey(previous))) {
      session.insert(place.idle(row.scope, row.id), idleKey(row), JSON.stringify({ scope: row.scope, id: row.id }));
    }
  };
  const dueIndex = async (row: CheckpointRow | undefined, previous: CheckpointRow | undefined) => {
    if (previous && (!row || dueKey(row) !== dueKey(previous))) await session.delete(place.due(previous.run_id), dueKey(previous));
    if (row && (!previous || dueKey(row) !== dueKey(previous))) session.insert(place.due(row.run_id), dueKey(row), JSON.stringify({ runId: row.run_id }));
  };
  return {
    clock: () => session.clock(),
    lockThread: async (scope, id) => { await session.hold(at.lock('thread', scope, id), sort.lock); },
    thread: async (scope, id) => json<ThreadRow>(await session.get(place.thread(scope, id), sort.record, true)),
    insertThread: async row => { session.insert(place.thread(row.scope, row.id), sort.record, JSON.stringify(row)); await index(row, undefined); },
    updateThread: async (row, previous) => { await session.put(place.thread(row.scope, row.id), sort.record, JSON.stringify(row)); await index(row, previous); },
    listThreads: async (scope, statuses, before, limit) => {
      // Newest first. `through` is inclusive, so a cursor's own entry is read and skipped; pages continue until `limit`
      // threads with these statuses are found or the index ends.
      let through = before ? key('u', before[0], before[1]) : undefined;
      const rows: ThreadRow[] = [];
      for (;;) {
        const page = await session.query(place.recent(scope), { prefix: key('u'), reverse: true, limit: limit + 1, ...(through ? { through } : {}) });
        const fresh = page.filter(item => item.sort !== through);
        for (const item of fresh) {
          const row = json<ThreadRow>(await session.get(place.thread(scope, json<{ id: string }>(item.body)!.id), sort.record));
          if (row && statuses.includes(row.status)) rows.push(row);
          if (rows.length === limit) return rows;
        }
        if (page.length < limit + 1 || !fresh.length) return rows;
        through = fresh[fresh.length - 1]!.sort;
      }
    },
    insertEntries: async (scope, threadId, rows) => {
      for (const row of rows) session.insert(place.thread(scope, threadId), key('e', Number(row.sequence)), JSON.stringify(row));
    },
    entries: async (scope, threadId, range, limit) => {
      if (range.before !== undefined) {
        const newest = await session.query(place.thread(scope, threadId), { prefix: key('e'), through: key('e', range.before - 1), reverse: true, limit });
        return newest.map(item => json<ThreadEntryRow>(item.body)!).reverse();
      }
      return (await session.query(place.thread(scope, threadId), { prefix: key('e'), after: key('e', range.after ?? 0), limit }))
        .map(item => json<ThreadEntryRow>(item.body)!);
    },
    deleteEntries: async (scope, threadId, limit) => {
      const oldest = await session.query(place.thread(scope, threadId), { prefix: key('e'), limit: Math.min(limit, DELETE_BATCH) });
      for (const item of oldest) await session.delete(place.thread(scope, threadId), item.sort);
      return oldest.length;
    },
    idleThreads: async (idleBeforeMs, limit) => {
      // An index entry's hour is a lower bound of its thread's last update: read every hour up to the cutoff's, then let the
      // reducer re-check each thread's exact time.
      const through = above(key('u', Math.floor(idleBeforeMs / HOUR)));
      const found: { hour: string; scope: string; id: string }[] = [];
      for (let index = 0; index < SHARDS; index++) {
        const page = await session.query(key('thread-idle', index), { prefix: key('u'), through, limit });
        for (const item of page) found.push({ hour: item.sort, ...json<{ scope: string; id: string }>(item.body)! });
      }
      return found.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0)).slice(0, limit).map(({ scope, id }) => ({ scope, id }));
    },

    lockCheckpoint: async runId => { await session.hold(at.lock('checkpoint', runId), sort.lock); },
    checkpoint: async runId => json<CheckpointRow>(await session.get(place.checkpoint(runId), sort.record, true)),
    checkpointParts: async runId => (await session.query(place.checkpoint(runId), { prefix: key('p') })).map(item => json<{ data: string }>(item.body)!.data),
    insertCheckpoint: async (row, parts) => {
      session.insert(place.checkpoint(row.run_id), sort.record, JSON.stringify(row));
      parts.forEach((data, part) => session.insert(place.checkpoint(row.run_id), key('p', part), JSON.stringify({ data })));
      await dueIndex(row, undefined);
    },
    updateCheckpoint: async (row, parts, previous) => {
      await session.put(place.checkpoint(row.run_id), sort.record, JSON.stringify(row));
      if (parts) {
        for (const item of await session.query(place.checkpoint(row.run_id), { prefix: key('p') })) await session.delete(place.checkpoint(row.run_id), item.sort);
        for (const [part, data] of parts.entries()) await session.put(place.checkpoint(row.run_id), key('p', part), JSON.stringify({ data }));
      }
      await dueIndex(row, previous);
    },
    deleteCheckpoint: async row => {
      for (const item of await session.query(place.checkpoint(row.run_id), { prefix: key('p') })) await session.delete(place.checkpoint(row.run_id), item.sort);
      await session.delete(place.checkpoint(row.run_id), sort.record);
      await dueIndex(undefined, row);
    },
    scanCheckpoints: async (after, limit) => {
      const found: { at: string; runId: string; expiresAtMs: number }[] = [];
      for (let index = 0; index < SHARDS; index++) {
        const page = await session.query(key('checkpoint-due', index), { prefix: key('d'),
          ...(after ? { after: key('d', after.expiresAtMs, after.runId) } : {}), limit });
        for (const item of page) {
          const runId = json<{ runId: string }>(item.body)!.runId;
          const row = json<CheckpointRow>(await session.get(place.checkpoint(runId), sort.record));
          if (row) found.push({ at: item.sort, runId, expiresAtMs: Number(row.expires_at_ms) });
        }
      }
      return found.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).slice(0, limit).map(({ runId, expiresAtMs }) => ({ runId, expiresAtMs }));
    },
    dueCheckpoints: async (expiresBeforeMs, limit) => {
      if (expiresBeforeMs <= 0) return [];
      // Strictly before `expiresBeforeMs`: every key under the last millisecond before it.
      const through = above(key('d', expiresBeforeMs - 1));
      const found: { at: string; runId: string }[] = [];
      for (let index = 0; index < SHARDS; index++) {
        let after: string | undefined; let waiting = 0;
        // Claimed rows stay discoverable for host diagnostics. They must not hide later waiting rows from due().
        for (;;) {
          const page = await session.query(key('checkpoint-due', index), { prefix: key('d'), through, limit, ...(after ? { after } : {}) });
          for (const item of page) {
            const runId = json<{ runId: string }>(item.body)!.runId;
            const row = json<CheckpointRow>(await session.get(place.checkpoint(runId), sort.record));
            if (row?.status === 'waiting') { found.push({ at: item.sort, runId }); waiting++; }
          }
          if (waiting >= limit || page.length < limit) break;
          after = page[page.length - 1]!.sort;
        }
      }
      return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, limit).map(item => item.runId);
    },
  };
}
