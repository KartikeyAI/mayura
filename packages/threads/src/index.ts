import { freezeJson, jsonValue, MayuraError, type InferInput, type InferOutput, type JsonObject, type JsonValue, type ModelHistoryMessage, type ModelMessage, type Outcome, type RunHandle, type Schema, type Scope } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { StorageError, THREAD_LIMITS, type ThreadEntry as StoredEntry, type ThreadEntryInput, type ThreadRecord, type ThreadStore } from '@mayura/storage-contracts';
import type { AgentDefinition, Runtime } from '@mayura/runtime';

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
  | { readonly kind: 'user'; readonly content: JsonValue; readonly mediaOmitted?: number; readonly omitted?: 'too_large' }
  | { readonly kind: 'assistant'; readonly output: JsonValue; readonly omitted?: 'too_large' }
  | { readonly kind: 'tool_calls'; readonly calls: readonly { readonly id: string; readonly toolId: string; readonly input: JsonValue }[] }
  | { readonly kind: 'tool_result'; readonly callId: string; readonly toolId: string; readonly result: JsonValue; readonly mediaOmitted?: number; readonly omitted?: 'too_large' }
  | { readonly kind: 'approval'; readonly callId: string; readonly toolId: string; readonly decision: 'approved' | 'rejected' | 'expired'; readonly actorId?: string }
  | { readonly kind: 'run'; readonly runId: string; readonly status: Outcome<unknown>['status']; readonly errorCode?: string }
  | { readonly kind: 'summary'; readonly content: string; readonly covers: { readonly from: number; readonly to: number } };
export type ThreadEntry = ThreadEntryData & { readonly sequence: number; readonly turnId: string; readonly createdAt: string };
/** How much of a thread to send as a run's history: the newest whole turns that fit. */
export interface HistoryPolicy {
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
}
export interface ThreadsOptions {
  /** A Mayura store with threads (call `await store.threads.initialize()` once). */
  readonly store: { readonly threads: ThreadStore };
  /** Whose threads: from your verified identity, never from model output. */
  readonly scope: Scope;
  /** `thread:read`, `thread:write` and `thread:delete`, as needed. Nothing is allowed by default. */
  readonly permissions: { readonly allow: readonly string[] };
}
export interface Threads {
  readonly scope: Scope;
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
  readonly store: ThreadStore;
  readonly key: string;
  need(grant: string): void;
  history(id: string, policy?: HistoryPolicy): Promise<ThreadHistory>;
}
const internals = new WeakMap<Threads, Internals>();

/** One turn's entries, oldest first, as history messages; undefined when the turn did not succeed or is incomplete. */
function turnMessages(entries: readonly ThreadEntry[]): ModelHistoryMessage[] | undefined {
  const run = entries.find(entry => entry.kind === 'run');
  if (!run || run.kind !== 'run' || run.status !== 'succeeded' || entries[0]?.kind !== 'user') return undefined;
  const messages: ModelHistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user') messages.push({ role: 'user', content: entry.omitted ? { omitted: 'too_large' } : entry.content });
    else if (entry.kind === 'tool_calls') messages.push({ role: 'assistant', calls: entry.calls.map(call => ({ id: call.id, toolId: call.toolId, input: call.input })) });
    else if (entry.kind === 'tool_result') messages.push({ role: 'tool', callId: entry.callId, toolId: entry.toolId, result: entry.omitted ? { omitted: 'too_large' } : entry.result });
    else if (entry.kind === 'assistant') messages.push({ role: 'assistant', output: entry.omitted ? { omitted: 'too_large' } : entry.output });
  }
  return messages;
}

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
  const key = sha256Hex(`mayura:thread-scope:v1\0${principalId}\0${projectId}`);
  const read = async (id: string): Promise<ThreadRecord> => {
    const record = await storage(() => store.get({ scope: key, id: threadId(id) }));
    if (!record) throw new MayuraError('NOT_FOUND', 'No such thread in this scope.');
    return record;
  };
  const change = async (id: string, update: (record: ThreadRecord) => { readonly title?: string | null; readonly metadata?: JsonObject; readonly status?: 'active' | 'archived' }, expectedVersion?: number): Promise<Thread> => {
    need('thread:write');
    for (let attempt = 0; ; attempt++) {
      const record = await read(id);
      if (record.status === 'deleting' || record.status === 'deleted') throw new MayuraError('NOT_FOUND', 'The thread was deleted.');
      if (expectedVersion !== undefined && record.version !== expectedVersion) throw new MayuraError('CONFLICT', 'The thread changed since that version.');
      try { return view(await storage(() => store.update({ scope: key, id: record.id, expectedVersion: record.version, ...update(record) }))); }
      catch (error) { if (expectedVersion !== undefined || attempt >= 2 || !(error instanceof MayuraError) || error.code !== 'CONFLICT') throw error; }
    }
  };
  const history = async (id: string, policy: HistoryPolicy = {}): Promise<ThreadHistory> => {
    need('thread:read');
    const maxEntries = count(policy.maxEntries, 'maxEntries', 1, 2_048, 200);
    const maxBytes = count(policy.maxBytes, 'maxBytes', 1_024, 2_097_152, 524_288);
    const record = await read(id);
    if (record.status === 'deleting' || record.status === 'deleted') throw new MayuraError('NOT_FOUND', 'The thread was deleted.');
    // Read backwards, newest first, a bounded number of entries.
    const newestFirst: ThreadEntry[] = [];
    let before = record.lastSequence + 1;
    while (before > 1 && newestFirst.length < MAX_SCAN) {
      const page = await storage(() => store.entries({ scope: key, id: record.id, before, limit: THREAD_LIMITS.entriesLimit }));
      if (page.length === 0) break;
      for (let index = page.length - 1; index >= 0; index--) newestFirst.push(entryView(page[index]!));
      before = page[0]!.sequence;
      if (newestFirst.length >= maxEntries * 4) break;
    }
    // Group into turns (a turn's entries are contiguous: one run writes at a time), newest turn first.
    const turns: ThreadEntry[][] = [];
    for (const entry of newestFirst) {
      const last = turns[turns.length - 1];
      if (last && last[0]!.turnId === entry.turnId) last.unshift(entry); else turns.push([entry]);
    }
    const kept: ModelHistoryMessage[][] = []; let entries = 0; let bytes = 0; let omittedTurns = 0; let full = false;
    for (const turn of turns) {
      const messages = turnMessages(turn);
      if (!messages) continue;
      const size = bytesOf(messages);
      if (full || entries + messages.length > maxEntries || bytes + size > maxBytes) {
        if (kept.length === 0) throw new MayuraError('LIMIT_EXCEEDED', 'The newest turn of the thread alone is larger than the history policy allows.');
        full = true; omittedTurns++; continue;
      }
      kept.push(messages); entries += messages.length; bytes += size;
    }
    const messages = freezeJson(jsonValue(kept.reverse().flat())) as unknown as readonly ModelHistoryMessage[];
    return Object.freeze({ messages, turns: kept.length, omittedTurns, bytes });
  };
  const threads: Threads = {
    scope,
    create: async (input = {}) => {
      need('thread:write');
      const id = input.id === undefined ? crypto.randomUUID() : threadId(input.id);
      if (input.agentId !== undefined && (typeof input.agentId !== 'string' || !idPattern.test(input.agentId))) throw new MayuraError('INVALID_INPUT', 'agentId must be an agent id.');
      const result = await storage(() => store.create({ scope: key, id, agentId: input.agentId ?? null, title: input.title ?? null, metadata: input.metadata ?? {} }));
      return view(result.thread);
    },
    get: async id => {
      need('thread:read');
      const record = await storage(() => store.get({ scope: key, id: threadId(id) }));
      return record ? view(record) : undefined;
    },
    list: async (listing = {}) => {
      need('thread:read');
      const status = listing.status ?? 'active';
      if (!['active', 'archived', 'all'].includes(status)) throw new MayuraError('INVALID_INPUT', "status must be 'active', 'archived' or 'all'.");
      const limit = count(listing.limit, 'limit', 1, THREAD_LIMITS.listLimit, 20);
      const result = await storage(() => store.list({ scope: key, statuses: status === 'all' ? ['active', 'archived'] : [status], limit,
        ...(listing.cursor === undefined ? {} : { before: listing.cursor }) }));
      return Object.freeze({ threads: Object.freeze(result.threads.map(view)), cursor: result.cursor });
    },
    update: (id, changes) => change(id, () => ({ ...(changes.title === undefined ? {} : { title: changes.title }), ...(changes.metadata === undefined ? {} : { metadata: changes.metadata }) }), changes.expectedVersion),
    archive: id => change(id, () => ({ status: 'archived' })),
    restore: id => change(id, () => ({ status: 'active' })),
    delete: async id => {
      need('thread:delete');
      let removed = 0;
      for (let page = 0; page < 100_000; page++) {
        const result = await storage(() => store.delete({ scope: key, id: threadId(id), limit: THREAD_LIMITS.deleteLimit }));
        removed += result.removed;
        if (result.thread.status === 'deleted') return Object.freeze({ removed });
      }
      throw new MayuraError('LIMIT_EXCEEDED', 'The thread is still being deleted; call delete again.');
    },
    entries: async (id, paging = {}) => {
      need('thread:read');
      const limit = count(paging.limit, 'limit', 1, THREAD_LIMITS.entriesLimit, 100);
      const page = await storage(() => store.entries({ scope: key, id: threadId(id), limit,
        ...(paging.after === undefined ? {} : { after: paging.after }), ...(paging.before === undefined ? {} : { before: paging.before }) }));
      return Object.freeze(page.map(entryView));
    },
    history,
  };
  Object.freeze(threads);
  internals.set(threads, { store, key, need, history });
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
    const copy = jsonValue(data) as JsonObject;
    if (bytesOf(copy) <= THREAD_LIMITS.entryBytes) return copy;
    // Too large for a thread entry: kept as a marker, so the turn stays whole and honest about what is missing.
    return jsonValue({ ...data, [field]: null, omitted: 'too_large' }) as JsonObject;
  };
  const entries: ThreadEntryInput[] = [];
  for (const message of transcript) {
    const media = 'media' in message && message.media && message.media.length > 0 ? { mediaOmitted: message.media.length } : {};
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
  const { store, key } = inner; const { runtime, agent } = options;
  const id = threadId(options.threadId);
  const leaseMs = count(options.leaseMs, 'leaseMs', 1_000, THREAD_LIMITS.maxLeaseMs, 60_000);
  const record = await storage(() => store.get({ scope: key, id }));
  if (!record || record.status === 'deleting' || record.status === 'deleted') throw new MayuraError('NOT_FOUND', 'No such thread in this scope.');
  if (record.status !== 'active') throw new MayuraError('CONFLICT', 'The thread is archived; restore it to continue it.');
  if (record.agentId !== null && record.agentId !== agent.id) throw new MayuraError('CONFLICT', `This thread talks to agent ${record.agentId}, not ${agent.id}.`);
  const turnId = crypto.randomUUID(); const lease = { scope: key, id, runId: turnId, holderId: turnId };
  let held: ThreadRecord;
  try { held = await storage(() => store.acquire({ ...lease, leaseMs })); }
  catch (error) { throw error instanceof MayuraError && error.code === 'CONFLICT' ? new MayuraError('CONFLICT', 'Another run is writing to this thread; wait for its turn to finish.') : error; }
  const release = (): Promise<unknown> => store.release(lease).catch(() => undefined);
  let history: ThreadHistory; let run: RunHandle<InferOutput<O>>;
  try {
    history = await inner.history(id, options.history);
    run = runtime.submit(agent, { input: options.input, ...(history.messages.length > 0 ? { history: history.messages } : {}) });
  } catch (error) { await release(); throw error; }
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
      return Object.freeze({ outcome, entries: Object.freeze(written) });
    } finally { clearInterval(renewal); await release(); }
  })();
  done.catch(() => undefined);
  return Object.freeze({ turnId, run, history, done });
}
