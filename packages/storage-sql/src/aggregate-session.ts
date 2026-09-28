import { StorageError, type CreateRecord, type StoredRecord, type StoredEventInput } from './contracts.js';
import { identifier, nextCounter, storedObject, submissionDigest } from './validation.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

export interface AggregateRow {
  scope: string; id: string; idempotency_key: string; definition_hash: string; submission_digest: string;
  version: number | string; event_sequence: number | string; state: string;
}
export function storedInteger(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored aggregate counter is invalid.');
  return result;
}
export function aggregateRecord(row: AggregateRow): StoredRecord {
  try {
    const version = storedInteger(row.version); if (version === 0) throw new Error();
    return { scope: row.scope, id: row.id, idempotencyKey: row.idempotency_key, definitionHash: row.definition_hash,
      version, state: storedObject(JSON.parse(row.state)) };
  }
  catch { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored aggregate failed integrity validation.'); }
}
export function writerRequired(): never { throw new StorageError('SCHEDULED_WRITER_REQUIRED', 'This run requires its scheduled workflow writer.'); }
export function lockSql(backend: SchedulerBackend, skip = false): string { return backend.dialect === 'postgres' ? ` FOR UPDATE${skip ? ' SKIP LOCKED' : ''}` : ''; }

/** Locks the identity even before its aggregate exists; SQLite's writer transaction already does this. */
export async function lockRunIdentity(tx: SchedulerSession, backend: SchedulerBackend, scope: string, id: string): Promise<void> {
  if (backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [JSON.stringify(['mayura:workflow-run:v1', backend.prefix, scope, id])]);
}
export async function loadAggregate(tx: SchedulerSession, backend: SchedulerBackend, scope: string, id: string, skip = false): Promise<AggregateRow | undefined> {
  return (await tx.query<AggregateRow>(`SELECT * FROM ${backend.prefix}mayura_aggregates WHERE scope = ? AND id = ?${lockSql(backend, skip)}`, [scope, id]))[0];
}
export async function ownedRun(tx: SchedulerSession, backend: SchedulerBackend, scope: string, id: string): Promise<boolean> {
  return (await tx.query(`SELECT aggregate_id FROM ${backend.prefix}mayura_workflow_owners WHERE scope = ? AND aggregate_id = ?`, [scope, id])).length !== 0;
}
/** Always available after ordinary store initialization, even before the workflow capability is used. */
export async function initializeOwnership(tx: SchedulerSession, backend: SchedulerBackend): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS ${backend.prefix}mayura_workflow_owners (
    scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, profile INTEGER NOT NULL CHECK(profile > 0),
    aggregate_version BIGINT NOT NULL CHECK(aggregate_version > 0), definition_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL, resource_hash TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(scope, aggregate_id), FOREIGN KEY(scope, aggregate_id) REFERENCES ${backend.prefix}mayura_aggregates(scope, id))`);
}
export async function storageClock(tx: SchedulerSession, backend: SchedulerBackend, floor = 0): Promise<number> {
  const sql = backend.dialect === 'postgres' ? 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms'
    : "SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms";
  const value = (await tx.query<{ now_ms: number | string }>(sql))[0]?.now_ms;
  if (value === undefined) throw new StorageError('STORAGE_UNAVAILABLE', 'Storage time is unavailable.');
  return Math.max(floor, storedInteger(value));
}
export async function appendAggregateEvents(tx: SchedulerSession, backend: SchedulerBackend, scope: string, id: string, sequence: number, events: readonly StoredEventInput[], now: number): Promise<void> {
  const time = new Date(now).toISOString();
  for (const [index, event] of events.entries()) await tx.query(`INSERT INTO ${backend.prefix}mayura_events (scope, aggregate_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [scope, id, nextCounter(sequence, index + 1), identifier(event.type, 'Event'), JSON.stringify(event.data), time]);
}
export async function createAggregate(tx: SchedulerSession, backend: SchedulerBackend, input: CreateRecord, now: number): Promise<{ row: AggregateRow; created: boolean }> {
  const digest = submissionDigest(input);
  const rows = await tx.query<AggregateRow>(`INSERT INTO ${backend.prefix}mayura_aggregates (scope, id, idempotency_key, definition_hash, submission_digest, version, event_sequence, state)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (scope, idempotency_key) DO NOTHING RETURNING *`,
    [input.scope, input.id, input.idempotencyKey, input.definitionHash, digest, input.events.length, JSON.stringify(input.state)]);
  if (rows[0]) { await appendAggregateEvents(tx, backend, input.scope, input.id, 0, input.events, now); return { row: rows[0], created: true }; }
  const existing = (await tx.query<AggregateRow>(`SELECT * FROM ${backend.prefix}mayura_aggregates WHERE scope = ? AND idempotency_key = ?${lockSql(backend)}`, [input.scope, input.idempotencyKey]))[0];
  if (!existing || existing.submission_digest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
  return { row: existing, created: false };
}
/** Only internal semantic reducers call this after the aggregate lock; it is not a public replacement-state API. */
export async function writeAggregate(tx: SchedulerSession, backend: SchedulerBackend, row: AggregateRow, state: StoredRecord['state'], events: readonly StoredEventInput[], now: number): Promise<AggregateRow> {
  const version = nextCounter(storedInteger(row.version), 1); const sequence = storedInteger(row.event_sequence);
  const updated = (await tx.query<AggregateRow>(`UPDATE ${backend.prefix}mayura_aggregates SET state = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ? RETURNING *`,
    [JSON.stringify(storedObject(state)), version, nextCounter(sequence, events.length), row.scope, row.id]))[0];
  if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Locked aggregate disappeared.');
  await appendAggregateEvents(tx, backend, row.scope, row.id, sequence, events, now); return updated;
}
