import type { JsonObject, JsonValue } from '@mayura/core';
import {
  CHECKPOINT_LIMITS, StorageError, runCheckpointCommand, threadCommand,
  type RunCheckpoint, type RunCheckpointMethod, type ThreadEntry, type ThreadEntryInput, type ThreadMethod, type ThreadRecord,
} from '@mayura/storage-contracts';
import { storedInteger } from './aggregate-session.js';
import { sqlConversationPersistence, type CheckpointRow, type ConversationPersistence, type ConversationTransaction, type ThreadEntryRow, type ThreadRow } from './conversation-persistence.js';
import type { SchedulerBackend } from './scheduler-database.js';

function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored conversation data failed integrity validation.'); }
function missing(what: string): never { throw new StorageError('NOT_FOUND', `${what} was not found.`); }
function conflict(message: string): never { throw new StorageError('CONFLICT', message); }
const tombstone = (status: string) => status === 'deleting' || status === 'deleted';
const integer = (value: number | string | null) => value === null ? null : storedInteger(value);
function parse(text: string): JsonValue { try { return JSON.parse(text) as JsonValue; } catch { return corrupt(); } }

function threadRecord(row: ThreadRow): ThreadRecord {
  const leased = row.lease_run_id !== null && row.lease_holder_id !== null && row.lease_expires_at_ms !== null;
  return {
    scope: row.scope, id: row.id, version: storedInteger(row.version), status: row.status as ThreadRecord['status'],
    agentId: row.agent_id, title: row.title, metadata: parse(row.metadata) as JsonObject,
    createdAtMs: storedInteger(row.created_at_ms), updatedAtMs: storedInteger(row.updated_at_ms),
    entryCount: storedInteger(row.entry_count), lastSequence: storedInteger(row.last_sequence),
    lease: leased ? { runId: row.lease_run_id!, holderId: row.lease_holder_id!, expiresAtMs: storedInteger(row.lease_expires_at_ms!) } : null,
  };
}
function threadEntry(row: ThreadEntryRow): ThreadEntry {
  return { sequence: storedInteger(row.sequence), runId: row.run_id, kind: row.kind as ThreadEntry['kind'], data: parse(row.data) as JsonObject, createdAtMs: storedInteger(row.created_at_ms) };
}
/** A body as parts of at most `CHECKPOINT_LIMITS.partBytes` UTF-8 bytes, never splitting a surrogate pair. */
export function checkpointParts(body: JsonObject): string[] {
  const text = JSON.stringify(body); const parts: string[] = [];
  const units = Math.floor(CHECKPOINT_LIMITS.partBytes / 3);
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + units);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
    parts.push(text.slice(start, end)); start = end;
  }
  return parts.length ? parts : ['{}'];
}
function checkpointRecord(row: CheckpointRow, parts: readonly string[]): RunCheckpoint {
  if (parts.length !== storedInteger(row.parts)) corrupt();
  return {
    runId: row.run_id, scope: row.scope, version: storedInteger(row.version), status: row.status as RunCheckpoint['status'],
    holderId: row.holder_id, leaseExpiresAtMs: integer(row.lease_expires_at_ms),
    createdAtMs: storedInteger(row.created_at_ms), updatedAtMs: storedInteger(row.updated_at_ms), expiresAtMs: storedInteger(row.expires_at_ms),
    body: parse(parts.join('')) as JsonObject,
  };
}

/**
 * Threads and run checkpoints, written once for every store: the SQL layer's tables, or any `ConversationPersistence`
 * (document stores, MongoDB). Each method runs in one transaction; timestamps come from the store's clock.
 */
export class ConversationDatabase {
  private initialized = false;
  private readonly persistence: ConversationPersistence;
  constructor(backend: SchedulerBackend | ConversationPersistence) {
    this.persistence = 'dialect' in backend ? sqlConversationPersistence(backend) : backend;
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.persistence.initialize(); this.initialized = true;
  }
  private ready(): void { if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize conversation storage first (store.threads.initialize()).'); }

  async thread(method: ThreadMethod, value: unknown): Promise<unknown> {
    const command = threadCommand(method, value);
    if (method === 'initialize') return this.initialize();
    this.ready();
    if (method === 'expire') return this.expire(command);
    if (method === 'list') return this.persistence.transaction(async tx => this.list(tx, command));
    const scope = command['scope'] as string; const id = command['id'] as string;
    return this.persistence.transaction(async tx => {
      if (method === 'get') { const row = await tx.thread(scope, id); return row ? threadRecord(row) : undefined; }
      if (method === 'entries') {
        const row = await tx.thread(scope, id); if (!row) missing('Thread');
        if (tombstone(row.status)) return [];
        const range = Object.hasOwn(command, 'before') ? { before: command['before'] as number } : { after: (command['after'] as number | undefined) ?? 0 };
        return (await tx.entries(scope, id, range, command['limit'] as number)).map(threadEntry);
      }
      await tx.lockThread(scope, id);
      const row = await tx.thread(scope, id);
      const now = Math.max(await tx.clock(), row ? storedInteger(row.updated_at_ms) : 0);
      if (method === 'create') {
        if (row) { if (tombstone(row.status)) conflict('That thread id was deleted and cannot be reused.'); return { thread: threadRecord(row), created: false }; }
        const created: ThreadRow = {
          scope, id, version: 1, status: 'active', agent_id: command['agentId'] as string | null, title: command['title'] as string | null,
          metadata: JSON.stringify(command['metadata']), created_at_ms: now, updated_at_ms: now, entry_count: 0, last_sequence: 0,
          lease_run_id: null, lease_holder_id: null, lease_expires_at_ms: null,
        };
        await tx.insertThread(created); return { thread: threadRecord(created), created: true };
      }
      if (!row) missing('Thread');
      if (method === 'delete') return this.remove(tx, row, now, command['limit'] as number);
      if (tombstone(row.status)) missing('Thread');
      const write = async (next: ThreadRow) => { await tx.updateThread(next, row); return next; };
      const held = row.lease_run_id !== null && row.lease_expires_at_ms !== null && storedInteger(row.lease_expires_at_ms) > now;
      const mine = row.lease_run_id === command['runId'] && row.lease_holder_id === command['holderId'];
      switch (method) {
        case 'update': {
          if (storedInteger(row.version) !== command['expectedVersion']) conflict('The thread changed since you read it.');
          return threadRecord(await write({
            ...row, version: storedInteger(row.version) + 1, updated_at_ms: now,
            ...(Object.hasOwn(command, 'title') ? { title: command['title'] as string | null } : {}),
            ...(Object.hasOwn(command, 'metadata') ? { metadata: JSON.stringify(command['metadata']) } : {}),
            ...(Object.hasOwn(command, 'status') ? { status: command['status'] as string } : {}),
          }));
        }
        case 'acquire': case 'renew': {
          if (held && !mine) conflict('Another run holds this thread.');
          if (method === 'renew' && !mine) conflict('This run does not hold the thread.');
          return threadRecord(await write({
            ...row, lease_run_id: command['runId'] as string, lease_holder_id: command['holderId'] as string, lease_expires_at_ms: now + (command['leaseMs'] as number),
          }));
        }
        case 'release': {
          if (!mine) return threadRecord(row);
          return threadRecord(await write({ ...row, lease_run_id: null, lease_holder_id: null, lease_expires_at_ms: null }));
        }
        case 'append': {
          if (!mine || !held) conflict('This run does not hold the thread, or its lease expired.');
          const last = storedInteger(row.last_sequence);
          if (last !== command['expectedSequence']) conflict('The thread has entries this run has not seen.');
          const inputs = command['entries'] as unknown as ThreadEntryInput[];
          const rows: ThreadEntryRow[] = inputs.map((entry, index) => ({
            sequence: last + index + 1, run_id: command['runId'] as string, kind: entry.kind, data: JSON.stringify(entry.data), created_at_ms: now,
          }));
          await tx.insertEntries(scope, id, rows);
          const next = await write({ ...row, updated_at_ms: now, entry_count: storedInteger(row.entry_count) + rows.length, last_sequence: last + rows.length });
          return { thread: threadRecord(next), entries: rows.map(threadEntry) };
        }
      }
      return corrupt();
    });
  }

  private async list(tx: ConversationTransaction, command: JsonObject): Promise<unknown> {
    const before = typeof command['before'] === 'string' ? command['before'] as string : undefined;
    const position: [number, string] | undefined = before ? [Number(before.slice(0, before.indexOf(':'))), before.slice(before.indexOf(':') + 1)] : undefined;
    const limit = command['limit'] as number;
    const rows = await tx.listThreads(command['scope'] as string, command['statuses'] as string[], position, limit);
    const threads = rows.map(threadRecord);
    const tail = threads[threads.length - 1];
    return { threads, cursor: threads.length === limit && tail ? `${tail.updatedAtMs}:${tail.id}` : null };
  }

  /** Deletion in pages: the first call makes the thread a tombstone (content unreadable at once), each call removes entries. */
  private async remove(tx: ConversationTransaction, row: ThreadRow, now: number, limit: number): Promise<unknown> {
    let current = row;
    if (!tombstone(row.status)) {
      current = { ...row, version: storedInteger(row.version) + 1, status: 'deleting', agent_id: null, title: null, metadata: '{}', updated_at_ms: now,
        lease_run_id: null, lease_holder_id: null, lease_expires_at_ms: null };
      await tx.updateThread(current, row);
    }
    if (current.status === 'deleted') return { thread: threadRecord(current), removed: 0 };
    const removed = await tx.deleteEntries(row.scope, row.id, limit);
    const remaining = Math.max(0, storedInteger(current.entry_count) - removed);
    const next: ThreadRow = { ...current, entry_count: remaining, status: remaining === 0 ? 'deleted' : 'deleting' };
    if (next.entry_count !== current.entry_count || next.status !== current.status) await tx.updateThread(next, current);
    return { thread: threadRecord(next), removed };
  }

  /** Retention: marks idle threads as `deleting`, each in its own transaction; `delete` drains them. */
  private async expire(command: JsonObject): Promise<unknown> {
    const candidates = await this.persistence.transaction(tx => tx.idleThreads(command['idleBeforeMs'] as number, command['limit'] as number));
    const expired: { scope: string; id: string }[] = [];
    for (const key of candidates) {
      const done = await this.persistence.transaction(async tx => {
        await tx.lockThread(key.scope, key.id);
        const row = await tx.thread(key.scope, key.id);
        if (!row || tombstone(row.status) || storedInteger(row.updated_at_ms) >= (command['idleBeforeMs'] as number)) return false;
        const now = Math.max(await tx.clock(), storedInteger(row.updated_at_ms));
        // A thread with nothing to drain is deleted at once.
        const status = storedInteger(row.entry_count) === 0 ? 'deleted' : 'deleting';
        await tx.updateThread({ ...row, version: storedInteger(row.version) + 1, status, agent_id: null, title: null, metadata: '{}', updated_at_ms: now,
          lease_run_id: null, lease_holder_id: null, lease_expires_at_ms: null }, row);
        return true;
      });
      if (done) expired.push(key);
    }
    return expired;
  }

  async checkpoint(method: RunCheckpointMethod, value: unknown): Promise<unknown> {
    const command = runCheckpointCommand(method, value);
    if (method === 'initialize') return this.initialize();
    this.ready();
    if (method === 'due') return this.persistence.transaction(tx => tx.dueCheckpoints(command['expiresBeforeMs'] as number, command['limit'] as number));
    const runId = command['runId'] as string;
    return this.persistence.transaction(async tx => {
      if (method === 'get') { const row = await tx.checkpoint(runId); return row ? checkpointRecord(row, await tx.checkpointParts(runId)) : undefined; }
      await tx.lockCheckpoint(runId);
      const row = await tx.checkpoint(runId);
      const now = Math.max(await tx.clock(), row ? storedInteger(row.updated_at_ms) : 0);
      if (method === 'put') {
        if (row) conflict('A checkpoint for this run exists already.');
        const parts = checkpointParts(command['body'] as JsonObject);
        const created: CheckpointRow = { run_id: runId, scope: command['scope'] as string, version: 1, status: 'waiting', holder_id: null, lease_expires_at_ms: null,
          created_at_ms: now, updated_at_ms: now, expires_at_ms: command['expiresAtMs'] as number, parts: parts.length };
        await tx.insertCheckpoint(created, parts);
        return checkpointRecord(created, parts);
      }
      if (method === 'delete') {
        if (!row) return false;
        if (Object.hasOwn(command, 'holderId') && row.status === 'claimed' && row.holder_id !== command['holderId']) conflict('Another holder has claimed this checkpoint.');
        await tx.deleteCheckpoint(row); return true;
      }
      if (!row) missing('Checkpoint');
      const leaseLive = row.status === 'claimed' && row.lease_expires_at_ms !== null && storedInteger(row.lease_expires_at_ms) > now;
      if (method === 'claim') {
        if (leaseLive && row.holder_id !== command['holderId']) conflict('Another holder has claimed this checkpoint.');
        const next: CheckpointRow = { ...row, version: storedInteger(row.version) + 1, status: 'claimed', holder_id: command['holderId'] as string,
          lease_expires_at_ms: now + (command['leaseMs'] as number), updated_at_ms: now };
        await tx.updateCheckpoint(next, undefined, row);
        return checkpointRecord(next, await tx.checkpointParts(runId));
      }
      if (method === 'update') {
        if (row.status !== 'claimed' || row.holder_id !== command['holderId'] || !leaseLive) throw new StorageError('STALE_CLAIM', 'This holder no longer holds the checkpoint.');
        if (storedInteger(row.version) !== command['expectedVersion']) conflict('The checkpoint changed since this holder read it.');
        const waiting = command['status'] === 'waiting';
        const parts = checkpointParts(command['body'] as JsonObject);
        const next: CheckpointRow = { ...row, version: storedInteger(row.version) + 1, status: command['status'] as string, updated_at_ms: now, parts: parts.length,
          holder_id: waiting ? null : row.holder_id, lease_expires_at_ms: waiting ? null : row.lease_expires_at_ms };
        await tx.updateCheckpoint(next, parts, row);
        return checkpointRecord(next, parts);
      }
      return corrupt();
    });
  }
}
