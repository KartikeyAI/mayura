import { mediaReferences, readMediaReferences, type ThreadMediaReference } from './media.js';
export type { ThreadMediaReference } from './media.js';
import { threadAuthorization, type ThreadAuthorization } from './authorization.js';
import { compactThread, cancelThreadCompaction, type ThreadCompactionOptions, type ThreadCompactionResult, type ThreadCompactionCancellation } from './compaction.js';
export type { ThreadCompactionOptions, ThreadCompactionResult, ThreadCompactionCancellation } from './compaction.js';
import { readThreadWindow, fitThreadHistory } from './history.js';
import { jsonValue, MayuraError, type Authorizer, type InferInput, type InferOutput, type JsonObject, type JsonValue, type ModelHistoryMessage, type ModelMessage, type Outcome, type RunHandle, type Schema, type Scope } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { StorageError, THREAD_LIMITS, type ThreadEntry as StoredEntry, type ThreadEntryInput, type ThreadRecord, type ThreadStore } from '@mayura/storage-contracts';
import type { AgentDefinition, Runtime, RunRecorder, RunRecordingContext, RunRecording } from '@mayura/runtime';

/** A conversation that belongs to one scope. */
export interface Thread {
  readonly id: string;
  /** The agent the thread talks to, when fixed; `runInThread` refuses another agent. */
  readonly agentId: string | null;
  readonly title: string | null;
  readonly metadata: JsonObject;
  /** `deleting` and `deleted` are tombstones: their content is gone, and the id is never reused. */
  readonly status: 'active' | 'archived' | 'deleting' | 'deleted';
  /** Changes on every update and append; pass it as `expectedVersion` to update only what you read. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entryCount: number;
  readonly lastSequence: number;
  /** The turn writing to the thread now, if any: one at a time. */
  readonly activeTurnId: string | null;
}
/** What one entry of a thread records. A turn is one run: its input, calls, results, approvals, output and outcome. */
export type ThreadEntryData =
  | { readonly kind: 'user'; readonly content: JsonValue; readonly mediaOmitted?: number; readonly media?: readonly ThreadMediaReference[]; readonly omitted?: 'too_large' }
  | { readonly kind: 'assistant'; readonly output: JsonValue; readonly omitted?: 'too_large' }
  | { readonly kind: 'tool_calls'; readonly calls: readonly { readonly id: string; readonly toolId: string; readonly input: JsonValue }[] }
  | { readonly kind: 'tool_result'; readonly callId: string; readonly toolId: string; readonly result: JsonValue; readonly mediaOmitted?: number; readonly media?: readonly ThreadMediaReference[]; readonly omitted?: 'too_large' }
  | { readonly kind: 'approval'; readonly callId: string; readonly toolId: string; readonly decision: 'approved' | 'rejected' | 'expired'; readonly actorId?: string }
  | { readonly kind: 'run'; readonly runId: string; readonly status: Outcome<unknown>['status'] | 'running'; readonly errorCode?: string; readonly reconciliation?: JsonObject; readonly imported?: { readonly commandId: string; readonly digest: string }; readonly compaction?: { readonly format: 1; readonly commandId: string } }
  | { readonly kind: 'summary'; readonly content: string; readonly covers: { readonly from: number; readonly to: number }; readonly compaction?: ThreadSummaryProvenance };
/** Provenance for a generated summary; the source entries remain in storage. */
export interface ThreadSummaryProvenance {
  readonly format: 1; readonly commandId: string; readonly requestDigest: string; readonly sourceDigest: string;
  readonly sourceEntries: number; readonly sourceTurns: number; readonly agentId: string; readonly agentVersion: string;
  readonly modelRunId: string; readonly costMicros: number | string;
}
export type ThreadEntry = ThreadEntryData & { readonly sequence: number; readonly turnId: string; readonly createdAt: string };
/** How much of a thread to send as a run's history: the newest whole turns that fit. */
export interface HistoryPolicy {
  /** Include the newest verified compaction covering the largest prefix (default true); no model is called. */
  readonly useSummaries?: boolean;
  /** Bounded history discovery (defaults: 10,000 entries and 8 MiB of stored JSON). */
  readonly maxScanEntries?: number;
  readonly maxScanBytes?: number;
  /** Most messages (default 200, at most 2048). */
  readonly maxEntries?: number;
  /** Most bytes of history JSON (default 512 KiB, at most 2 MiB). It counts toward the run's `maxContextBytes`. */
  readonly maxBytes?: number;
}
export interface ThreadHistory {
  /** Oldest first, ready for `runtime.submit(agent, { input, history })`. */
  readonly messages: readonly ModelHistoryMessage[];
  /** Turns included. */
  readonly turns: number;
  /** Earlier succeeded turns left out because they did not fit. */
  readonly omittedTurns: number;
  readonly bytes: number;
  /** True when older entries lay outside the bounded discovery window. */
  readonly scanTruncated?: boolean;
  readonly summary?: { readonly sequence: number; readonly covers: { readonly from: number; readonly to: number }; readonly turns: number; readonly sourceDigest: string };
}
export interface ThreadsOptions {
  /** Shared host-owned core authorizer; this service never closes it or creates a separate audit queue. */
  readonly authorization?: Authorizer;
  /** Optional lifetime/request cancellation for this scoped service. */
  readonly signal?: AbortSignal;
  /** A Mayura store with threads (call `await store.threads.initialize()` once). */
  readonly store: { readonly threads: ThreadStore };
  /** Whose threads: from your verified identity, never from model output. */
  readonly scope: Scope;
  /** `thread:read`, `thread:write` and `thread:delete`, as needed. Nothing is allowed by default. */
  readonly permissions: { readonly allow: readonly string[] };
}
/** A bounded, atomic, explicitly imported conversation turn. No synthetic tool approvals or run execution. */
export interface ThreadAppendInput {
  readonly commandId: string; readonly expectedSequence: number;
  readonly messages: readonly ({ readonly role: 'user'; readonly content: JsonValue; readonly media?: readonly ThreadMediaReference[] }
    | { readonly role: 'assistant'; readonly output: JsonValue })[];
}
export interface Threads {
  readonly scope: Scope;
  /** Configure as runtime.recorder on every replica that runs or resumes turns. */
  readonly recorder: RunRecorder;
  /** Finish a persisted terminal recording after a crash, without executing the run again. Returns false if none is pending. */
  recoverRun(threadId: string, runId: string): Promise<boolean>;
  /** Create a thread (`thread:write`). An id you choose makes it idempotent: the existing thread is returned. */
  create(input?: { readonly id?: string; readonly agentId?: string; readonly title?: string; readonly metadata?: JsonObject }): Promise<Thread>;
  /** A thread of this scope, or undefined (`thread:read`). */
  get(id: string): Promise<Thread | undefined>;
  /** This scope's threads, most recently updated first, page by page (`thread:read`). */
  list(options?: { readonly status?: 'active' | 'archived' | 'all'; readonly cursor?: string; readonly limit?: number }): Promise<{ readonly threads: readonly Thread[]; readonly cursor: string | null }>;
  /** Change the title or metadata (`thread:write`); with `expectedVersion`, only if nothing changed since. */
  update(id: string, changes: { readonly title?: string | null; readonly metadata?: JsonObject; readonly expectedVersion?: number }): Promise<Thread>;
  archive(id: string): Promise<Thread>;
  restore(id: string): Promise<Thread>;
  /** Delete a thread and all its entries for good (`thread:delete`). Its content is unreadable at once. */
  delete(id: string): Promise<{ readonly removed: number }>;
  /** Entries in sequence order; with `before`, the newest page below it (`thread:read`). */
  entries(id: string, options?: { readonly after?: number; readonly before?: number; readonly limit?: number }): Promise<readonly ThreadEntry[]>;
  /** The newest whole turns that fit, as history for the next run (`thread:read`). Failed turns are left out. */
  history(id: string, policy?: HistoryPolicy): Promise<ThreadHistory>;
  /** Import one complete turn with thread:import + thread:write/read and core import authorization. Exact replay is idempotent. */
  append(id: string, input: ThreadAppendInput): Promise<readonly ThreadEntry[]>;
  /** Summarize a complete prefix using one explicitly budgeted model call; originals are retained. */
  compact(id: string, options: ThreadCompactionOptions): Promise<ThreadCompactionResult>;
  /** Fence an interrupted/pending command. A committed summary is never undone. */
  cancelCompaction(id: string, commandId: string): Promise<ThreadCompactionCancellation>;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MAX_SCAN = 10_000;
const encoder = new TextEncoder();
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

function storage<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof MayuraError && !(error instanceof StorageError)) throw error;
    if (error instanceof StorageError) {
      if (error.storageCode === 'STORE_NOT_INITIALIZED') throw new MayuraError('INVALID_CONFIG', 'Thread storage is not initialized: call `await store.threads.initialize()` once.');
      if (error.storageCode === 'INVALID_INPUT') throw new MayuraError('INVALID_INPUT', 'The thread storage command was rejected as invalid.');
      if (error.storageCode === 'LIMIT_EXCEEDED') throw new MayuraError('LIMIT_EXCEEDED', 'The thread data is larger than the store allows.');
      if (error.code === 'NOT_FOUND') throw new MayuraError('NOT_FOUND', 'No such thread in this scope.');
      if (error.code === 'CONFLICT') throw new MayuraError('CONFLICT', 'The thread changed meanwhile, or another run is writing to it; read it again and retry.');
    }
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Thread storage is unavailable. Check protected local diagnostics.');
  });
}
function threadId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new MayuraError('INVALID_INPUT', 'A thread id is 1–128 letters, digits, `.`, `_`, `:`, `/` or `-`, starting with a letter or digit.');
  return value;
}
function count(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) throw new MayuraError('INVALID_INPUT', `${name} must be ${minimum} to ${maximum}.`);
  return result as number;
}
function view(record: ThreadRecord): Thread {
  return Object.freeze({ id: record.id, agentId: record.agentId, title: record.title, metadata: record.metadata, status: record.status, version: record.version,
    createdAt: new Date(record.createdAtMs).toISOString(), updatedAt: new Date(record.updatedAtMs).toISOString(),
    entryCount: record.entryCount, lastSequence: record.lastSequence, activeTurnId: record.lease && record.lease.expiresAtMs > Date.now() ? record.lease.runId : null });
}
function entryView(entry: StoredEntry): ThreadEntry {
  return Object.freeze({ ...entry.data, kind: entry.kind, sequence: entry.sequence, turnId: entry.runId, createdAt: new Date(entry.createdAtMs).toISOString() }) as unknown as ThreadEntry;
}

/** What `runInThread` needs beyond the public API: the store, the scope key and the grants. */
interface Internals {
  readonly auth: ThreadAuthorization;
  readonly store: ThreadStore;
  readonly key: string;
  need(grant: string): void;
  history(id: string, policy?: HistoryPolicy): Promise<ThreadHistory>;
}
const internals = new WeakMap<Threads, Internals>();

/**
 * A scope's conversation threads over `store.threads`: create, list, read, archive and delete them, and fit their
 * newest whole turns as a run's history. Use `runInThread` to run an agent in a thread and record the turn.
 */
export function createThreads(options: ThreadsOptions): Threads {
  const store = options?.store?.threads;
  if (!store || typeof store.append !== 'function') throw new MayuraError('INVALID_CONFIG', 'Threads require a store with threads (store.threads).');
  const principalId = options.scope?.principalId; const projectId = options.scope?.projectId;
  if (typeof principalId !== 'string' || !idPattern.test(principalId) || typeof projectId !== 'string' || !idPattern.test(projectId)) {
    throw new MayuraError('INVALID_CONFIG', 'Threads require bounded principal and project identifiers.');
  }
  const scope: Scope = Object.freeze({ principalId, projectId });
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4_096) throw new MayuraError('INVALID_CONFIG', 'Thread permissions require a bounded grant list.');
  const grants = new Set(options.permissions.allow.filter(grant => typeof grant === 'string'));
  const need = (grant: string): void => { if (!grants.has(grant)) throw new MayuraError('PERMISSION_DENIED', `This needs the grant ${grant}.`); };
  // A fixed-length key, so any principal and project ids fit the store's bound; the scope itself never leaves this API.
  const authorization = options.authorization; const serviceSignal = options.signal;
  const auth = threadAuthorization(authorization, scope, serviceSignal);
  const key = sha256Hex(`mayura:thread-scope:v1\0${principalId}\0${projectId}`);
  const read = async (id: string): Promise<ThreadRecord> => {
    const record = await storage(() => store.get({ scope: key, id: threadId(id) }));
    if (!record) throw new MayuraError('NOT_FOUND', 'No such thread in this scope.');
    return record;
  };
  const change = async (id: string, update: (record: ThreadRecord) => { readonly title?: string | null; readonly metadata?: JsonObject; readonly status?: 'active' | 'archived' }, expectedVersion?: number, action = 'update'): Promise<Thread> => {
    need('thread:write'); id = threadId(id);
    await auth.require(id, action); await auth.require(id, 'read');
    for (let attempt = 0; ; attempt++) {
      const record = await read(id);
      if (record.status === 'deleting' || record.status === 'deleted') throw new MayuraError('NOT_FOUND', 'The thread was deleted.');
      if (expectedVersion !== undefined && record.version !== expectedVersion) throw new MayuraError('CONFLICT', 'The thread changed since that version.');
      await auth.require(id, action);
      try { const changed = view(await storage(() => store.update({ scope: key, id: record.id, expectedVersion: record.version, ...update(record) }))); await auth.require(id, 'read'); return changed; }
      catch (error) { if (expectedVersion !== undefined || attempt >= 2 || !(error instanceof MayuraError) || error.code !== 'CONFLICT') throw error; }
    }
  };
  const history = async (id: string, policy: HistoryPolicy = {}): Promise<ThreadHistory> => {
    need('thread:read'); id = threadId(id); policy = Object.freeze({ ...policy });
    const maxEntries = count(policy.maxEntries, 'maxEntries', 1, 2_048, 200);
    const maxBytes = count(policy.maxBytes, 'maxBytes', 1_024, 2_097_152, 524_288);
    await auth.require(id, 'read');
    const record = await read(id);
    if (record.status === 'deleting' || record.status === 'deleted') throw new MayuraError('NOT_FOUND', 'The thread was deleted.');
    const maxScanEntries = count(policy.maxScanEntries, 'maxScanEntries', 1, MAX_SCAN, MAX_SCAN);
    const maxScanBytes = count(policy.maxScanBytes, 'maxScanBytes', 1024, 16_777_216, 8_388_608);
    if (policy.useSummaries !== undefined && typeof policy.useSummaries !== 'boolean') throw new MayuraError('INVALID_INPUT', 'useSummaries must be a boolean.');
    const window = await readThreadWindow(async paging => { await auth.require(id, 'read'); return (await storage(() => store.entries({ scope: key, id: record.id, ...paging }))).map(entryView); },
      record.lastSequence, maxScanEntries, maxScanBytes);
    await auth.require(id, 'read');
    return fitThreadHistory(window.entries, { maxEntries, maxBytes, useSummaries: policy.useSummaries !== false, truncated: window.truncated });
  };
  const compactions = new Map<string, AbortController>();
  const compactContext = { store, key, scope, need, call: storage, active: compactions, auth, ...(authorization === undefined ? {} : { authorization }) };
  const recorder = createThreadRecorder(store, key, scope, need, auth);
  const threads: Threads = {
    scope, recorder, recoverRun: recorder.recover,
    create: async (input = {}) => {
      need('thread:write');
      const id = input.id === undefined ? crypto.randomUUID() : threadId(input.id);
      if (input.agentId !== undefined && (typeof input.agentId !== 'string' || !idPattern.test(input.agentId))) throw new MayuraError('INVALID_INPUT', 'agentId must be an agent id.');
      const captured = jsonValue({ agentId: input.agentId ?? null, title: input.title ?? null, metadata: input.metadata ?? {} }) as JsonObject;
      await auth.require(id, 'create'); await auth.require(id, 'read');
      const result = await storage(() => store.create({ scope: key, id, agentId: captured['agentId'] as string | null, title: captured['title'] as string | null, metadata: captured['metadata'] as JsonObject }));
      await auth.require(id, 'read'); return view(result.thread);
    },
    get: async id => {
      need('thread:read'); id = threadId(id); await auth.require(id, 'read');
      const record = await storage(() => store.get({ scope: key, id: threadId(id) }));
      await auth.require(id, 'read'); return record ? view(record) : undefined;
    },
    list: async (listing = {}) => {
      need('thread:read');
      const status = listing.status ?? 'active'; const suppliedCursor = listing.cursor;
      if (!['active', 'archived', 'all'].includes(status)) throw new MayuraError('INVALID_INPUT', "status must be 'active', 'archived' or 'all'.");
      const limit = count(listing.limit, 'limit', 1, THREAD_LIMITS.listLimit, 20);
      await auth.require('collection', 'list');
      const cursor = await auth.decode(suppliedCursor, `list:${status}`);
      const result = await storage(() => store.list({ scope: key, statuses: status === 'all' ? ['active', 'archived'] : [status], limit,
        ...(cursor === undefined ? {} : { before: cursor }) }));
      const visible: Thread[] = [];
      for (const record of result.threads) if (await auth.can(threadId(record.id), 'read')) visible.push(view(record));
      const disclosed: Thread[] = [];
      for (const item of visible) if (await auth.can(item.id, 'read')) disclosed.push(item);
      const next = await auth.encode(result.cursor, `list:${status}`);
      await auth.require('collection', 'list');
      return Object.freeze({ threads: Object.freeze(disclosed), cursor: next });
    },
    update: (id, changes) => {
      const captured = jsonValue({ ...(changes.title === undefined ? {} : { title: changes.title }), ...(changes.metadata === undefined ? {} : { metadata: changes.metadata }) }) as JsonObject;
      const expectedVersion = changes.expectedVersion;
      return change(id, () => captured as { readonly title?: string | null; readonly metadata?: JsonObject }, expectedVersion);
    },
    archive: id => change(id, () => ({ status: 'archived' }), undefined, 'archive'),
    restore: id => change(id, () => ({ status: 'active' }), undefined, 'restore'),
    delete: async id => {
      need('thread:delete'); id = threadId(id);
      let removed = 0;
      for (let page = 0; page < 100_000; page++) {
        await auth.require(id, 'delete');
        const result = await storage(() => store.delete({ scope: key, id: threadId(id), limit: THREAD_LIMITS.deleteLimit }));
        removed += result.removed;
        if (result.thread.status === 'deleted') return Object.freeze({ removed });
      }
      throw new MayuraError('LIMIT_EXCEEDED', 'The thread is still being deleted; call delete again.');
    },
    entries: async (id, paging = {}) => {
      need('thread:read'); id = threadId(id);
      const after = paging.after; const before = paging.before;
      const limit = count(paging.limit, 'limit', 1, THREAD_LIMITS.entriesLimit, 100);
      await auth.require(id, 'read');
      const page = await storage(() => store.entries({ scope: key, id, limit,
        ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) }));
      await auth.require(id, 'read'); return Object.freeze(page.map(entryView));
    },
    history,
    append: async (id, input) => {
      need('thread:write'); need('thread:read'); need('thread:import'); id = threadId(id);
      const captured = jsonValue(input, { maxBytes: THREAD_LIMITS.appendBytes, maxDepth: 32, maxNodes: 100_000 }) as unknown as ThreadAppendInput;
      if (!captured || Object.keys(captured).sort().join(',') !== 'commandId,expectedSequence,messages'
        || !Number.isSafeInteger(captured.expectedSequence) || captured.expectedSequence < 0 || captured.expectedSequence >= THREAD_LIMITS.maxSequence
        || !Array.isArray(captured.messages) || captured.messages.length < 2 || captured.messages.length > 62 || captured.messages.length % 2) throw new MayuraError('INVALID_INPUT', 'Import requires a bounded complete user/assistant turn and expected sequence.');
      threadId(captured.commandId);
      const entries: ThreadEntryInput[] = captured.messages.map((message, index) => {
        if (!message || message.role !== (index % 2 ? 'assistant' : 'user')
          || Object.keys(message).some(key => !(index % 2 ? ['role', 'output'] : ['role', 'content', 'media']).includes(key))
          || !Object.hasOwn(message, index % 2 ? 'output' : 'content')) throw new MayuraError('INVALID_INPUT', 'Imported messages must alternate user and assistant.');
        const data = message.role === 'user' ? { content: message.content, ...(message.media === undefined ? {} : { media: readMediaReferences(message.media) }) } : { output: message.output };
        if (bytesOf(data) > THREAD_LIMITS.entryBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Imported message exceeds the thread entry limit.');
        return { kind: message.role, data: jsonValue(data) as JsonObject };
      });
      const digest = sha256Hex(JSON.stringify(entries)); const turnId = `import-${sha256Hex(JSON.stringify([id, captured.commandId]))}`;
      entries.push({ kind: 'run', data: { runId: turnId, status: 'succeeded', imported: { commandId: captured.commandId, digest } } });
      if (bytesOf(entries) > THREAD_LIMITS.appendBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Imported turn exceeds the atomic append limit.');
      await auth.require(id, 'import'); await auth.require(id, 'read');
      const current = await read(id); if (current.status !== 'active') throw new MayuraError('CONFLICT', 'Import requires an active thread.');
      const receipt = async () => {
        const page = await storage(() => store.entries({ scope: key, id, after: captured.expectedSequence, limit: entries.length }));
        if (!page.length) return undefined;
        if (page.length !== entries.length || page.some((entry, index) => entry.sequence !== captured.expectedSequence + index + 1 || entry.runId !== turnId
          || entry.kind !== entries[index]!.kind || JSON.stringify(entry.data) !== JSON.stringify(entries[index]!.data))) throw new MayuraError('CONFLICT', 'Import receipt differs from the supplied command.');
        await auth.require(id, 'read'); return Object.freeze(page.map(entryView));
      };
      const prior = await receipt(); if (prior) return prior;
      if (current.lastSequence !== captured.expectedSequence) throw new MayuraError('CONFLICT', 'Import sequence changed.');
      const holderId = crypto.randomUUID(); const lease = { scope: key, id, runId: turnId, holderId };
      await storage(() => store.acquire({ ...lease, leaseMs: 30_000 }));
      try {
        // Under the writer lease, reject reuse of a command ID at a different sequence. The bounded scan keeps
        // receipts permanent without introducing an unbounded metadata ledger or a store-specific side table.
        let after = 0; let scanned = 0; let bytes = 0;
        while (after < captured.expectedSequence) {
          await auth.require(id, 'read'); await auth.require(id, 'import');
          const page = await storage(() => store.entries({ scope: key, id, after, limit: 25 }));
          if (!page.length) throw new MayuraError('STORAGE_UNAVAILABLE', 'Import receipt scan is incomplete.');
          for (const entry of page) {
            if (++scanned > MAX_SCAN || (bytes += bytesOf(entry)) > 8_388_608) throw new MayuraError('LIMIT_EXCEEDED', 'Import receipt scan exceeds its bounds.');
            if (entry.runId === turnId) throw new MayuraError('CONFLICT', 'Import command already belongs to another sequence.');
            after = entry.sequence;
          }
        }
        await auth.require(id, 'import'); await auth.require(id, 'append');
        try { await storage(() => store.append({ ...lease, expectedSequence: captured.expectedSequence, entries })); }
        catch (error) { const recovered = await receipt(); if (recovered) return recovered; throw error; }
        const result = await receipt(); if (!result) throw new MayuraError('STORAGE_UNAVAILABLE', 'Import receipt is unavailable; inspect before issuing another command.'); return result;
      } finally { await store.release(lease).catch(() => undefined); }
    },
    compact: (id, settings) => compactThread(compactContext, id, settings),
    cancelCompaction: (id, commandId) => cancelThreadCompaction(compactContext, id, commandId),
  };
  Object.freeze(threads);
  internals.set(threads, { store, key, need, history, auth });
  return threads;
}

/**
 * Delete threads idle since before `idleBefore`, in every scope, for retention. An administrative job, not scoped:
 * call it from your scheduler with the store itself. Returns how many threads it deleted.
 */
export async function purgeIdleThreads(options: { readonly store: { readonly threads: ThreadStore }; readonly idleBefore: Date | number; readonly limit?: number }): Promise<number> {
  const store = options?.store?.threads;
  if (!store || typeof store.expire !== 'function') throw new MayuraError('INVALID_CONFIG', 'purgeIdleThreads requires a store with threads.');
  const idleBeforeMs = options.idleBefore instanceof Date ? options.idleBefore.getTime() : options.idleBefore;
  if (!Number.isSafeInteger(idleBeforeMs) || idleBeforeMs < 0) throw new MayuraError('INVALID_INPUT', 'idleBefore must be a time.');
  const limit = count(options.limit, 'limit', 1, THREAD_LIMITS.expireLimit, THREAD_LIMITS.expireLimit);
  const expired = await storage(() => store.expire({ idleBeforeMs, limit }));
  for (const thread of expired) {
    for (let page = 0; page < 100_000; page++) {
      const result = await storage(() => store.delete({ scope: thread.scope, id: thread.id, limit: THREAD_LIMITS.deleteLimit }));
      if (result.thread.status === 'deleted') break;
    }
  }
  return expired.length;
}

export interface RunInThreadOptions<I extends Schema, O extends Schema> {
  readonly threads: Threads;
  readonly runtime: Runtime;
  readonly agent: AgentDefinition<I, O>;
  readonly threadId: string;
  readonly input: InferInput<I>;
  readonly history?: HistoryPolicy;
  /** How long the thread stays held for this turn without a renewal (default 60 seconds); renewed while the run lasts. */
  readonly leaseMs?: number;
}
export interface ThreadTurn<T> {
  /** This turn's id in the thread: its entries carry it. */
  readonly turnId: string;
  /** The run, to observe, approve or cancel. */
  readonly run: RunHandle<T>;
  /** What the run was given as history. */
  readonly history: ThreadHistory;
  /** Settles once the run ended and its turn was recorded; the thread is then free for the next turn. */
  readonly done: Promise<{ readonly outcome: Outcome<T>; readonly entries: readonly ThreadEntry[] }>;
}

/** A turn's entries from the run: its input, each batch of calls with its approvals and results, the output, the outcome. */
function turnEntries(transcript: readonly ModelMessage[], approvals: ReadonlyMap<string, ThreadEntryData>, outcome: Outcome<unknown>, runId: string): ThreadEntryInput[] {
  const fit = (data: Record<string, unknown>, field: string): JsonObject => {
    if (bytesOf(data) <= THREAD_LIMITS.entryBytes) return jsonValue(data) as JsonObject;
    // Too large for a thread entry: kept as a marker, so the turn stays whole and honest about what is missing.
    return jsonValue({ ...data, [field]: null, omitted: 'too_large' }) as JsonObject;
  };
  const entries: ThreadEntryInput[] = [];
  for (const message of transcript) {
    const media = 'media' in message && message.media && message.media.length > 0 ? { media: mediaReferences(message.media) } : {};
    if (message.role === 'user') entries.push({ kind: 'user', data: fit({ content: message.content, ...media }, 'content') });
    else if (message.role === 'assistant') {
      entries.push({ kind: 'tool_calls', data: fit({ calls: message.calls.map(call => ({ id: call.id, toolId: call.toolId, input: call.input })) }, 'calls') });
      for (const call of message.calls) {
        const approval = approvals.get(call.id);
        if (approval) { const { kind: _kind, ...data } = approval; entries.push({ kind: 'approval', data: jsonValue(data) as JsonObject }); }
      }
    } else entries.push({ kind: 'tool_result', data: fit({ callId: message.callId, toolId: message.toolId, result: message.result, ...media }, 'result') });
  }
  if (outcome.status === 'succeeded') entries.push({ kind: 'assistant', data: fit({ output: outcome.output as JsonValue }, 'output') });
  entries.push({ kind: 'run', data: jsonValue({ runId, status: outcome.status, ...(outcome.status === 'succeeded' ? {} : { errorCode: outcome.error.code }) }) as JsonObject });
  return entries;
}

/**
 * Run an agent in a thread: hold the thread for this turn (one turn at a time), give the run the thread's newest whole
 * turns as history, and record the turn when the run ends: its input, calls, released results, approvals, output and
 * outcome. Needs `thread:read` and `thread:write`.
 */
export async function runInThread<I extends Schema, O extends Schema>(options: RunInThreadOptions<I, O>): Promise<ThreadTurn<InferOutput<O>>> {
  const inner = internals.get(options?.threads);
  if (!inner) throw new MayuraError('INVALID_CONFIG', 'runInThread requires threads from createThreads.');
  inner.need('thread:read'); inner.need('thread:write');
  const { store, key, auth } = inner; const { runtime, agent } = options;
  const input = jsonValue(options.input); const historyPolicy = options.history === undefined ? undefined : Object.freeze({ ...options.history });
  const id = threadId(options.threadId);
  const leaseMs = count(options.leaseMs, 'leaseMs', 1_000, THREAD_LIMITS.maxLeaseMs, 60_000);
  await auth.require(id, 'read'); await auth.require(id, 'append');
  const record = await storage(() => store.get({ scope: key, id }));
  if (!record || record.status === 'deleting' || record.status === 'deleted') throw new MayuraError('NOT_FOUND', 'No such thread in this scope.');
  if (record.status !== 'active') throw new MayuraError('CONFLICT', 'The thread is archived; restore it to continue it.');
  if (record.agentId !== null && record.agentId !== agent.id) throw new MayuraError('CONFLICT', `This thread talks to agent ${record.agentId}, not ${agent.id}.`);
  if (runtime.recorder && runtime.recorder !== options.threads.recorder) throw new MayuraError('INVALID_CONFIG', "Configure this scope's threads.recorder on the runtime.");
  const turnId = crypto.randomUUID(); const lease = { scope: key, id, runId: turnId, holderId: turnId };
  let held: ThreadRecord;
  await auth.require(id, 'append');
  try { held = await storage(() => store.acquire({ ...lease, leaseMs })); }
  catch (error) { throw error instanceof MayuraError && error.code === 'CONFLICT' ? new MayuraError('CONFLICT', 'Another run is writing to this thread; wait for its turn to finish.') : error; }
  const release = (): Promise<unknown> => store.release({ scope: lease.scope, id: lease.id, runId: lease.runId, holderId: lease.holderId }).catch(() => undefined);
  let history: ThreadHistory; let run: RunHandle<InferOutput<O>>;
  try {
    history = await inner.history(id, historyPolicy);
    await auth.require(id, 'read'); await auth.require(id, 'append');
    run = runtime.submit(agent, { input: input as InferInput<I>, history,
      ...(runtime.recorder ? { recording: { threadId: id, turnId, startSequence: held.lastSequence } } : {}) });
  } catch (error) { await release(); throw error; }
  if (runtime.recorder) {
    // The persisted start marker fences the turn even while its lease has expired or its process has stopped.
    const done = (async () => {
      const outcome = await run.result();
      const entries: ThreadEntry[] = [];
      let after = held.lastSequence;
      for (;;) {
        await auth.require(id, 'read');
        const page = await storage(() => store.entries({ scope: key, id, after, limit: THREAD_LIMITS.entriesLimit }));
        for (const entry of page) {
          if (entry.runId !== turnId) { await auth.require(id, 'read'); return Object.freeze({ outcome, entries: Object.freeze(entries) }); }
          entries.push(entryView(entry)); after = entry.sequence;
        }
        if (page.length < THREAD_LIMITS.entriesLimit) break;
      }
      // begin can fail before a marker exists; release only our own lease, never another turn's hold.
      if (entries.length === 0) await release();
      await auth.require(id, 'read'); return Object.freeze({ outcome, entries: Object.freeze(entries) });
    })();
    void done.catch(() => release());
    return Object.freeze({ turnId, run, history, done });
  }
  // Keep the thread held while the run lasts, including while it waits for approval.
  const renewal = setInterval(() => { void store.renew({ ...lease, leaseMs }).catch(() => undefined); }, Math.max(500, Math.floor(leaseMs / 3)));
  const approvals = new Map<string, ThreadEntryData>();
  const watching = (async () => {
    try {
      for await (const event of run.observe()) {
        if (event.type !== 'approval.resolved') continue;
        const { callId, toolId, decision, actorId } = event.metadata;
        approvals.set(String(callId), { kind: 'approval', callId: String(callId), toolId: String(toolId), decision: decision as 'approved' | 'rejected' | 'expired',
          ...(typeof actorId === 'string' ? { actorId } : {}) });
      }
    } catch { /* Approvals that cannot be read are left out of the record; the run is unaffected. */ }
  })();
  const done = (async () => {
    try {
      const outcome = await run.result();
      await watching;
      const entries = turnEntries(runtime.transcript(run), approvals, outcome, run.id);
      const written: ThreadEntry[] = []; let sequence = held.lastSequence; let index = 0;
      while (index < entries.length) {
        const chunk: ThreadEntryInput[] = []; let size = 0;
        while (index < entries.length && chunk.length < THREAD_LIMITS.entriesPerAppend && size + bytesOf(entries[index]!.data) <= THREAD_LIMITS.appendBytes) {
          size += bytesOf(entries[index]!.data); chunk.push(entries[index]!); index++;
        }
        const result = await storage(() => store.append({ ...lease, expectedSequence: sequence, entries: chunk }));
        sequence = result.thread.lastSequence; written.push(...result.entries.map(entryView));
      }
      await auth.require(id, 'read'); return Object.freeze({ outcome, entries: Object.freeze(written) });
    } finally { clearInterval(renewal); await release(); }
  })();
  done.catch(() => undefined);
  return Object.freeze({ turnId, run, history, done });
}

/**
 * Recorder over the existing thread transaction seam. A start marker is the durable association; each completion
 * chunk ends with a progress marker, so a lost reply or competing replica can compare and retry the exact sequence.
 * Markers contain ids/digests only. Deleted threads cannot be revived by a late completion.
 */
function createThreadRecorder(store: ThreadStore, key: string, scope: Scope, need: (grant: string) => void, auth: ThreadAuthorization): RunRecorder & { recover(threadId: string, runId: string): Promise<boolean> } {
  const context = (input: RunRecordingContext) => {
    need('thread:read'); need('thread:write');
    if (input.scope.principalId !== scope.principalId || input.scope.projectId !== scope.projectId) {
      throw new MayuraError('NOT_FOUND', 'The run does not belong to this thread scope.');
    }
    const { threadId: id, turnId, startSequence } = input.binding;
    threadId(input.runId); threadId(id); threadId(turnId);
    if (!Number.isSafeInteger(startSequence) || (startSequence as number) < 0 || (startSequence as number) >= THREAD_LIMITS.maxSequence) {
      throw new MayuraError('INVALID_INPUT', 'The recording start sequence is invalid.');
    }
    if (Object.keys(input.binding).sort().join(',') !== 'startSequence,threadId,turnId') throw new MayuraError('INVALID_INPUT', 'Invalid thread recording binding.');
    return { scope: key, id: id as string, runId: turnId as string, holderId: turnId as string, start: startSequence as number };
  };
  const marker = (runId: string, extra: JsonObject = {}): ThreadEntryInput => ({ kind: 'run', data: { runId, status: 'running', recording: true, ...extra } });
  const same = (a: ThreadEntryInput, b: ThreadEntryInput) => a.kind === b.kind && JSON.stringify(a.data) === JSON.stringify(b.data);
  /** Check replayed entries before attempting a write: the commit may have succeeded even if its reply was lost. */
  const append = async (lease: ReturnType<typeof context>, sequence: number, entries: readonly ThreadEntryInput[], admission = false) => {
    const previous = await storage(() => store.entries({ scope: key, id: lease.id, after: sequence, limit: entries.length }));
    if (previous.length > 0) {
      if (previous.length !== entries.length || previous.some((entry, index) => entry.sequence !== sequence + index + 1
        || entry.runId !== lease.runId || !same(entry, entries[index]!))) {
        throw new MayuraError('CONFLICT', 'This turn has a different recording at that sequence.');
      }
      return;
    }
    if (admission) { await auth.require(lease.id, 'read'); await auth.require(lease.id, 'append'); }
    try { await storage(() => store.append({ scope: key, id: lease.id, runId: lease.runId, holderId: lease.holderId, expectedSequence: sequence, entries })); }
    catch (error) {
      const committed = await storage(() => store.entries({ scope: key, id: lease.id, after: sequence, limit: entries.length }));
      if (committed.length !== entries.length || committed.some((entry, index) => entry.sequence !== sequence + index + 1
        || entry.runId !== lease.runId || !same(entry, entries[index]!))) throw error;
    }
  };
  /** The immutable outbox contains only thread entries: withheld results, media bytes and continuations never enter it. */
  const commit = async (input: RunRecordingContext, entries: readonly ThreadEntryInput[]): Promise<void> => {
    const lease = context(input);
    if (!Array.isArray(entries) || entries.length === 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'The terminal recording is invalid.');
    const last = entries[entries.length - 1]!;
    if (last.kind !== 'run' || last.data['runId'] !== input.runId
      || !['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(last.data['status'] as string)) {
      throw new MayuraError('STORAGE_UNAVAILABLE', 'The terminal recording is invalid.');
    }
    const digest = sha256Hex(JSON.stringify(entries));
    // The final marker is durable evidence of completion, independent of the current lease or later turns.
    let after = lease.start + 1;
    const chunks: ThreadEntryInput[][] = [];
    let index = 0;
    while (index < entries.length) {
      const chunk: ThreadEntryInput[] = [];
      while (index < entries.length && chunk.length < THREAD_LIMITS.entriesPerAppend - 1
        && bytesOf([...chunk, entries[index]!, marker(input.runId, { digest, offset: index + 1 })]) <= THREAD_LIMITS.appendBytes) {
        chunk.push(entries[index++]!);
      }
      if (!chunk.length) throw new MayuraError('LIMIT_EXCEEDED', 'A thread recording entry exceeds the append limit.');
      if (index < entries.length) chunk.push(marker(input.runId, { digest, offset: index }));
      chunks.push(chunk);
    }
    const verified = async (): Promise<boolean> => {
      let sequence = lease.start + 1;
      for (const chunk of chunks) {
        const stored = await storage(() => store.entries({ scope: key, id: lease.id, after: sequence, limit: chunk.length }));
        if (stored.length !== chunk.length || stored.some((entry, offset) => entry.sequence !== sequence + offset + 1
          || entry.runId !== lease.runId || !same(entry, chunk[offset]!))) return false;
        sequence += chunk.length;
      }
      return true;
    };
    const finalize = async (): Promise<void> => {
      await storage(() => store.release({ scope: key, id: lease.id, runId: lease.runId, holderId: lease.holderId }));
      await storage(() => store.recording({ scope: key, id: lease.id, runtimeRunId: input.runId, action: 'delete' }));
    };
    if (await verified()) { await finalize(); return; }
    try {
      await storage(() => store.acquire({ scope: key, id: lease.id, runId: lease.runId, holderId: lease.holderId, leaseMs: 60_000 }));
      for (const chunk of chunks) {
        await storage(() => store.renew({ scope: key, id: lease.id, runId: lease.runId, holderId: lease.holderId, leaseMs: 60_000 }));
        await append(lease, after, chunk); after += chunk.length;
      }
    } catch (error) {
      // A competing replica may have finished and released the lease after our initial read.
      if (!await verified()) throw error;
    }
    await finalize();
  };
  return Object.freeze({
    begin: async (input: RunRecordingContext) => {
      const lease = context(input);
      await auth.require(lease.id, 'read'); await auth.require(lease.id, 'append');
      await append(lease, lease.start, [marker(input.runId)], true);
    },
    complete: async (input: RunRecording) => {
      const lease = context(input);
      // Settlement is a capability of the already-admitted turn, not a new content-writing admission.
      // Require its exact durable start marker before saving any outbox; arbitrary bindings cannot create turns.
      const started = await storage(() => store.entries({ scope: key, id: lease.id, after: lease.start, limit: 1 }));
      const start = started[0];
      if (!start || start.sequence !== lease.start + 1 || start.runId !== lease.runId || start.kind !== 'run'
        || start.data['runId'] !== input.runId || start.data['recording'] !== true || start.data['status'] !== 'running') {
        throw new MayuraError('CONFLICT', 'A terminal recording requires its admitted thread/run association.');
      }
      const approvals = new Map(input.approvals.map(approval => [approval.callId, { kind: 'approval' as const, ...approval }]));
      const entries = turnEntries(input.messages, approvals, input.outcome, input.runId);
      if (input.reconciliation !== undefined) {
        if (!input.reconciliation || typeof input.reconciliation !== 'object' || Array.isArray(input.reconciliation)
          || input.outcome.status !== 'outcome_unknown' || input.messages.length > 0 || input.approvals.length > 0)
          throw new MayuraError('INVALID_INPUT', 'Reconciliation closes a turn without synthetic conversation or results.');
        const receipt = jsonValue(input.reconciliation, { maxBytes: 4096 }) as JsonObject;
        const last = entries[entries.length - 1]!; entries[entries.length - 1] = { ...last, data: { ...last.data, reconciliation: receipt } };
      }
      const body = jsonValue({ format: 1, runId: input.runId, scope: input.scope, binding: input.binding, entries }, { maxBytes: 3_000_000, maxNodes: 200_000 }) as JsonObject;
      await storage(() => store.recording({ scope: key, id: lease.id, runtimeRunId: input.runId, action: 'save',
        turnId: lease.runId, startSequence: lease.start, body }));
      await commit(input, entries);
    },
    recover: async (id: string, runId: string) => {
      need('thread:read'); need('thread:write'); threadId(id); threadId(runId);
      await auth.require(id, 'recover');
      const body = await storage(() => store.recording({ scope: key, id, runtimeRunId: runId, action: 'read' }));
      if (!body) return false;
      if (body['format'] !== 1 || body['runId'] !== runId || !body['binding'] || typeof body['binding'] !== 'object'
        || Array.isArray(body['binding']) || body['binding']['threadId'] !== id) {
        throw new MayuraError('STORAGE_UNAVAILABLE', 'The terminal recording is invalid.');
      }
      await auth.require(id, 'recover');
      await commit({ runId, scope, binding: body['binding'] as JsonObject }, body['entries'] as unknown as readonly ThreadEntryInput[]);
      return true;
    },
  });
}
