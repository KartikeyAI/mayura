import { StorageError, type CreateRecord, type StoredEventInput, type StoredRecord } from '../contracts.js';
import type { AggregateRow } from '../aggregate-session.js';
import type { CompletionRow } from '../execution-completions.js';
import type { ScheduledTransaction, WorkflowOwnerRow, WorkflowWaitTargetRow } from '../scheduled-persistence.js';
import { identifier, nextCounter, storedObject, submissionDigest } from '../validation.js';
import { compareKeys, key, parts } from './keys.js';
import { at, json, kind, sort } from './layout.js';
import { documentSchedulerRows } from './scheduler-rows.js';
import type { DocumentSession } from './session.js';

function counter(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored aggregate counter is invalid.');
  return result;
}
/** Execution waits that target a run: `x`+stream+wait in the run's partition. */
export const executionWaiter = (streamId: string, waitId: string) => key('x', streamId, waitId);
const executionWaiters = key('x');

/** One stored event of a record. */
export interface RecordEvent { sequence: number; type: string; data: string; created_at: string }
/**
 * A record's events, numbered after `sequence`, at time `now`: all of one commit in one document, keyed by its first
 * sequence, so that a commit writes one item however many events it appends.
 */
export function appendRecordEvents(session: DocumentSession, scope: string, id: string, sequence: number, events: readonly StoredEventInput[], now: number): void {
  if (events.length === 0) return;
  const createdAt = new Date(now).toISOString();
  const batch: RecordEvent[] = events.map((event, index) => ({ sequence: nextCounter(sequence, index + 1), type: identifier(event.type, 'Event'), data: JSON.stringify(event.data), created_at: createdAt }));
  session.insert(at.run(scope, id), sort.event(batch[0]!.sequence), JSON.stringify({ events: batch }));
}
/** Up to `limit` of a record's events after `afterSequence`, in order. */
export async function recordEvents(session: DocumentSession, scope: string, id: string, afterSequence: number, limit: number): Promise<RecordEvent[]> {
  const partition = at.run(scope, id);
  // The batch that holds the next event starts at or before it.
  const [first] = await session.query(partition, { prefix: kind.event, through: sort.event(nextCounter(afterSequence, 1)), reverse: true, limit: 1 });
  const found: RecordEvent[] = []; let cursor: string | undefined;
  const take = (body: string) => { for (const event of json<{ events: RecordEvent[] }>(body)!.events) if (event.sequence > afterSequence && found.length < limit) found.push(event); };
  if (first) { take(first.body); cursor = first.sort; }
  while (found.length < limit) {
    const page = await session.query(partition, { prefix: kind.event, ...(cursor === undefined ? {} : { after: cursor }), limit: 16 });
    for (const item of page) take(item.body);
    if (page.length < 16) break;
    cursor = page[page.length - 1]!.sort;
  }
  return found;
}
/** Creates a record unless its idempotency key is taken; returns the existing record, locked, when it is. */
export async function createRecord(session: DocumentSession, input: CreateRecord, now: number): Promise<{ row: AggregateRow; created: boolean }> {
  const digest = submissionDigest(input);
  const existing = json<{ id: string }>(await session.get(at.idempotency(input.scope, input.idempotencyKey), sort.only));
  if (existing) {
    const row = json<AggregateRow>(await session.get(at.run(input.scope, existing.id), sort.record, true));
    if (!row || row.submission_digest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
    return { row, created: false };
  }
  if (await session.get(at.run(input.scope, input.id), sort.record) !== undefined) throw new StorageError('CONFLICT', 'A record with this ID already exists in this scope under another idempotency key; use a different ID.');
  const row: AggregateRow = { scope: input.scope, id: input.id, idempotency_key: input.idempotencyKey, definition_hash: input.definitionHash, submission_digest: digest,
    version: 1, event_sequence: input.events.length, state: JSON.stringify(input.state) };
  await session.put(at.run(input.scope, input.id), sort.record, JSON.stringify(row));
  await session.put(at.idempotency(input.scope, input.idempotencyKey), sort.only, JSON.stringify({ id: input.id }));
  appendRecordEvents(session, input.scope, input.id, 0, input.events, now);
  return { row, created: true };
}
/** Writes a locked record's next state and version, and appends its events. */
export async function writeRecord(session: DocumentSession, row: AggregateRow, state: StoredRecord['state'], events: readonly StoredEventInput[], now: number): Promise<AggregateRow> {
  const version = nextCounter(counter(row.version), 1); const sequence = counter(row.event_sequence);
  const current = json<AggregateRow>(await session.get(at.run(row.scope, row.id), sort.record, true));
  if (!current) throw new StorageError('STORAGE_UNAVAILABLE', 'Locked aggregate disappeared.');
  const next: AggregateRow = { ...current, state: JSON.stringify(storedObject(state)), version, event_sequence: nextCounter(sequence, events.length) };
  await session.put(at.run(row.scope, row.id), sort.record, JSON.stringify(next));
  appendRecordEvents(session, row.scope, row.id, sequence, events, now);
  return next;
}

/** Scheduled-workflow rows as documents, beside the scheduler's. */
export function documentScheduledRows(session: DocumentSession): ScheduledTransaction & ReturnType<typeof documentSchedulerRows> {
  const scheduler = documentSchedulerRows(session);
  const waitRows = async (scope: string, id: string) => json<{ rows: WorkflowWaitTargetRow[] }>(await session.get(at.run(scope, id), sort.waits))?.rows ?? [];
  return {
    ...scheduler,
    aggregate: async (scope, id) => json<AggregateRow>(await session.get(at.run(scope, id), sort.record, true)),
    createAggregate: (input, now) => createRecord(session, input, now),
    writeAggregate: (row, state, events, now) => writeRecord(session, row, state, events, now),
    redefine: async (scope, id, definitionHash, resourceHash) => {
      const record = json<AggregateRow>(await session.get(at.run(scope, id), sort.record)); const owner = json<WorkflowOwnerRow>(await session.get(at.run(scope, id), sort.owner));
      if (!record || !owner) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored scheduled workflow failed integrity validation.');
      await session.put(at.run(scope, id), sort.record, JSON.stringify({ ...record, definition_hash: definitionHash }));
      await session.put(at.run(scope, id), sort.owner, JSON.stringify({ ...owner, definition_hash: definitionHash, resource_hash: resourceHash }));
    },
    owner: async (scope, id) => json<WorkflowOwnerRow>(await session.get(at.run(scope, id), sort.owner)),
    ownerIdentity: async (scope, id) => {
      const owner = json<WorkflowOwnerRow>(await session.get(at.run(scope, id), sort.owner));
      return owner && { scope: owner.scope, aggregate_id: owner.aggregate_id, profile: owner.profile, definition_hash: owner.definition_hash, policy_hash: owner.policy_hash };
    },
    insertOwner: async owner => {
      if (await session.get(at.run(owner.scope, owner.aggregate_id), sort.owner) !== undefined) throw new StorageError('CONFLICT', 'The run is already enrolled.');
      await session.put(at.run(owner.scope, owner.aggregate_id), sort.owner, JSON.stringify(owner));
      session.insert(at.discovery(owner.scope, owner.policy_hash, Number(owner.profile)), sort.discovered(owner.aggregate_id), JSON.stringify({ aggregate_id: owner.aggregate_id }));
    },
    updateOwner: async (scope, id, aggregateVersion, data) => {
      const owner = json<WorkflowOwnerRow>(await session.get(at.run(scope, id), sort.owner));
      if (!owner) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored scheduled workflow failed integrity validation.');
      await session.put(at.run(scope, id), sort.owner, JSON.stringify({ ...owner, aggregate_version: aggregateVersion, data }));
    },
    lockRunJobs: async (scope, runId) => {
      const jobs = at.runJobs(scope, runId);
      await session.hold(jobs, sort.guard);
      const ids = (await session.query(jobs, { prefix: kind.job })).map(item => parts(item.sort)[1]!).sort(compareKeys);
      // A control command may release several jobs' holds: take those documents in one global key order.
      const held = new Set<string>();
      for (const jobId of ids) for (const resourceKey of await scheduler.heldKeys(scope, runId, jobId)) held.add(resourceKey);
      for (const resourceKey of [...held].sort(compareKeys)) await session.get(at.resource(scope, resourceKey), sort.head, true);
      return ids;
    },
    runHasJobs: async (scope, runId) => (await session.query(at.runJobs(scope, runId), { prefix: kind.job, limit: 1 })).length > 0,
    links: async (scope, id) => (await session.query(at.run(scope, id), { prefix: kind.link })).map(item => json<{ node_id: string; job_id: string }>(item.body)!),
    insertLink: async (scope, id, nodeId, jobId) => { session.insert(at.run(scope, id), sort.link(jobId), JSON.stringify({ node_id: nodeId, job_id: jobId })); },
    waitTargets: async (scope, id) => (await waitRows(scope, id)).slice(0, 129),
    deleteWaitTargets: async (scope, id) => {
      const rows = await waitRows(scope, id); if (!rows.length) return;
      for (const target of new Set(rows.map(row => row.run_id))) await session.delete(at.run(scope, target), sort.waiter(id));
      await session.delete(at.run(scope, id), sort.waits);
    },
    insertWaitTarget: async row => {
      const rows = await waitRows(row.scope, row.aggregate_id);
      if (rows.some(item => item.node_id === row.node_id && (Number(item.ordinal) === Number(row.ordinal) || item.run_id === row.run_id))) throw new StorageError('CONFLICT', 'A wait edge was registered twice.');
      await session.put(at.run(row.scope, row.aggregate_id), sort.waits, JSON.stringify({ rows: [...rows, { ...row, ordinal: Number(row.ordinal) }] }));
      await session.put(at.run(row.scope, row.run_id), sort.waiter(row.aggregate_id), JSON.stringify({ aggregate_id: row.aggregate_id }));
    },
    workflowWaitsOn: async (scope, runId) => (await session.query(at.run(scope, runId), { prefix: kind.waiter, limit: 1 })).length > 0,
    executionWaitTargets: async (scope, runId) => (await session.query(at.run(scope, runId), { prefix: executionWaiters, limit: 1 })).length > 0,
    completion: async (scope, runId) => json<CompletionRow>(await session.get(at.run(scope, runId), sort.completion)),
    insertCompletion: async row => { session.insert(at.run(row.scope, row.run_id), sort.completion, JSON.stringify(row)); },
    discoverRuns: async (scope, policyHash, afterId, limit) => (await session.query(at.discovery(scope, policyHash, 2), { prefix: kind.discovered,
      ...(afterId === '' ? {} : { after: sort.discovered(afterId) }), limit })).map(item => parts(item.sort)[1]!),
  };
}
