import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type AggregateStore } from './contracts.js';

// Conversations: threads (a scope's chat history) and run checkpoints (the saved state of a run paused for a person).
// These are storage commands: a store is never told who asks. The threads API decides the scope from a verified
// identity and checks grants; the store keeps bounds, ordering, leases and deletion.

/** What a thread's entry records. The store checks bounds only; the threads API checks each kind's shape. */
export type ThreadEntryKind = 'user' | 'assistant' | 'tool_calls' | 'tool_result' | 'approval' | 'summary' | 'run';
export type ThreadStatus = 'active' | 'archived' | 'deleting' | 'deleted';
export interface ThreadLease { readonly runId: string; readonly holderId: string; readonly expiresAtMs: number }
export interface ThreadRecord {
  readonly scope: string; readonly id: string; readonly version: number; readonly status: ThreadStatus;
  /** Null on a tombstone (`deleting`, `deleted`), which keeps no content. */
  readonly agentId: string | null; readonly title: string | null; readonly metadata: JsonObject;
  readonly createdAtMs: number; readonly updatedAtMs: number;
  /** Entries stored now; a `deleting` tombstone counts down to 0. */
  readonly entryCount: number; readonly lastSequence: number;
  readonly lease: ThreadLease | null;
}
export interface ThreadEntryInput { readonly kind: ThreadEntryKind; readonly data: JsonObject }
export interface ThreadEntry extends ThreadEntryInput { readonly sequence: number; readonly runId: string; readonly createdAtMs: number }
export interface ThreadKey { readonly scope: string; readonly id: string }
export interface ThreadCreate extends ThreadKey { readonly agentId: string | null; readonly title: string | null; readonly metadata: JsonObject }
export interface ThreadList { readonly scope: string; readonly statuses: readonly ('active' | 'archived')[]; readonly before?: string; readonly limit: number }
export interface ThreadUpdate extends ThreadKey {
  readonly expectedVersion: number; readonly title?: string | null; readonly metadata?: JsonObject; readonly status?: 'active' | 'archived';
}
export interface ThreadLeaseCommand extends ThreadKey { readonly runId: string; readonly holderId: string; readonly leaseMs: number }
export interface ThreadRelease extends ThreadKey { readonly runId: string; readonly holderId: string }
export interface ThreadAppend extends ThreadKey {
  readonly runId: string; readonly holderId: string; readonly expectedSequence: number; readonly entries: readonly ThreadEntryInput[];
}
export interface ThreadEntries extends ThreadKey { readonly after?: number; readonly before?: number; readonly limit: number }
export interface ThreadDelete extends ThreadKey { readonly limit: number }
export interface ThreadExpire { readonly idleBeforeMs: number; readonly limit: number }

/** A completion journal, stored atomically with verification of its thread/run association. */
export type ThreadRecordingCommand = ThreadKey & { readonly runtimeRunId: string } & (
  | { readonly action: 'read' | 'delete' }
  | { readonly action: 'save'; readonly turnId: string; readonly startSequence: number; readonly body: JsonObject }
);

/** Durable compaction journal. Pending commands are never automatically billed a second time. */
export interface ThreadCompactionRecord {
  readonly format: 1; readonly threadId: string; readonly commandId: string; readonly requestDigest: string;
  readonly sourceDigest: string; readonly covers: { readonly from: number; readonly to: number };
  readonly sourceEntries: number; readonly sourceTurns: number; readonly maxCostMicros: number; readonly snapshotSequence: number;
  readonly executorId: string; readonly agentId: string; readonly agentVersion: string;
  readonly status: 'pending' | 'ready' | 'committed' | 'failed';
  readonly content: string | null; readonly modelRunId: string | null; readonly costMicros: number | string | null;
  readonly errorCode: string | null; readonly entrySequence: number | null; readonly committedAtMs: number | null;
}
export type ThreadCompactionCommand = ThreadKey & { readonly commandId: string } & (
  | { readonly action: 'read' | 'commit' }
  | { readonly action: 'reserve'; readonly requestDigest: string; readonly sourceDigest: string;
      readonly through: number; readonly expectedSequence: number; readonly sourceEntries: number; readonly sourceTurns: number; readonly maxCostMicros: number;
      readonly executorId: string; readonly agentId: string; readonly agentVersion: string; readonly leaseMs: number }
  | { readonly action: 'stage'; readonly executorId: string; readonly content: string; readonly modelRunId: string; readonly costMicros: number | string }
  | { readonly action: 'fail'; readonly executorId: string; readonly code: string }
);

export interface ThreadStore {
  initialize(): Promise<void>;
  /** Reserve, stage and atomically publish a non-destructive summary, or terminate its reservation. */
  compaction(command: ThreadCompactionCommand): Promise<ThreadCompactionRecord | undefined>;
  create(command: ThreadCreate): Promise<{ readonly thread: ThreadRecord; readonly created: boolean }>;
  get(command: ThreadKey): Promise<ThreadRecord | undefined>;
  list(command: ThreadList): Promise<{ readonly threads: readonly ThreadRecord[]; readonly cursor: string | null }>;
  update(command: ThreadUpdate): Promise<ThreadRecord>;
  acquire(command: ThreadLeaseCommand): Promise<ThreadRecord>;
  renew(command: ThreadLeaseCommand): Promise<ThreadRecord>;
  release(command: ThreadRelease): Promise<ThreadRecord>;
  append(command: ThreadAppend): Promise<{ readonly thread: ThreadRecord; readonly entries: readonly ThreadEntry[] }>;
  entries(command: ThreadEntries): Promise<readonly ThreadEntry[]>;
  delete(command: ThreadDelete): Promise<{ readonly thread: ThreadRecord; readonly removed: number }>;
  expire(command: ThreadExpire): Promise<readonly ThreadKey[]>;
  /** Save/read/clear a terminal recording outbox. Content is removed along with the owning thread. */
  recording(command: ThreadRecordingCommand): Promise<JsonObject | undefined>;
}

export type RunCheckpointStatus = 'waiting' | 'claimed';
export interface RunCheckpoint {
  readonly runId: string; readonly scope: string; readonly version: number; readonly status: RunCheckpointStatus;
  readonly holderId: string | null; readonly leaseExpiresAtMs: number | null;
  readonly createdAtMs: number; readonly updatedAtMs: number; readonly expiresAtMs: number;
  readonly body: JsonObject;
}
export interface RunCheckpointPut { readonly runId: string; readonly scope: string; readonly expiresAtMs: number; readonly body: JsonObject }
export interface RunCheckpointKey { readonly runId: string }
export interface RunCheckpointClaim extends RunCheckpointKey {
  readonly holderId: string; readonly leaseMs: number;
  /** Optional external-continuation epoch fence; checked atomically before ownership can transfer. */
  readonly expectedDigest?: string;
}
export interface RunCheckpointUpdate extends RunCheckpointKey {
  readonly holderId: string; readonly expectedVersion: number; readonly body: JsonObject; readonly status: RunCheckpointStatus;
}
export interface RunCheckpointDelete extends RunCheckpointKey {
  readonly holderId?: string;
  /** Paired one-shot continuation fence. Requires a live claimed checkpoint with this version and pending digest. */
  readonly expectedVersion?: number; readonly expectedDigest?: string;
}
export interface RunCheckpointDue { readonly expiresBeforeMs: number; readonly limit: number }

/** Stable recovery cursor ordered by expiry then ASCII run id. Start a fresh sweep after reaching the end. */
export interface RunCheckpointCursor { readonly expiresAtMs: number; readonly runId: string }
export interface RunCheckpointScan { readonly after?: RunCheckpointCursor; readonly limit: number }
/** Operator-attested facts. This closes execution; it never approves or retries a tool. */
export interface RunCheckpointReconcile extends RunCheckpointKey {
  readonly scope: string; readonly expectedVersion: number; readonly expectedHolderId: string;
  readonly commandId: string; readonly actorId: string; readonly reviewDigest: string;
  readonly effect: 'not_started' | 'succeeded' | 'failed' | 'unknown'; readonly evidenceRef: string;
  readonly workerStopped: true;
}
export interface RunCheckpointStore {
  initialize(): Promise<void>;
  put(command: RunCheckpointPut): Promise<RunCheckpoint>;
  get(command: RunCheckpointKey): Promise<RunCheckpoint | undefined>;
  claim(command: RunCheckpointClaim): Promise<RunCheckpoint>;
  update(command: RunCheckpointUpdate): Promise<RunCheckpoint>;
  delete(command: RunCheckpointDelete): Promise<boolean>;
  /** Atomically fence an expired claimed checkpoint and retain an immutable reconciliation receipt. */
  reconcile(command: RunCheckpointReconcile): Promise<RunCheckpoint>;
  /** Administrative bounded discovery, including completion journals and claimed checkpoints. No bodies are returned. */
  scan(command: RunCheckpointScan): Promise<readonly RunCheckpointCursor[]>;
  due(command: RunCheckpointDue): Promise<readonly string[]>;
}

export interface ConversationAggregateStore extends AggregateStore {
  readonly threads: ThreadStore;
  readonly runCheckpoints: RunCheckpointStore;
}
export type ThreadMethod = keyof ThreadStore;
export type RunCheckpointMethod = keyof RunCheckpointStore;

/** Bounds shared by every store. */
export const THREAD_LIMITS = Object.freeze({
  entriesPerAppend: 64, entryBytes: 262_144, appendBytes: 1_048_576, metadataBytes: 2_048, titleChars: 256,
  listLimit: 100, entriesLimit: 500, deleteLimit: 500, expireLimit: 100, maxLeaseMs: 3_600_000, maxSequence: 1_000_000_000,
});
// 3 MiB keeps a checkpoint and its index inside one DynamoDB transaction (4 MB), above the runtime's 2 MiB default context.
export const CHECKPOINT_LIMITS = Object.freeze({ bodyBytes: 3_145_728, partBytes: 262_144, dueLimit: 100, maxLeaseMs: 3_600_000 });

const kinds = new Set<ThreadEntryKind>(['user', 'assistant', 'tool_calls', 'tool_result', 'approval', 'summary', 'run']);
const threadMethods = new Set<ThreadMethod>(['initialize', 'create', 'get', 'list', 'update', 'acquire', 'renew', 'release', 'append', 'entries', 'delete', 'expire', 'recording', 'compaction']);
const checkpointMethods = new Set<RunCheckpointMethod>(['initialize', 'put', 'get', 'claim', 'update', 'delete', 'due', 'scan', 'reconcile']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const cursorPattern = /^[0-9]{1,16}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const encoder = new TextEncoder();

function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded conversation storage input.'); }
function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored conversation data failed integrity validation.'); }
function tooLarge(): never { throw new StorageError('LIMIT_EXCEEDED', 'Conversation data is larger than the store allows.'); }
function object(value: unknown): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as JsonObject; }
function fields(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  for (const name of required) if (!Object.hasOwn(value, name)) invalid();
  for (const name of Object.keys(value)) if (!required.includes(name) && !optional.includes(name)) invalid();
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value;
}
function id(value: unknown): string { if (typeof value !== 'string' || !identifierPattern.test(value)) invalid(); return value; }
/** A scope: any string a host derives, up to 256 UTF-8 bytes, without NUL or unpaired surrogates (keys must not alias). */
function scope(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value) || encoder.encode(value).length > 256) invalid();
  return value;
}
function bytes(value: JsonValue): number { return encoder.encode(JSON.stringify(value)).length; }
function metadata(value: unknown): JsonObject {
  const result = object(value);
  if (bytes(result) > THREAD_LIMITS.metadataBytes) tooLarge();
  return result;
}
function title(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.length || [...value].length > THREAD_LIMITS.titleChars || /[\u0000-\u001F]/u.test(value)) invalid();
  return value;
}
function capture(raw: unknown, maxBytes: number): JsonObject {
  try { return object(jsonValue(raw, { maxBytes, maxNodes: 200_000, maxDepth: 48 })); }
  catch (error) { if (error instanceof StorageError) throw error; return tooLarge(); }
}
function immutable<T>(value: JsonValue): T { return freezeJson(value) as unknown as T; }
function lease(value: JsonObject): void {
  fields(value, ['scope', 'id', 'runId', 'holderId', 'leaseMs']); scope(value['scope']); id(value['id']); id(value['runId']); id(value['holderId']);
  integer(value['leaseMs'], 1_000, THREAD_LIMITS.maxLeaseMs);
}
function entryInput(raw: unknown): ThreadEntryInput {
  const value = object(raw); fields(value, ['kind', 'data']);
  if (!kinds.has(value['kind'] as ThreadEntryKind)) invalid();
  if (bytes(object(value['data'])) > THREAD_LIMITS.entryBytes) tooLarge();
  return value as unknown as ThreadEntryInput;
}

/** An owned, bounded snapshot of a thread command, taken before any asynchronous transport. */
export function threadCommand(method: ThreadMethod, raw: unknown): JsonObject {
  if (!threadMethods.has(method)) invalid();
  const value = capture(raw, method === 'compaction' ? THREAD_LIMITS.entryBytes + 65_536 : method === 'recording' ? CHECKPOINT_LIMITS.bodyBytes + 65_536 : method === 'append' ? THREAD_LIMITS.appendBytes + 65_536 : 65_536);
  switch (method) {
    case 'compaction': {
      const base = ['scope', 'id', 'commandId', 'action']; scope(value['scope']); id(value['id']); id(value['commandId']);
      if (value['action'] === 'reserve') {
        fields(value, [...base, 'requestDigest', 'sourceDigest', 'through', 'expectedSequence', 'sourceEntries', 'sourceTurns', 'maxCostMicros', 'executorId', 'agentId', 'agentVersion', 'leaseMs']);
        for (const key of ['requestDigest', 'sourceDigest']) if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[key] as string)) invalid();
        integer(value['through'], 1, THREAD_LIMITS.maxSequence); integer(value['expectedSequence'], value['through'] as number, THREAD_LIMITS.maxSequence - 3);
        integer(value['sourceEntries'], 1, 10_000); integer(value['sourceTurns'], 1, THREAD_LIMITS.maxSequence); integer(value['maxCostMicros']);
        for (const key of ['executorId', 'agentId', 'agentVersion']) id(value[key]); integer(value['leaseMs'], 1_000, THREAD_LIMITS.maxLeaseMs);
      } else if (value['action'] === 'stage') {
        fields(value, [...base, 'executorId', 'content', 'modelRunId', 'costMicros']); id(value['executorId']); id(value['modelRunId']);
        if (typeof value['content'] !== 'string' || !value['content'].trim() || bytes(value['content']) > 65_536) invalid();
        if (typeof value['costMicros'] === 'string') { if (!/^[0-9]{1,30}$/u.test(value['costMicros'])) invalid(); }
        else integer(value['costMicros']);
      } else if (value['action'] === 'fail') {
        fields(value, [...base, 'executorId', 'code']); id(value['executorId']); id(value['code']);
      } else { fields(value, base); if (value['action'] !== 'read' && value['action'] !== 'commit') invalid(); }
      break;
    }
    case 'recording':
      if (value['action'] === 'save') {
        fields(value, ['scope', 'id', 'runtimeRunId', 'action', 'turnId', 'startSequence', 'body']);
        id(value['turnId']); integer(value['startSequence'], 0, THREAD_LIMITS.maxSequence);
        if (bytes(object(value['body'])) > CHECKPOINT_LIMITS.bodyBytes) tooLarge();
      } else {
        fields(value, ['scope', 'id', 'runtimeRunId', 'action']);
        if (value['action'] !== 'read' && value['action'] !== 'delete') invalid();
      }
      scope(value['scope']); id(value['id']); id(value['runtimeRunId']); break;
    case 'initialize': fields(value, []); break;
    case 'create': fields(value, ['scope', 'id', 'agentId', 'title', 'metadata']); scope(value['scope']); id(value['id']);
      if (value['agentId'] !== null) id(value['agentId']); title(value['title']); metadata(value['metadata']); break;
    case 'get': fields(value, ['scope', 'id']); scope(value['scope']); id(value['id']); break;
    case 'list': {
      if (!Object.hasOwn(value, 'statuses')) value['statuses'] = ['active', 'archived'];
      fields(value, ['scope', 'statuses', 'limit'], ['before']); scope(value['scope']); integer(value['limit'], 1, THREAD_LIMITS.listLimit);
      const statuses = value['statuses'];
      if (!Array.isArray(statuses) || !statuses.length || statuses.length > 2 || new Set(statuses).size !== statuses.length
        || statuses.some(status => status !== 'active' && status !== 'archived')) invalid();
      if (Object.hasOwn(value, 'before') && (typeof value['before'] !== 'string' || !cursorPattern.test(value['before']))) invalid();
      break;
    }
    case 'update':
      fields(value, ['scope', 'id', 'expectedVersion'], ['title', 'metadata', 'status']); scope(value['scope']); id(value['id']); integer(value['expectedVersion'], 1);
      if (Object.hasOwn(value, 'title')) title(value['title']);
      if (Object.hasOwn(value, 'metadata')) metadata(value['metadata']);
      if (Object.hasOwn(value, 'status') && value['status'] !== 'active' && value['status'] !== 'archived') invalid();
      if (!['title', 'metadata', 'status'].some(name => Object.hasOwn(value, name))) invalid();
      break;
    case 'acquire': case 'renew': lease(value); break;
    case 'release': fields(value, ['scope', 'id', 'runId', 'holderId']); scope(value['scope']); id(value['id']); id(value['runId']); id(value['holderId']); break;
    case 'append': {
      fields(value, ['scope', 'id', 'runId', 'holderId', 'expectedSequence', 'entries']); scope(value['scope']); id(value['id']); id(value['runId']); id(value['holderId']);
      integer(value['expectedSequence'], 0, THREAD_LIMITS.maxSequence);
      const entries = value['entries'];
      if (!Array.isArray(entries) || !entries.length || entries.length > THREAD_LIMITS.entriesPerAppend) invalid();
      entries.forEach(entryInput);
      if (bytes(entries) > THREAD_LIMITS.appendBytes) tooLarge();
      break;
    }
    case 'entries':
      fields(value, ['scope', 'id', 'limit'], ['after', 'before']); scope(value['scope']); id(value['id']); integer(value['limit'], 1, THREAD_LIMITS.entriesLimit);
      if (Object.hasOwn(value, 'after')) integer(value['after'], 0, THREAD_LIMITS.maxSequence);
      if (Object.hasOwn(value, 'before')) integer(value['before'], 1, THREAD_LIMITS.maxSequence + 1);
      if (Object.hasOwn(value, 'after') && Object.hasOwn(value, 'before')) invalid();
      break;
    case 'delete': fields(value, ['scope', 'id', 'limit']); scope(value['scope']); id(value['id']); integer(value['limit'], 1, THREAD_LIMITS.deleteLimit); break;
    case 'expire': fields(value, ['idleBeforeMs', 'limit']); integer(value['idleBeforeMs'], 0); integer(value['limit'], 1, THREAD_LIMITS.expireLimit); break;
  }
  return immutable(value);
}

/** A thread record as a store returns it, checked against the command that asked for it. */
export function threadRecord(raw: unknown, key?: ThreadKey): ThreadRecord {
  try {
    const value = object(raw);
    fields(value, ['scope', 'id', 'version', 'status', 'agentId', 'title', 'metadata', 'createdAtMs', 'updatedAtMs', 'entryCount', 'lastSequence', 'lease']);
    scope(value['scope']); id(value['id']); integer(value['version'], 1); integer(value['createdAtMs']); integer(value['updatedAtMs']);
    integer(value['entryCount'], 0, THREAD_LIMITS.maxSequence); integer(value['lastSequence'], 0, THREAD_LIMITS.maxSequence);
    if ((value['updatedAtMs'] as number) < (value['createdAtMs'] as number) || (value['entryCount'] as number) > (value['lastSequence'] as number)) invalid();
    if (key && (value['scope'] !== key.scope || value['id'] !== key.id)) invalid();
    const status = value['status'];
    if (!['active', 'archived', 'deleting', 'deleted'].includes(status as string)) invalid();
    const tombstone = status === 'deleting' || status === 'deleted';
    if (tombstone) {
      if (value['agentId'] !== null || value['title'] !== null || Object.keys(object(value['metadata'])).length || value['lease'] !== null) invalid();
      if (status === 'deleted' && value['entryCount'] !== 0) invalid();
    } else {
      if (value['agentId'] !== null) id(value['agentId']); title(value['title']); metadata(value['metadata']);
      if (value['lease'] !== null) {
        const held = object(value['lease']); fields(held, ['runId', 'holderId', 'expiresAtMs']); id(held['runId']); id(held['holderId']); integer(held['expiresAtMs']);
      }
    }
    return value as unknown as ThreadRecord;
  } catch { return corrupt(); }
}
function threadEntry(raw: unknown): ThreadEntry {
  const value = object(raw); fields(value, ['sequence', 'runId', 'kind', 'data', 'createdAtMs']);
  integer(value['sequence'], 1, THREAD_LIMITS.maxSequence); id(value['runId']); integer(value['createdAtMs']);
  entryInput({ kind: value['kind'], data: value['data'] });
  return value as unknown as ThreadEntry;
}

/** Validate a thread store's reply independently of the adapter: ownership, order and the transition asked for. */
export function threadResult<M extends ThreadMethod>(method: M, raw: unknown, context: unknown): Awaited<ReturnType<ThreadStore[M]>> {
  const command = threadCommand(method, context);
  type R = Awaited<ReturnType<ThreadStore[M]>>;
  try {
    const key = { scope: command['scope'] as string, id: command['id'] as string };
    switch (method) {
      case 'compaction': {
        if (raw === undefined) { if (command['action'] !== 'read') invalid(); return undefined as R; }
        const result = object(raw);
        fields(result, ['format', 'threadId', 'commandId', 'requestDigest', 'sourceDigest', 'covers', 'sourceEntries', 'sourceTurns', 'maxCostMicros', 'snapshotSequence',
          'executorId', 'agentId', 'agentVersion', 'status', 'content', 'modelRunId', 'costMicros', 'errorCode', 'entrySequence', 'committedAtMs']);
        if (result['format'] !== 1 || result['threadId'] !== command['id'] || result['commandId'] !== command['commandId']) invalid();
        const reserve = { scope: command['scope'], id: command['id'], commandId: command['commandId'], action: 'reserve',
          requestDigest: result['requestDigest'], sourceDigest: result['sourceDigest'], through: object(result['covers'])['to'], expectedSequence: result['snapshotSequence'],
          sourceEntries: result['sourceEntries'], sourceTurns: result['sourceTurns'], maxCostMicros: result['maxCostMicros'], executorId: result['executorId'], agentId: result['agentId'], agentVersion: result['agentVersion'], leaseMs: 1000 };
        threadCommand('compaction', reserve); fields(object(result['covers']), ['from', 'to']); if (object(result['covers'])['from'] !== 1) invalid();
        if (!['pending', 'ready', 'committed', 'failed'].includes(result['status'] as string)) invalid();
        if (result['content'] !== null) threadCommand('compaction', { scope: command['scope'], id: command['id'], commandId: command['commandId'], action: 'stage',
          executorId: result['executorId'], content: result['content'], modelRunId: result['modelRunId'], costMicros: result['costMicros'] });
        else if (result['modelRunId'] !== null || result['costMicros'] !== null || ['ready', 'committed'].includes(result['status'] as string)) invalid();
        if (result['errorCode'] !== null) id(result['errorCode']);
        if ((result['status'] === 'failed') !== (result['errorCode'] !== null)) invalid();
        if (result['status'] === 'committed') { integer(result['entrySequence'], (result['snapshotSequence'] as number) + 2); integer(result['committedAtMs']); }
        else if (result['entrySequence'] !== null || result['committedAtMs'] !== null) invalid();
        if (command['action'] === 'reserve' && ['requestDigest', 'sourceDigest', 'sourceEntries', 'sourceTurns', 'maxCostMicros', 'agentId', 'agentVersion'].some(key => result[key] !== command[key])) invalid();
        if (command['action'] === 'stage' && (!['ready', 'committed'].includes(result['status'] as string)
          || ['executorId', 'content', 'modelRunId', 'costMicros'].some(key => result[key] !== command[key]))) invalid();
        if (command['action'] === 'fail' && (!['failed', 'committed'].includes(result['status'] as string) || result['executorId'] !== command['executorId'])) invalid();
        if (command['action'] === 'commit' && result['status'] !== 'committed') invalid();
        return immutable(result) as R;
      }
      case 'recording': {
        if (raw === undefined) { if (command['action'] === 'save') invalid(); return undefined as R; }
        const body = capture(raw, CHECKPOINT_LIMITS.bodyBytes);
        if (command['action'] === 'save' && JSON.stringify(body) !== JSON.stringify(command['body'])) invalid();
        return immutable(body) as R;
      }
      case 'initialize': if (raw !== undefined) invalid(); return undefined as R;
      case 'get': return (raw === undefined ? undefined : immutable(threadRecord(raw, key) as unknown as JsonValue)) as R;
      case 'create': {
        const value = object(raw); fields(value, ['thread', 'created']); if (typeof value['created'] !== 'boolean') invalid();
        const thread = threadRecord(value['thread'], key);
        if (thread.status === 'deleting' || thread.status === 'deleted') invalid();
        if (value['created'] && (thread.version !== 1 || thread.lastSequence !== 0 || thread.status !== 'active' || thread.agentId !== command['agentId']
          || thread.title !== command['title'] || JSON.stringify(thread.metadata) !== JSON.stringify(command['metadata']))) invalid();
        return immutable(value) as R;
      }
      case 'list': {
        const value = object(raw); fields(value, ['threads', 'cursor']);
        const threads = value['threads']; if (!Array.isArray(threads) || threads.length > (command['limit'] as number)) invalid();
        const statuses = command['statuses'] as string[]; let previous: [number, string] | undefined;
        for (const item of threads) {
          const thread = threadRecord(item); if (thread.scope !== command['scope'] || !statuses.includes(thread.status)) invalid();
          if (previous && (thread.updatedAtMs > previous[0] || (thread.updatedAtMs === previous[0] && thread.id >= previous[1]))) invalid();
          previous = [thread.updatedAtMs, thread.id];
        }
        if (value['cursor'] !== null && (typeof value['cursor'] !== 'string' || !cursorPattern.test(value['cursor']) || threads.length !== command['limit'])) invalid();
        return immutable(value) as R;
      }
      case 'update': {
        const thread = threadRecord(raw, key);
        if (thread.version !== (command['expectedVersion'] as number) + 1 || thread.status === 'deleting' || thread.status === 'deleted') invalid();
        if (Object.hasOwn(command, 'status') && thread.status !== command['status']) invalid();
        if (Object.hasOwn(command, 'title') && thread.title !== command['title']) invalid();
        if (Object.hasOwn(command, 'metadata') && JSON.stringify(thread.metadata) !== JSON.stringify(command['metadata'])) invalid();
        return immutable(thread as unknown as JsonValue) as R;
      }
      case 'acquire': case 'renew': {
        const thread = threadRecord(raw, key);
        if (!thread.lease || thread.lease.runId !== command['runId'] || thread.lease.holderId !== command['holderId']) invalid();
        return immutable(thread as unknown as JsonValue) as R;
      }
      case 'release': {
        const thread = threadRecord(raw, key); if (thread.lease !== null && thread.lease.runId === command['runId'] && thread.lease.holderId === command['holderId']) invalid();
        return immutable(thread as unknown as JsonValue) as R;
      }
      case 'append': {
        const value = object(raw); fields(value, ['thread', 'entries']); const thread = threadRecord(value['thread'], key);
        const stored = value['entries']; const asked = command['entries'] as unknown as ThreadEntryInput[];
        if (!Array.isArray(stored) || stored.length !== asked.length) invalid();
        stored.forEach((item, index) => {
          const entry = threadEntry(item);
          if (entry.sequence !== (command['expectedSequence'] as number) + index + 1 || entry.runId !== command['runId'] || entry.kind !== asked[index]!.kind
            || JSON.stringify(entry.data) !== JSON.stringify(asked[index]!.data)) invalid();
        });
        if (thread.lastSequence !== (command['expectedSequence'] as number) + asked.length) invalid();
        return immutable(value) as R;
      }
      case 'entries': {
        if (!Array.isArray(raw) || raw.length > (command['limit'] as number)) invalid();
        let previous = 0;
        for (const item of raw) {
          const entry = threadEntry(item); if (entry.sequence <= previous) invalid(); previous = entry.sequence;
          if (Object.hasOwn(command, 'after') && entry.sequence <= (command['after'] as number)) invalid();
          if (Object.hasOwn(command, 'before') && entry.sequence >= (command['before'] as number)) invalid();
        }
        return immutable(raw as JsonValue) as R;
      }
      case 'delete': {
        const value = object(raw); fields(value, ['thread', 'removed']); const thread = threadRecord(value['thread'], key);
        if (thread.status !== 'deleting' && thread.status !== 'deleted') invalid(); integer(value['removed'], 0, command['limit'] as number);
        return immutable(value) as R;
      }
      case 'expire': {
        if (!Array.isArray(raw) || raw.length > (command['limit'] as number)) invalid();
        for (const item of raw) { const value = object(item); fields(value, ['scope', 'id']); scope(value['scope']); id(value['id']); }
        return immutable(raw as JsonValue) as R;
      }
    }
    return invalid();
  } catch { return corrupt(); }
}

/** An owned, bounded snapshot of a checkpoint command, taken before any asynchronous transport. */
export function runCheckpointCommand(method: RunCheckpointMethod, raw: unknown): JsonObject {
  if (!checkpointMethods.has(method)) invalid();
  const value = capture(raw, method === 'put' || method === 'update' ? CHECKPOINT_LIMITS.bodyBytes + 65_536 : 65_536);
  const body = () => { if (bytes(object(value['body'])) > CHECKPOINT_LIMITS.bodyBytes) tooLarge(); };
  switch (method) {
    case 'initialize': fields(value, []); break;
    case 'put': fields(value, ['runId', 'scope', 'expiresAtMs', 'body']); id(value['runId']); scope(value['scope']); integer(value['expiresAtMs'], 1); body(); break;
    case 'reconcile':
      fields(value, ['runId', 'scope', 'expectedVersion', 'expectedHolderId', 'commandId', 'actorId', 'reviewDigest', 'effect', 'evidenceRef', 'workerStopped']);
      id(value['runId']); scope(value['scope']); integer(value['expectedVersion'], 1); id(value['expectedHolderId']); id(value['commandId']);
      id(value['actorId']); id(value['evidenceRef']);
      if (typeof value['reviewDigest'] !== 'string' || !/^[a-f0-9]{64}$/u.test(value['reviewDigest'])
        || !['not_started', 'succeeded', 'failed', 'unknown'].includes(value['effect'] as string) || value['workerStopped'] !== true) invalid();
      break;
    case 'get': fields(value, ['runId']); id(value['runId']); break;
    case 'claim':
      fields(value, ['runId', 'holderId', 'leaseMs'], ['expectedDigest']); id(value['runId']); id(value['holderId']); integer(value['leaseMs'], 1_000, CHECKPOINT_LIMITS.maxLeaseMs);
      if (value['expectedDigest'] !== undefined && (typeof value['expectedDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['expectedDigest']))) invalid();
      break;
    case 'update':
      fields(value, ['runId', 'holderId', 'expectedVersion', 'body', 'status']); id(value['runId']); id(value['holderId']); integer(value['expectedVersion'], 1);
      if (value['status'] !== 'waiting' && value['status'] !== 'claimed') invalid(); body(); break;
    case 'delete':
      fields(value, ['runId'], ['holderId', 'expectedVersion', 'expectedDigest']); id(value['runId']); if (Object.hasOwn(value, 'holderId')) id(value['holderId']);
      if (value['expectedVersion'] !== undefined || value['expectedDigest'] !== undefined) {
        id(value['holderId']); integer(value['expectedVersion'], 1);
        if (typeof value['expectedDigest'] !== 'string' || !/^[a-f0-9]{64}$/u.test(value['expectedDigest'])) invalid();
      }
      break;
    case 'scan': {
      fields(value, ['limit'], ['after']); integer(value['limit'], 1, CHECKPOINT_LIMITS.dueLimit);
      if (value['after'] !== undefined) { const after = object(value['after']); fields(after, ['expiresAtMs', 'runId']); integer(after['expiresAtMs'], 1); id(after['runId']); }
      break;
    }
    case 'due': fields(value, ['expiresBeforeMs', 'limit']); integer(value['expiresBeforeMs'], 0); integer(value['limit'], 1, CHECKPOINT_LIMITS.dueLimit); break;
  }
  return immutable(value);
}

/** A checkpoint as a store returns it. */
export function runCheckpointRecord(raw: unknown, runId?: string): RunCheckpoint {
  try {
    const value = object(raw);
    fields(value, ['runId', 'scope', 'version', 'status', 'holderId', 'leaseExpiresAtMs', 'createdAtMs', 'updatedAtMs', 'expiresAtMs', 'body']);
    id(value['runId']); scope(value['scope']); integer(value['version'], 1); integer(value['createdAtMs']); integer(value['updatedAtMs']); integer(value['expiresAtMs'], 1);
    if (runId !== undefined && value['runId'] !== runId) invalid();
    if (value['status'] === 'waiting') { if (value['holderId'] !== null || value['leaseExpiresAtMs'] !== null) invalid(); }
    else if (value['status'] === 'claimed') { id(value['holderId']); integer(value['leaseExpiresAtMs']); }
    else invalid();
    if (bytes(object(value['body'])) > CHECKPOINT_LIMITS.bodyBytes) invalid();
    return value as unknown as RunCheckpoint;
  } catch { return corrupt(); }
}

/** Validate a checkpoint store's reply independently of the adapter. */
export function runCheckpointResult<M extends RunCheckpointMethod>(method: M, raw: unknown, context: unknown): Awaited<ReturnType<RunCheckpointStore[M]>> {
  const command = runCheckpointCommand(method, context);
  type R = Awaited<ReturnType<RunCheckpointStore[M]>>;
  try {
    const runId = command['runId'] as string;
    switch (method) {
      case 'initialize': if (raw !== undefined) invalid(); return undefined as R;
      case 'get': return (raw === undefined ? undefined : immutable(runCheckpointRecord(raw, runId) as unknown as JsonValue)) as R;
      case 'put': {
        const checkpoint = runCheckpointRecord(raw, runId);
        if (checkpoint.version !== 1 || checkpoint.status !== 'waiting' || checkpoint.scope !== command['scope'] || checkpoint.expiresAtMs !== command['expiresAtMs']
          || JSON.stringify(checkpoint.body) !== JSON.stringify(command['body'])) invalid();
        return immutable(checkpoint as unknown as JsonValue) as R;
      }
      case 'reconcile': {
        const checkpoint = runCheckpointRecord(raw, runId); const receipt = object(checkpoint.body['reconciliation']);
        if (checkpoint.status !== 'claimed' || checkpoint.scope !== command['scope'] || checkpoint.version !== (command['expectedVersion'] as number) + 1
          || checkpoint.holderId === command['expectedHolderId'] || receipt['format'] !== 1 || !Number.isSafeInteger(receipt['reconciledAtMs'])
          || ['expectedVersion', 'expectedHolderId', 'commandId', 'actorId', 'reviewDigest', 'effect', 'evidenceRef', 'workerStopped'].some(key => receipt[key] !== command[key])) invalid();
        return immutable(checkpoint as unknown as JsonValue) as R;
      }
      case 'claim': {
        const checkpoint = runCheckpointRecord(raw, runId); if (checkpoint.status !== 'claimed' || checkpoint.holderId !== command['holderId']) invalid();
        return immutable(checkpoint as unknown as JsonValue) as R;
      }
      case 'update': {
        const checkpoint = runCheckpointRecord(raw, runId);
        if (checkpoint.version !== (command['expectedVersion'] as number) + 1 || checkpoint.status !== command['status']
          || JSON.stringify(checkpoint.body) !== JSON.stringify(command['body'])) invalid();
        if (checkpoint.status === 'claimed' && checkpoint.holderId !== command['holderId']) invalid();
        return immutable(checkpoint as unknown as JsonValue) as R;
      }
      case 'delete': if (typeof raw !== 'boolean') invalid(); return raw as R;
      case 'scan': {
        if (!Array.isArray(raw) || raw.length > (command['limit'] as number)) invalid();
        let previous = command['after'] as unknown as RunCheckpointCursor | undefined;
        for (const item of raw) { const cursor = object(item); fields(cursor, ['expiresAtMs', 'runId']); integer(cursor['expiresAtMs'], 1); id(cursor['runId']);
          const next = cursor as unknown as RunCheckpointCursor;
          if (previous && (next.expiresAtMs < previous.expiresAtMs || (next.expiresAtMs === previous.expiresAtMs && next.runId <= previous.runId))) invalid(); previous = next;
        }
        return immutable(raw as JsonValue) as R;
      }
      case 'due': {
        if (!Array.isArray(raw) || raw.length > (command['limit'] as number) || new Set(raw).size !== raw.length) invalid();
        raw.forEach(id); return immutable(raw as JsonValue) as R;
      }
    }
    return invalid();
  } catch { return corrupt(); }
}

/** Own commands before await or IPC; validate every reply. Adapters wrap their implementation in these. */
export function threadFacade(request: (method: ThreadMethod, input: JsonObject) => Promise<unknown>): ThreadStore {
  // Each method's type comes from ThreadStore; `call` checks the command and the reply at run time.
  const call = async (method: ThreadMethod, value: unknown): Promise<never> => {
    const command = threadCommand(method, value);
    return threadResult(method, await request(method, command), command) as never;
  };
  return Object.freeze({
    initialize: () => call('initialize', {}), compaction: value => call('compaction', value), create: value => call('create', value), get: value => call('get', value), list: value => call('list', value),
    update: value => call('update', value), acquire: value => call('acquire', value), renew: value => call('renew', value), release: value => call('release', value),
    append: value => call('append', value), entries: value => call('entries', value), delete: value => call('delete', value), expire: value => call('expire', value), recording: value => call('recording', value),
  } satisfies ThreadStore);
}
export function runCheckpointFacade(request: (method: RunCheckpointMethod, input: JsonObject) => Promise<unknown>): RunCheckpointStore {
  const call = async (method: RunCheckpointMethod, value: unknown): Promise<never> => {
    const command = runCheckpointCommand(method, value);
    return runCheckpointResult(method, await request(method, command), command) as never;
  };
  return Object.freeze({
    initialize: () => call('initialize', {}), put: value => call('put', value), get: value => call('get', value), claim: value => call('claim', value),
    update: value => call('update', value), delete: value => call('delete', value), due: value => call('due', value), scan: value => call('scan', value), reconcile: value => call('reconcile', value),
  } satisfies RunCheckpointStore);
}
