import { StorageError } from '../contracts.js';
import type { SchedulerHeldRow, SchedulerJobRow, SchedulerTransaction } from '../scheduler-persistence.js';
import { nextCounter } from '../validation.js';
import { compareKeys } from './keys.js';
import { at, json, kind, sort } from './layout.js';
import type { DocumentSession } from './session.js';

interface HeldDocument { resource_key: string; job_id: string; fence: number; disposition: string }
interface ReadyDocument { job_id: string; run_id: string; due_at: number; deadline_at: number | null }
interface LiveDocument { job_id: string; run_id: string; state: string; revoked: number; lease_until: number | null; deadline_at: number | null }
const busy = new Set(['leased', 'started', 'outcome_unknown']);
const liveStates = new Set(['ready', 'leased', 'started']);
function failure(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored scheduler state failed integrity validation.'); }

/** The scheduler's rows as documents in one optimistic transaction. */
export function documentSchedulerRows(session: DocumentSession): SchedulerTransaction & {
  /** The run a job belongs to, from its immutable index document. */
  runOf(scope: string, jobId: string): Promise<string | undefined>;
  /** Locks one scheduler job document. */
  lockJob(scope: string, jobId: string): Promise<boolean>;
  /** The resources a job holds or has quarantined (its index), for locking. */
  heldKeys(scope: string, runId: string, jobId: string): Promise<string[]>;
} {
  const runOf = async (scope: string, jobId: string) => json<{ run_id: string }>(await session.get(at.job(scope, jobId), sort.jobRun))?.run_id;
  const job = async (scope: string, jobId: string, lock: boolean): Promise<SchedulerJobRow | undefined> => {
    const runId = await runOf(scope, jobId); if (runId === undefined) return undefined;
    return json<SchedulerJobRow>(await session.get(at.runJobs(scope, runId), sort.job(jobId), lock));
  };
  const requested = async (scope: string, jobId: string): Promise<string[]> => {
    const runId = await runOf(scope, jobId); if (runId === undefined) return [];
    return json<{ keys: string[] }>(await session.get(at.runJobs(scope, runId), sort.requests(jobId)))?.keys ?? [];
  };
  const heldKeys = async (scope: string, runId: string, jobId: string) => json<{ keys: string[] }>(await session.get(at.runJobs(scope, runId), sort.holds(jobId)))?.keys ?? [];
  const setHeldKeys = async (scope: string, runId: string, jobId: string, keys: string[]) => {
    if (keys.length) await session.put(at.runJobs(scope, runId), sort.holds(jobId), JSON.stringify({ keys: [...new Set(keys)].sort(compareKeys) }));
    else if (await session.get(at.runJobs(scope, runId), sort.holds(jobId)) !== undefined) await session.delete(at.runJobs(scope, runId), sort.holds(jobId));
  };
  const ownedElsewhere = async (scope: string, jobId: string): Promise<boolean> => {
    for (const resourceKey of await requested(scope, jobId)) {
      for (const requester of await session.query(at.requesters(scope, resourceKey), { prefix: kind.requester })) {
        const other = json<{ job_id: string }>(requester.body)!.job_id; if (other === jobId) continue;
        const row = await job(scope, other, false); if (row && busy.has(row.state)) return true;
      }
    }
    return false;
  };
  const ownedRun = async (scope: string, runId: string) => await session.get(at.run(scope, runId), sort.owner) !== undefined;
  /** Writes a job row and the ready and live index documents it belongs in; every job write holds the run's guard. */
  const store = async (row: SchedulerJobRow, previous: SchedulerJobRow | undefined) => {
    const jobs = at.runJobs(row.scope, row.run_id);
    await session.hold(jobs, sort.guard);
    await session.put(jobs, sort.job(row.job_id), JSON.stringify(row));
    const dueAt = Number(row.due_at);
    if (previous?.state === 'ready' && row.state !== 'ready') await session.delete(at.ready(row.scope), sort.ready(Number(previous.due_at), row.job_id));
    if (row.state === 'ready' && previous?.state !== 'ready') await session.put(at.ready(row.scope), sort.ready(dueAt, row.job_id),
      JSON.stringify({ job_id: row.job_id, run_id: row.run_id, due_at: dueAt, deadline_at: row.deadline_at === null ? null : Number(row.deadline_at) } satisfies ReadyDocument));
    if (liveStates.has(row.state)) await session.put(at.live(row.scope), sort.live(row.job_id), JSON.stringify({ job_id: row.job_id, run_id: row.run_id, state: row.state,
      revoked: Number(row.revoked), lease_until: row.lease_until === null ? null : Number(row.lease_until), deadline_at: row.deadline_at === null ? null : Number(row.deadline_at) } satisfies LiveDocument));
    else if (previous && liveStates.has(previous.state)) await session.delete(at.live(row.scope), sort.live(row.job_id));
  };
  const resourcesFree = async (scope: string, jobId: string) => {
    const keys = await requested(scope, jobId);
    return (await session.getMany(keys.map(resourceKey => ({ partition: at.resource(scope, resourceKey), sort: sort.head })))).every(found => found === undefined);
  };

  return {
    runOf,
    lockJob: async (scope, jobId) => await job(scope, jobId, true) !== undefined,
    heldKeys,
    clock: () => session.clock(),
    lockRunIdentity: async (scope, runId) => { await session.hold(at.lock('run', scope, runId), sort.lock); },
    lockAggregate: async (scope, runId) => { await session.get(at.run(scope, runId), sort.record, true); },
    ownedRun,
    jobRunId: key => runOf(key.scope, key.jobId),
    job: (key, lock) => job(key.scope, key.jobId, lock !== 'none'),
    jobByReservation: async (scope, reservationKey) => {
      const found = json<{ job_id: string }>(await session.get(at.reservation(scope, reservationKey), sort.only));
      return found ? job(scope, found.job_id, true) : undefined;
    },
    requests: key => requested(key.scope, key.jobId),
    held: async (key, ordered) => {
      const runId = await runOf(key.scope, key.jobId); if (runId === undefined) return [];
      const keys = await heldKeys(key.scope, runId, key.jobId);
      const rows = (await session.getMany(keys.map(resourceKey => ({ partition: at.resource(key.scope, resourceKey), sort: sort.head }))))
        .map(text => json<HeldDocument>(text)).filter((row): row is HeldDocument => row !== undefined && row.job_id === key.jobId)
        .map((row): SchedulerHeldRow => ({ resource_key: row.resource_key, fence: row.fence, disposition: row.disposition }));
      return ordered ? rows.sort((a, b) => compareKeys(a.resource_key, b.resource_key)) : rows;
    },
    insertJob: async row => {
      // Any identity already taken means no insert, as with the SQL tables' unique keys. The inserts expect absence,
      // so a concurrent insert of the same identity makes this commit conflict and run again.
      const taken = await session.getMany([{ partition: at.job(row.scope, row.job_id), sort: sort.jobRun },
        { partition: at.reservation(row.scope, row.reservation_key), sort: sort.only }, { partition: at.invocation(row.scope, row.invocation_id), sort: sort.only }]);
      if (taken.some(found => found !== undefined)) return false;
      await session.put(at.job(row.scope, row.job_id), sort.jobRun, JSON.stringify({ run_id: row.run_id }));
      await session.put(at.reservation(row.scope, row.reservation_key), sort.only, JSON.stringify({ job_id: row.job_id }));
      await session.put(at.invocation(row.scope, row.invocation_id), sort.only, JSON.stringify({ job_id: row.job_id }));
      await store({ ...row }, undefined);
      return true;
    },
    insertRequests: async (scope, jobId, keys) => {
      if (!keys.length) return;
      const runId = await runOf(scope, jobId); if (runId === undefined) failure();
      const unique = [...new Set(keys)];
      if (unique.length !== keys.length) throw new StorageError('CONFLICT', 'A resource was requested twice.');
      await session.put(at.runJobs(scope, runId), sort.requests(jobId), JSON.stringify({ keys: [...unique].sort(compareKeys) }));
      for (const resourceKey of unique) session.insert(at.requesters(scope, resourceKey), sort.requester(jobId), JSON.stringify({ job_id: jobId }));
    },
    updateJob: async row => {
      const previous = json<SchedulerJobRow>(await session.get(at.runJobs(row.scope, row.run_id), sort.job(row.job_id)));
      if (!previous) failure();
      await store({ ...previous, state: row.state, lease_until: row.lease_until, revoked: row.revoked, version: row.version, data: row.data }, previous);
    },
    appendEvent: async (scope, runId, type, data, createdAt) => {
      const partition = at.schedulerEvents(scope, runId);
      const head = json<{ sequence: number }>(await session.get(partition, sort.head, true));
      const current = head?.sequence ?? 0; if (!Number.isSafeInteger(current) || current < 0) failure();
      const sequence = nextCounter(current, 1);
      await session.put(partition, sort.head, JSON.stringify({ sequence }));
      session.insert(partition, sort.event(sequence), JSON.stringify({ sequence, type, data, created_at: createdAt }));
    },
    releaseResources: async (scope, jobId, fence, quarantine) => {
      const runId = await runOf(scope, jobId); if (runId === undefined) return;
      const keys = await heldKeys(scope, runId, jobId); const kept: string[] = [];
      for (const resourceKey of keys) {
        const held = json<HeldDocument>(await session.get(at.resource(scope, resourceKey), sort.head));
        if (!held || held.job_id !== jobId || held.fence !== fence) { if (held?.job_id === jobId) kept.push(resourceKey); continue; }
        if (quarantine) { await session.put(at.resource(scope, resourceKey), sort.head, JSON.stringify({ ...held, disposition: 'quarantined' })); kept.push(resourceKey); }
        else await session.delete(at.resource(scope, resourceKey), sort.head);
      }
      await setHeldKeys(scope, runId, jobId, kept);
    },
    holdResource: async (scope, resourceKey, jobId, fence) => {
      if (await session.get(at.resource(scope, resourceKey), sort.head) !== undefined) return false;
      const runId = await runOf(scope, jobId); if (runId === undefined) failure();
      await session.put(at.resource(scope, resourceKey), sort.head, JSON.stringify({ resource_key: resourceKey, job_id: jobId, fence, disposition: 'held' } satisfies HeldDocument));
      await setHeldKeys(scope, runId, jobId, [...await heldKeys(scope, runId, jobId), resourceKey]);
      return true;
    },
    resourceOwnedElsewhere: ownedElsewhere,
    claimCandidates: async filter => {
      const found: string[] = [];
      const eligible = async (jobId: string, runId: string, dueAt: number, deadlineAt: number | null) => dueAt <= filter.now && (deadlineAt === null || deadlineAt > filter.now)
        && (filter.runId !== undefined || !await ownedRun(filter.scope, runId)) && await resourcesFree(filter.scope, jobId) && !await ownedElsewhere(filter.scope, jobId);
      if (filter.runId !== undefined) {
        const rows = (await session.query(at.runJobs(filter.scope, filter.runId), { prefix: kind.job })).map(item => json<SchedulerJobRow>(item.body)!)
          .filter(row => row.state === 'ready' && (filter.jobId === undefined || row.job_id === filter.jobId))
          .sort((a, b) => Number(a.due_at) - Number(b.due_at) || compareKeys(a.job_id, b.job_id));
        for (const row of rows) {
          if (found.length >= 128) break;
          if (await eligible(row.job_id, row.run_id, Number(row.due_at), row.deadline_at === null ? null : Number(row.deadline_at))) found.push(row.job_id);
        }
        return found;
      }
      // Ready jobs in due order, a page at a time, until 128 qualify or the rest are not yet due.
      let cursor: string | undefined;
      for (;;) {
        const page = await session.query(at.ready(filter.scope), { prefix: kind.ready, ...(cursor === undefined ? {} : { after: cursor }), limit: 256 });
        for (const item of page) {
          const ready = json<ReadyDocument>(item.body)!;
          if (ready.due_at > filter.now) return found;
          if (await eligible(ready.job_id, ready.run_id, ready.due_at, ready.deadline_at)) { found.push(ready.job_id); if (found.length >= 128) return found; }
        }
        if (page.length < 256) return found;
        cursor = page[page.length - 1]!.sort;
      }
    },
    recoverCandidates: async filter => {
      const due = (row: { revoked: number; lease_until: number | null; deadline_at: number | null; state: string }) => liveStates.has(row.state)
        && (Number(row.revoked) === 1 || (row.lease_until !== null && row.lease_until <= filter.now) || (row.deadline_at !== null && row.deadline_at <= filter.now));
      if (filter.runId !== undefined) {
        return (await session.query(at.runJobs(filter.scope, filter.runId), { prefix: kind.job })).map(item => json<SchedulerJobRow>(item.body)!)
          .map(row => ({ ...row, lease_until: row.lease_until === null ? null : Number(row.lease_until), deadline_at: row.deadline_at === null ? null : Number(row.deadline_at), revoked: Number(row.revoked) }))
          .filter(row => (filter.jobId === undefined || row.job_id === filter.jobId) && due(row)).map(row => row.job_id).sort(compareKeys).slice(0, filter.limit);
      }
      const found: string[] = []; const owned = new Map<string, boolean>();
      for (const item of await session.query(at.live(filter.scope), { prefix: kind.live })) {
        const live = json<LiveDocument>(item.body)!; if (!due(live)) continue;
        if (!owned.has(live.run_id)) owned.set(live.run_id, await ownedRun(filter.scope, live.run_id));
        if (owned.get(live.run_id)) continue;
        found.push(live.job_id); if (found.length >= filter.limit) break;
      }
      return found;
    },
    events: async (scope, runId, afterSequence, limit) => (await session.query(at.schedulerEvents(scope, runId), { prefix: kind.event, after: sort.event(afterSequence), limit }))
      .map(item => json<{ sequence: number; type: string; data: string; created_at: string }>(item.body)!),
  };
}
