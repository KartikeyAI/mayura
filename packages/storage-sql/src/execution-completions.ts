import { jsonValue } from '@mayura/core';
import { executionCompletion, workflowHashMaterial, type ExecutionCompletion, type ExecutionRef } from '@mayura/storage-contracts';
import { StorageError } from './contracts.js';
import { storedInteger, type AggregateRow } from './aggregate-session.js';
import { canonical } from './scheduler-validation.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';
import { sha256Hex, utf8ByteLength } from '@mayura/core/host';

interface CompletionRow {
  scope: string; run_id: string; definition_hash: string; policy_hash: string; outcome: string;
  source_version: number | string; source_event_sequence: number | string; data: string; digest: string;
}
const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
export function completionFailure(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored execution completion failed integrity validation.'); }
export function completionJson(value: unknown): string { return canonical(jsonValue(value, { maxBytes: 65_536 })); }
function digest(scope: string, completion: ExecutionCompletion): string {
  return sha256Hex(workflowHashMaterial('mayura:execution-completion:v1', { scope, ...completion }));
}
/** Created by the scheduled writer, so terminal publication never depends on a waiter existing. */
export async function initializeCompletions(tx: SchedulerSession, backend: SchedulerBackend): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS ${backend.prefix}mayura_execution_completions (
    scope TEXT NOT NULL, run_id TEXT NOT NULL, definition_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
    outcome TEXT NOT NULL, source_version BIGINT NOT NULL CHECK(source_version > 0),
    source_event_sequence BIGINT NOT NULL CHECK(source_event_sequence > 0), data TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(scope,run_id), FOREIGN KEY(scope,run_id) REFERENCES ${backend.prefix}mayura_workflow_owners(scope,aggregate_id))`);
}
/** Reads immutable facts only: callers never acquire a target workflow lock from a wait transaction. */
export async function readCompletion(tx: SchedulerSession, backend: SchedulerBackend, scope: string, reference: ExecutionRef): Promise<ExecutionCompletion | undefined> {
  const row = (await tx.query<CompletionRow>(`SELECT * FROM ${backend.prefix}mayura_execution_completions WHERE scope = ? AND run_id = ?`, [scope, reference.runId]))[0];
  if (!row) return undefined;
  try {
    if (typeof row.data !== 'string' || utf8ByteLength(row.data) > 65_536) completionFailure();
    const value = executionCompletion(JSON.parse(row.data));
    if (row.scope !== scope || row.run_id !== reference.runId || row.definition_hash !== reference.definitionHash
      || row.policy_hash !== reference.policyHash || completionJson(value.reference) !== completionJson(reference)
      || row.outcome !== value.outcome || storedInteger(row.source_version) !== value.sourceVersion
      || storedInteger(row.source_event_sequence) !== value.sourceEventSequence || row.data !== completionJson(value)
      || row.digest !== digest(scope, value)) completionFailure();
    return value;
  } catch { return completionFailure(); }
}
/** Old terminal observations remain immutable when a later receipt advances source evidence. */
export async function checkCompletion(tx: SchedulerSession, backend: SchedulerBackend, row: AggregateRow, policyHash: string, status: string, publish: boolean): Promise<ExecutionCompletion | undefined> {
  const reference: ExecutionRef = { kind: 'scheduled-workflow', runId: row.id, definitionHash: row.definition_hash, policyHash };
  const existing = await readCompletion(tx, backend, row.scope, reference);
  if (existing) {
    if (!terminal.has(status) || existing.outcome !== status || existing.sourceVersion > storedInteger(row.version)
      || existing.sourceEventSequence > storedInteger(row.event_sequence)) completionFailure();
    return existing;
  }
  if (!publish || !terminal.has(status)) return undefined;
  const value = executionCompletion({ reference, outcome: status, sourceVersion: storedInteger(row.version), sourceEventSequence: storedInteger(row.event_sequence) });
  // The caller owns the aggregate lock, serializing all legitimate publishers of this identity.
  await tx.query(`INSERT INTO ${backend.prefix}mayura_execution_completions
    (scope,run_id,definition_hash,policy_hash,outcome,source_version,source_event_sequence,data,digest) VALUES (?,?,?,?,?,?,?,?,?)`,
  [row.scope, row.id, row.definition_hash, policyHash, status, value.sourceVersion, value.sourceEventSequence, completionJson(value), digest(row.scope, value)]);
  return value;
}
