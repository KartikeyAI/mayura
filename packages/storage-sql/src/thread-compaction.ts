import { sha256Hex } from '@mayura/core/host';
import type { JsonObject } from '@mayura/core';
import { StorageError, threadResult, type ThreadCompactionRecord } from '@mayura/storage-contracts';
import type { CheckpointRow, ConversationTransaction, ThreadEntryRow, ThreadRow } from './conversation-persistence.js';

/** Fixed-length, scope-bound journal key in the existing checkpoint table; no new schema is required. */
export const compactionId = (scope: string, threadId: string, commandId: string): string =>
  `thread-compact:${sha256Hex(`${scope}\0${threadId}\0${commandId}`)}`;
const number = (value: number | string) => Number(value);
const conflict = (message: string): never => { throw new StorageError('CONFLICT', message); };

/** One thread lock and one journal lock own every transition, on SQL, MongoDB and document backends alike. */
export async function threadCompaction(tx: ConversationTransaction, row: ThreadRow, now: number, command: JsonObject): Promise<ThreadCompactionRecord | undefined> {
  const commandId = command['commandId'] as string;
  const journalId = compactionId(row.scope, row.id, commandId);
  await tx.lockCheckpoint(journalId); let journal = await tx.checkpoint(journalId);
  if (journal && journal.scope !== row.scope) conflict('The compaction belongs to another scope.');
  let saved: ThreadCompactionRecord | undefined;
  if (journal) {
    try {
      saved = threadResult('compaction', JSON.parse((await tx.checkpointParts(journalId)).join('')), { scope: row.scope, id: row.id, commandId, action: 'read' });
    } catch { throw new StorageError('STORAGE_UNAVAILABLE', 'The compaction journal failed integrity validation.'); }
  }
  const mine = !!saved && row.lease_run_id === saved.executorId && row.lease_holder_id === saved.executorId;
  const held = row.lease_expires_at_ms !== null && number(row.lease_expires_at_ms) > now;
  const write = async (record: ThreadCompactionRecord): Promise<ThreadCompactionRecord> => {
    const parts = [JSON.stringify(record)];
    if (!journal) {
      journal = { run_id: journalId, scope: row.scope, version: 1, status: 'waiting', holder_id: null, lease_expires_at_ms: null,
        created_at_ms: now, updated_at_ms: now, expires_at_ms: Number.MAX_SAFE_INTEGER, parts: 1 };
      await tx.insertCheckpoint(journal, parts);
    } else {
      const next: CheckpointRow = { ...journal, version: number(journal.version) + 1, updated_at_ms: now, parts: 1 };
      await tx.updateCheckpoint(next, parts, journal); journal = next;
    }
    return record;
  };
  const tailOpen = async (): Promise<boolean> => {
    const tail = (await tx.entries(row.scope, row.id, { before: number(row.last_sequence) + 1 }, 1))[0];
    if (tail?.kind !== 'run') return false;
    const data = JSON.parse(tail.data) as JsonObject;
    return data['recording'] === true && data['status'] === 'running';
  };
  const updateThread = async (entries: readonly ThreadEntryRow[], release: boolean, lease?: { executorId: string; leaseMs: number }) => {
    if (entries.length) await tx.insertEntries(row.scope, row.id, entries);
    const next: ThreadRow = { ...row, version: number(row.version) + 1, updated_at_ms: now,
      last_sequence: number(row.last_sequence) + entries.length, entry_count: number(row.entry_count) + entries.length,
      ...(release ? { lease_run_id: null, lease_holder_id: null, lease_expires_at_ms: null } : {}),
      ...(lease ? { lease_run_id: lease.executorId, lease_holder_id: lease.executorId, lease_expires_at_ms: now + lease.leaseMs } : {}) };
    await tx.updateThread(next, row); row = next;
  };
  const marker = (executorId: string, status: string, sequence: number, errorCode?: string): ThreadEntryRow => ({ sequence, run_id: executorId, kind: 'run', created_at_ms: now,
    data: JSON.stringify({ runId: executorId, status, compaction: { format: 1, commandId }, ...(errorCode ? { errorCode } : {}) }) });
  if (command['action'] === 'read') return saved;
  if (command['action'] === 'reserve') {
    if (saved) { if (saved.requestDigest !== command['requestDigest']) conflict('This compaction command has a different request.'); return saved; }
    if (row.status !== 'active' || held || await tailOpen() || number(row.last_sequence) !== command['expectedSequence'])
      conflict('Compaction requires the reviewed active thread with no writer or unfinished persisted turn.');
    const through = command['through'] as number;
    const end = (await tx.entries(row.scope, row.id, { after: through - 1 }, 1))[0];
    const endData = end ? JSON.parse(end.data) as JsonObject : undefined;
    if (!end || number(end.sequence) !== through || end.kind !== 'run' || endData?.['compaction'] !== undefined
      || !['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(endData?.['status'] as string))
      conflict('Compaction must end at a complete conversation turn.');
    const record: ThreadCompactionRecord = { format: 1, threadId: row.id, commandId, requestDigest: command['requestDigest'] as string,
      sourceDigest: command['sourceDigest'] as string, covers: { from: 1, to: through }, sourceEntries: command['sourceEntries'] as number,
      sourceTurns: command['sourceTurns'] as number, maxCostMicros: command['maxCostMicros'] as number, snapshotSequence: command['expectedSequence'] as number, executorId: command['executorId'] as string,
      agentId: command['agentId'] as string, agentVersion: command['agentVersion'] as string, status: 'pending', content: null, modelRunId: null,
      costMicros: null, errorCode: null, entrySequence: null, committedAtMs: null };
    await write(record);
    await updateThread([marker(record.executorId, 'running', number(row.last_sequence) + 1)], false,
      { executorId: record.executorId, leaseMs: command['leaseMs'] as number });
    return record;
  }
  if (!saved) throw new StorageError('NOT_FOUND', 'No such compaction command.');
  if (command['action'] === 'stage') {
    if (saved.executorId !== command['executorId']) conflict('Another executor owns this compaction.');
    if (saved.status === 'ready' || saved.status === 'committed') {
      if (saved.content !== command['content'] || saved.modelRunId !== command['modelRunId'] || saved.costMicros !== command['costMicros']) conflict('This compaction has a different model result.');
      return saved;
    }
    if (saved.status !== 'pending') conflict('This compaction command was terminated.');
    return write({ ...saved, status: 'ready', content: command['content'] as string, modelRunId: command['modelRunId'] as string, costMicros: command['costMicros'] as number | string });
  }
  if (command['action'] === 'fail') {
    if (saved.executorId !== command['executorId']) conflict('Another executor owns this compaction.');
    if (saved.status === 'committed' || saved.status === 'failed') return saved;
    const failed = await write({ ...saved, status: 'failed', errorCode: command['code'] as string });
    if (mine) {
      const entries = held && number(row.last_sequence) === saved.snapshotSequence + 1
        ? [marker(saved.executorId, 'failed', number(row.last_sequence) + 1, command['code'] as string)] : [];
      await updateThread(entries, true);
    }
    return failed;
  }
  if (command['action'] === 'commit') {
    if (saved.status === 'committed') return saved;
    if (saved.status !== 'ready' || saved.content === null || saved.costMicros === null || saved.modelRunId === null) conflict('The compaction has no released summary to publish.');
    if (row.status !== 'active' || (held && !mine) || await tailOpen()) conflict('Another turn owns this thread; retry publishing its saved summary later.');
    if (number(row.last_sequence) > 999_999_998) throw new StorageError('LIMIT_EXCEEDED', 'The thread sequence limit is reached.');
    const sequence = number(row.last_sequence) + 1;
    const summary: ThreadEntryRow = { sequence, run_id: saved.executorId, kind: 'summary', created_at_ms: now,
      data: JSON.stringify({ content: saved.content, covers: saved.covers, compaction: { format: 1, commandId, requestDigest: saved.requestDigest,
        sourceDigest: saved.sourceDigest, sourceEntries: saved.sourceEntries, sourceTurns: saved.sourceTurns, agentId: saved.agentId,
        agentVersion: saved.agentVersion, modelRunId: saved.modelRunId, costMicros: saved.costMicros } }) };
    await updateThread([summary, marker(saved.executorId, 'succeeded', sequence + 1)], mine);
    return write({ ...saved, status: 'committed', entrySequence: sequence, committedAtMs: now });
  }
  throw new StorageError('INVALID_INPUT', 'Unknown compaction transition.');
}
