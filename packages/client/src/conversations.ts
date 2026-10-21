import { ClientError, type ClientJson } from './index.js';

export interface RemoteApproval {
  readonly callId: string; readonly toolId: string; readonly toolVersion: string; readonly input: ClientJson;
  readonly digest: string; readonly expiresAtMs: number;
}
export interface RunApprovalCommand {
  readonly callId: string; readonly digest: string; readonly decision: 'approved' | 'rejected'; readonly reason?: string;
}
export interface RemoteThread {
  readonly id: string; readonly agentId: string | null; readonly title: string | null;
  readonly metadata: Readonly<Record<string, ClientJson>>; readonly status: 'active' | 'archived' | 'deleting' | 'deleted';
  readonly version: number; readonly createdAt: string; readonly updatedAt: string;
  readonly entryCount: number; readonly lastSequence: number; readonly activeTurnId: string | null;
}
export interface RemoteThreadSummaryProvenance {
  readonly format: 1; readonly commandId: string; readonly requestDigest: string; readonly sourceDigest: string;
  readonly sourceEntries: number; readonly sourceTurns: number; readonly agentId: string; readonly agentVersion: string;
  readonly modelRunId: string; readonly costMicros: number | string;
}
export interface RemoteThreadMediaReference {
  readonly id: string; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'application/pdf';
  readonly source: 'bytes' | 'url'; readonly bytes?: number; readonly name?: string;
}
export type RemoteThreadEntry = { readonly sequence: number; readonly turnId: string; readonly createdAt: string } & (
  | { readonly kind: 'user'; readonly content: ClientJson; readonly mediaOmitted?: number; readonly media?: readonly RemoteThreadMediaReference[]; readonly omitted?: 'too_large' }
  | { readonly kind: 'assistant'; readonly output: ClientJson; readonly omitted?: 'too_large' }
  | { readonly kind: 'tool_calls'; readonly calls: readonly { readonly id: string; readonly toolId: string; readonly input: ClientJson }[] | null; readonly omitted?: 'too_large' }
  | { readonly kind: 'tool_result'; readonly callId: string; readonly toolId: string; readonly result: ClientJson; readonly mediaOmitted?: number; readonly media?: readonly RemoteThreadMediaReference[]; readonly omitted?: 'too_large' }
  | { readonly kind: 'approval'; readonly callId: string; readonly toolId: string; readonly decision: 'approved' | 'rejected' | 'expired'; readonly actorId?: string }
  | { readonly kind: 'run'; readonly runId: string; readonly status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown'; readonly errorCode?: string; readonly imported?: { readonly commandId: string; readonly digest: string }; readonly recording?: true; readonly digest?: string; readonly offset?: number; readonly reconciliation?: Readonly<Record<string, ClientJson>>; readonly compaction?: { readonly format: 1; readonly commandId: string } }
  | { readonly kind: 'summary'; readonly content: string; readonly covers: { readonly from: number; readonly to: number }; readonly compaction?: RemoteThreadSummaryProvenance });
export interface RemoteThreadPage { readonly threads: readonly RemoteThread[]; readonly cursor: string | null }
export interface ThreadListOptions { readonly status?: 'active' | 'archived' | 'all'; readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal }
export interface ThreadEntriesOptions { readonly after?: number; readonly before?: number; readonly limit?: number; readonly signal?: AbortSignal }
export interface ThreadCreateInput { readonly id?: string; readonly agentId?: string; readonly title?: string; readonly metadata?: Readonly<Record<string, ClientJson>> }
export interface ThreadUpdateInput { readonly title?: string | null; readonly metadata?: Readonly<Record<string, ClientJson>>; readonly expectedVersion?: number }
export interface ThreadCompactionInput {
  readonly commandId: string; readonly through: number; readonly previousSummarySequence?: number;
}
export interface RemoteThreadCompactionResult {
  readonly commandId: string; readonly entry: RemoteThreadEntry & { readonly kind: 'summary' };
  readonly runId: string; readonly costMicros: number | string; readonly reused: boolean;
}
/** Content-free durable command state. A null cost is unknown, bounded by maxCostMicros. */
export interface RemoteThreadCompaction {
  readonly commandId: string; readonly status: 'pending' | 'ready' | 'committed' | 'failed'; readonly through: number;
  readonly maxCostMicros: number; readonly costMicros: number | string | null; readonly entrySequence: number | null;
}
export interface RemoteThreadCompactionCancellation { readonly status: 'cancelled' | 'committed' | 'missing' }
export interface ThreadAppendInput {
  readonly commandId: string; readonly expectedSequence: number;
  readonly messages: readonly ({ readonly role: 'user'; readonly content: ClientJson; readonly media?: readonly RemoteThreadMediaReference[] } | { readonly role: 'assistant'; readonly output: ClientJson })[];
}
export interface ConversationClient {
  appendThread(id: string, input: ThreadAppendInput, options?: { readonly signal?: AbortSignal }): Promise<readonly RemoteThreadEntry[]>;
  /** Explicit paid command; never retried automatically. Reuse its exact envelope after a lost reply. */
  compactThread(id: string, input: ThreadCompactionInput, options?: { readonly signal?: AbortSignal }): Promise<RemoteThreadCompactionResult>;
  threadCompaction(id: string, commandId: string, options?: { readonly signal?: AbortSignal }): Promise<RemoteThreadCompaction>;
  cancelThreadCompaction(id: string, commandId: string, options?: { readonly signal?: AbortSignal }): Promise<RemoteThreadCompactionCancellation>;
  threads(options?: ThreadListOptions): Promise<RemoteThreadPage>;
  thread(id: string, options?: { readonly signal?: AbortSignal }): Promise<RemoteThread>;
  createThread(input?: ThreadCreateInput, options?: { readonly signal?: AbortSignal }): Promise<RemoteThread>;
  updateThread(id: string, changes: ThreadUpdateInput, options?: { readonly signal?: AbortSignal }): Promise<RemoteThread>;
  threadEntries(id: string, options?: ThreadEntriesOptions): Promise<readonly RemoteThreadEntry[]>;
  archiveThread(id: string, options?: { readonly signal?: AbortSignal }): Promise<RemoteThread>;
  restoreThread(id: string, options?: { readonly signal?: AbortSignal }): Promise<RemoteThread>;
  deleteThread(id: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly removed: number }>;
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const cursorPattern = /^(?:[0-9]{1,16}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|authz1\.[A-Za-z0-9_-]{40,500})$/;
function invalid(code = 'INVALID_RESPONSE'): never { throw new ClientError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) return invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function id(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value)) return invalid(); return value; }
function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(); return value;
}
function shortText(value: unknown, maximum = 128): void { if (typeof value !== 'string' || value.length < 1 || value.length > maximum) invalid(); }
function date(value: unknown): void { if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) invalid(); }
/** Copy only bounded plain JSON; command controllers cannot retain mutable approval input. */
function copyJson(value: unknown, maximum = 16_777_216): ClientJson {
  let nodes = 0; const seen = new Set<object>();
  const copy = (item: unknown, depth: number): ClientJson => {
    if (++nodes > 100_000 || depth > 32) return invalid();
    if (typeof item === 'string' && item.length > maximum) return invalid();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) return invalid(); seen.add(item);
    let result: ClientJson;
    if (Array.isArray(item)) {
      if (item.length > 100_000) return invalid(); const descriptors = Object.getOwnPropertyDescriptors(item); const entries: ClientJson[] = [];
      for (let index = 0; index < item.length; index++) {
        const field = descriptors[String(index)]; if (!field || !('value' in field)) return invalid(); entries.push(copy(field.value, depth + 1));
      }
      result = Object.freeze(entries);
    } else result = Object.freeze(Object.fromEntries(Object.entries(object(item)).map(([key, next]) => [key, copy(next, depth + 1)])));
    seen.delete(item); return result;
  };
  const result = copy(value, 0); if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maximum) return invalid(); return result;
}
export function readApproval(value: unknown): RemoteApproval {
  const raw = object(value); fields(raw, ['callId', 'toolId', 'toolVersion', 'input', 'digest', 'expiresAtMs']);
  for (const key of ['callId', 'toolId', 'toolVersion']) shortText(raw[key]);
  if (typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest'])) return invalid(); number(raw['expiresAtMs'], 1);
  const input = copyJson(raw['input']);
  return Object.freeze({ ...raw, input }) as unknown as RemoteApproval;
}
/** Exact decision envelope: actor identity is always assigned by the authenticated server. */
export function approvalCommand(value: RunApprovalCommand): ClientJson {
  try {
    const raw = object(value); fields(raw, ['callId', 'digest', 'decision'], ['reason']); shortText(raw['callId']);
    if (typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest']) || !['approved', 'rejected'].includes(String(raw['decision']))
      || (raw['reason'] !== undefined && (typeof raw['reason'] !== 'string' || raw['reason'].length > 1_000))) invalid();
    return Object.freeze({ ...raw }) as ClientJson;
  } catch { return invalid('INVALID_REQUEST'); }
}
export function readThread(value: unknown, expectedId?: string): RemoteThread {
  const raw = object(value); fields(raw, ['id', 'agentId', 'title', 'metadata', 'status', 'version', 'createdAt', 'updatedAt', 'entryCount', 'lastSequence', 'activeTurnId']);
  id(raw['id']); if (expectedId !== undefined && raw['id'] !== expectedId) invalid();
  if (raw['agentId'] !== null) id(raw['agentId']); if (raw['activeTurnId'] !== null) id(raw['activeTurnId']);
  if (raw['title'] !== null && (typeof raw['title'] !== 'string' || raw['title'].length > 256)) invalid();
  if (!['active', 'archived', 'deleting', 'deleted'].includes(String(raw['status']))) invalid();
  number(raw['version'], 1); number(raw['entryCount']); number(raw['lastSequence'], 0, 1_000_000_000); date(raw['createdAt']); date(raw['updatedAt']);
  object(raw['metadata']); const metadata = copyJson(raw['metadata'], 2_048);
  return Object.freeze({ ...raw, metadata }) as unknown as RemoteThread;
}
export function readThreadEntry(value: unknown): RemoteThreadEntry {
  const raw = object(value); const base = ['kind', 'sequence', 'turnId', 'createdAt'];
  number(raw['sequence'], 1, 1_000_000_000); id(raw['turnId']); date(raw['createdAt']);
  if (raw['media'] !== undefined) {
    if (!['user', 'tool_result'].includes(String(raw['kind'])) || !Array.isArray(raw['media']) || raw['media'].length > 32) invalid();
    for (const value of raw['media'] as unknown[]) {
      const ref = object(value); fields(ref, ['id', 'mediaType', 'source'], ['bytes', 'name']);
      if (typeof ref['id'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref['id']) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'].includes(String(ref['mediaType'])) || !['bytes', 'url'].includes(String(ref['source']))) invalid();
      if (ref['source'] === 'bytes') number(ref['bytes'], 1, 67_108_864); else if (ref['bytes'] !== undefined) invalid();
      if (ref['name'] !== undefined && (typeof ref['name'] !== 'string' || !/^[^\u0000-\u001f\u007f/\\]{1,255}$/u.test(ref['name']))) invalid();
    }
  }
  if (raw['imported'] !== undefined) {
    const receipt = object(raw['imported']); fields(receipt, ['commandId', 'digest']); id(receipt['commandId']);
    if (raw['kind'] !== 'run' || raw['status'] !== 'succeeded' || typeof receipt['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt['digest'])) invalid();
  }
  switch (raw['kind']) {
    case 'user': fields(raw, [...base, 'content'], ['mediaOmitted', 'omitted', 'media']); break;
    case 'assistant': fields(raw, [...base, 'output'], ['omitted']); break;
    case 'tool_result': fields(raw, [...base, 'callId', 'toolId', 'result'], ['mediaOmitted', 'omitted', 'media']); shortText(raw['callId']); id(raw['toolId']); break;
    case 'tool_calls': fields(raw, [...base, 'calls'], ['omitted']);
      if (raw['calls'] === null && raw['omitted'] === 'too_large') break;
      if (!Array.isArray(raw['calls']) || raw['calls'].length > 4096) invalid();
      for (const item of raw['calls'] as unknown[]) { const call = object(item); fields(call, ['id', 'toolId', 'input']); shortText(call['id']); id(call['toolId']); } break;
    case 'approval': fields(raw, [...base, 'callId', 'toolId', 'decision'], ['actorId']); shortText(raw['callId']); id(raw['toolId']);
      if (!['approved', 'rejected', 'expired'].includes(String(raw['decision']))) invalid(); if (raw['actorId'] !== undefined) id(raw['actorId']); break;
    case 'run': fields(raw, [...base, 'runId', 'status'], ['errorCode', 'recording', 'digest', 'offset', 'reconciliation', 'compaction', 'imported']); id(raw['runId']);
      if (raw['compaction'] !== undefined) {
        const operation = object(raw['compaction']); fields(operation, ['format', 'commandId']);
        if (operation['format'] !== 1 || raw['recording'] !== undefined || raw['reconciliation'] !== undefined) invalid(); id(operation['commandId']);
      }
      if (raw['reconciliation'] !== undefined) {
        const receipt = object(raw['reconciliation']);
        fields(receipt, ['format', 'reconciledAtMs', 'expectedVersion', 'expectedHolderId', 'commandId', 'actorId', 'reviewDigest', 'effect', 'evidenceRef', 'workerStopped']);
        if (raw['status'] !== 'outcome_unknown' || receipt['format'] !== 1 || receipt['workerStopped'] !== true
          || typeof receipt['reviewDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt['reviewDigest'])
          || !['not_started', 'succeeded', 'failed', 'unknown'].includes(String(receipt['effect']))) invalid();
        for (const key of ['expectedHolderId', 'commandId', 'actorId', 'evidenceRef']) id(receipt[key]);
        number(receipt['reconciledAtMs'], 0); number(receipt['expectedVersion'], 1); copyJson(receipt, 4096);
      }
      if (raw['recording'] !== undefined && (raw['recording'] !== true || raw['status'] !== 'running')) invalid();
      if (raw['digest'] !== undefined && (raw['recording'] !== true || typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest']))) invalid();
      if (raw['offset'] !== undefined) { if (raw['digest'] === undefined) invalid(); number(raw['offset'], 1); }
      if (!['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(String(raw['status'])) || (raw['errorCode'] !== undefined && typeof raw['errorCode'] !== 'string')) invalid(); break;
    case 'summary': fields(raw, [...base, 'content', 'covers'], ['compaction']); if (typeof raw['content'] !== 'string') invalid();
      { const covers = object(raw['covers']); fields(covers, ['from', 'to']); number(covers['from'], 1); number(covers['to'], covers['from'] as number);
        if (raw['compaction'] !== undefined) {
          const provenance = object(raw['compaction']);
          fields(provenance, ['format', 'commandId', 'requestDigest', 'sourceDigest', 'sourceEntries', 'sourceTurns', 'agentId', 'agentVersion', 'modelRunId', 'costMicros']);
          if (provenance['format'] !== 1 || covers['from'] !== 1 || (covers['to'] as number) >= (raw['sequence'] as number)
            || !(raw['content'] as string).trim()) invalid();
          for (const key of ['commandId', 'agentId', 'agentVersion', 'modelRunId']) id(provenance[key]);
          for (const key of ['requestDigest', 'sourceDigest']) if (typeof provenance[key] !== 'string' || !/^[a-f0-9]{64}$/.test(provenance[key] as string)) invalid();
          number(provenance['sourceEntries'], 1, 10_000); number(provenance['sourceTurns'], 1, 1_000_000_000);
          if (typeof provenance['costMicros'] === 'string') { if (!/^[0-9]{1,30}$/.test(provenance['costMicros'])) invalid(); }
          else number(provenance['costMicros'], 0);
          copyJson(raw['content'], 65_536);
        }
      } break;
    default: invalid();
  }
  if (raw['mediaOmitted'] !== undefined) number(raw['mediaOmitted'], 1);
  if (raw['omitted'] !== undefined && raw['omitted'] !== 'too_large') invalid();
  return copyJson(raw, 263_168) as unknown as RemoteThreadEntry;
}
/** Copy a strict bounded envelope; caller input cannot select models, grants, scopes or spending limits. */
export function threadCompactionCommand(value: ThreadCompactionInput): ThreadCompactionInput {
  try {
    const raw = object(value); fields(raw, ['commandId', 'through'], ['previousSummarySequence']); id(raw['commandId']); number(raw['through'], 1, 999_999_997);
    if (raw['previousSummarySequence'] !== undefined) number(raw['previousSummarySequence'], 1, 999_999_999);
    return Object.freeze({ ...raw }) as unknown as ThreadCompactionInput;
  } catch { return invalid('INVALID_REQUEST'); }
}
function cost(value: unknown): bigint {
  if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return BigInt(value);
  return BigInt(number(value));
}
export function readThreadCompaction(value: unknown, commandId: string): RemoteThreadCompaction {
  const raw = object(value); fields(raw, ['commandId', 'status', 'through', 'maxCostMicros', 'costMicros', 'entrySequence']);
  if (id(raw['commandId']) !== commandId || !['pending', 'ready', 'committed', 'failed'].includes(String(raw['status']))) invalid();
  number(raw['through'], 1, 999_999_997); number(raw['maxCostMicros']);
  if (raw['costMicros'] !== null && cost(raw['costMicros']) > BigInt(raw['maxCostMicros'] as number)) invalid();
  if ((raw['status'] === 'committed') !== (raw['entrySequence'] !== null)) invalid();
  if (raw['entrySequence'] !== null) number(raw['entrySequence'], (raw['through'] as number) + 1, 1_000_000_000);
  if (['ready', 'committed'].includes(String(raw['status'])) && raw['costMicros'] === null) invalid();
  if (raw['status'] === 'pending' && raw['costMicros'] !== null) invalid();
  return Object.freeze({ ...raw }) as unknown as RemoteThreadCompaction;
}
export function readThreadCompactionResult(value: unknown, command: ThreadCompactionInput): RemoteThreadCompactionResult {
  const raw = object(value); fields(raw, ['commandId', 'entry', 'runId', 'costMicros', 'reused']);
  const entry = readThreadEntry(raw['entry']); id(raw['runId']);
  if (raw['commandId'] !== command.commandId || typeof raw['reused'] !== 'boolean' || entry.kind !== 'summary'
    || !entry.compaction || entry.compaction.commandId !== command.commandId || entry.covers.to !== command.through
    || entry.compaction.modelRunId !== raw['runId'] || cost(raw['costMicros']) !== cost(entry.compaction.costMicros)) invalid();
  return Object.freeze({ ...raw, entry }) as unknown as RemoteThreadCompactionResult;
}
export function readThreadCompactionCancellation(value: unknown): RemoteThreadCompactionCancellation {
  const raw = object(value); fields(raw, ['status']); if (!['cancelled', 'committed', 'missing'].includes(String(raw['status']))) invalid();
  return Object.freeze({ ...raw }) as unknown as RemoteThreadCompactionCancellation;
}

type Command = (path: string, method: 'GET' | 'POST' | 'DELETE', signal?: AbortSignal, body?: ClientJson) => Promise<Record<string, unknown>>;
/** Internal transport adapter; all requests share the client's auth, timeout and response limits. */
export function conversationMethods(command: Command, json: (value: unknown, max: number) => ClientJson, maxBytes: number): ConversationClient {
  const path = (value: string): string => { try { id(value); } catch { invalid('INVALID_REQUEST'); } return `/v1/threads/${encodeURIComponent(value)}`; };
  const read = async (url: string, method: 'GET' | 'POST', signal?: AbortSignal, body?: ClientJson, expectedId?: string): Promise<RemoteThread> => {
    const raw = await command(url, method, signal, body); fields(raw, ['thread']); return readThread(raw['thread'], expectedId);
  };
  const input = (value: unknown, create: boolean): ClientJson => {
    try {
      const raw = object(json(value, maxBytes)); fields(raw, [], create ? ['id', 'agentId', 'title', 'metadata'] : ['title', 'metadata', 'expectedVersion']);
      for (const key of ['id', 'agentId']) if (raw[key] !== undefined) id(raw[key]);
      if (raw['title'] !== undefined && !(raw['title'] === null && !create) && (typeof raw['title'] !== 'string' || raw['title'].length > 256)) invalid();
      if (raw['metadata'] !== undefined) { object(raw['metadata']); json(raw['metadata'], 2_048); }
      if (raw['expectedVersion'] !== undefined) number(raw['expectedVersion'], 1);
      return raw as ClientJson;
    } catch { return invalid('INVALID_REQUEST'); }
  };
  const operationPath = (threadId: string, commandId: string): string => {
    try { id(commandId); } catch { invalid('INVALID_REQUEST'); } return `${path(threadId)}/compactions/${encodeURIComponent(commandId)}`;
  };
  return {
    async appendThread(threadId, value, options) {
      const captured = json(value, maxBytes); const body = object(captured); fields(body, ['commandId', 'expectedSequence', 'messages']);
      id(body['commandId']); number(body['expectedSequence'], 0, 999_999_999);
      if (!Array.isArray(body['messages']) || body['messages'].length < 2 || body['messages'].length > 62 || body['messages'].length % 2) invalid('INVALID_REQUEST');
      const raw = await command(`${path(threadId)}/entries`, 'POST', options?.signal, captured); fields(raw, ['entries']);
      if (!Array.isArray(raw['entries']) || raw['entries'].length !== body['messages'].length + 1) invalid();
      const entries = raw['entries'].map(readThreadEntry);
      for (let index = 0; index < body['messages'].length; index++) {
        const supplied = object(body['messages'][index]); const actual = entries[index]!;
        if (supplied['role'] !== actual.kind || (actual.kind === 'user' ? JSON.stringify(supplied['content']) !== JSON.stringify(actual.content)
          || JSON.stringify(supplied['media']) !== JSON.stringify(actual.media) : actual.kind !== 'assistant' || JSON.stringify(supplied['output']) !== JSON.stringify(actual.output))) invalid();
      }
      if (entries.some((entry, index) => entry.sequence !== value.expectedSequence + index + 1 || entry.turnId !== entries.at(-1)!.turnId)
        || entries.at(-1)?.kind !== 'run' || (entries.at(-1) as Extract<RemoteThreadEntry, { kind: 'run' }>).imported?.commandId !== value.commandId) invalid();
      return Object.freeze(entries);
    },
    async compactThread(threadId, value, options) {
      const input = threadCompactionCommand(value);
      const raw = await command(`${path(threadId)}/compactions`, 'POST', options?.signal, input as unknown as ClientJson);
      fields(raw, ['result']); return readThreadCompactionResult(raw['result'], input);
    },
    async threadCompaction(threadId, commandId, options) {
      const raw = await command(operationPath(threadId, commandId), 'GET', options?.signal);
      fields(raw, ['compaction']); return readThreadCompaction(raw['compaction'], commandId);
    },
    async cancelThreadCompaction(threadId, commandId, options) {
      return readThreadCompactionCancellation(await command(`${operationPath(threadId, commandId)}/cancel`, 'POST', options?.signal));
    },
    async threads(options) {
      const limit = options?.limit ?? 50; const status = options?.status ?? 'active'; const cursor = options?.cursor;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['active', 'archived', 'all'].includes(status) || (cursor !== undefined && !cursorPattern.test(cursor))) invalid('INVALID_CURSOR');
      const query = new URLSearchParams({ status, limit: String(limit), ...(cursor === undefined ? {} : { cursor }) });
      const raw = await command(`/v1/threads?${query}`, 'GET', options?.signal); fields(raw, ['threads', 'cursor']);
      if (!Array.isArray(raw['threads']) || raw['threads'].length > limit || (raw['cursor'] !== null && (typeof raw['cursor'] !== 'string' || !cursorPattern.test(raw['cursor'])))) invalid();
      const threads = (raw['threads'] as unknown[]).map(value => readThread(value));
      if (new Set(threads.map(item => item.id)).size !== threads.length || threads.some(item => !['active', 'archived'].includes(item.status) || (status !== 'all' && item.status !== status))) invalid();
      return Object.freeze({ threads: Object.freeze(threads), cursor: raw['cursor'] as string | null });
    },
    thread: async (id, options) => read(path(id), 'GET', options?.signal, undefined, id),
    createThread: async (value = {}, options) => read('/v1/threads', 'POST', options?.signal, input(value, true), value.id),
    updateThread: async (id, changes, options) => read(path(id), 'POST', options?.signal, input(changes, false), id),
    archiveThread: async (id, options) => read(`${path(id)}/archive`, 'POST', options?.signal, undefined, id),
    restoreThread: async (id, options) => read(`${path(id)}/restore`, 'POST', options?.signal, undefined, id),
    async deleteThread(id, options) { const raw = await command(path(id), 'DELETE', options?.signal); fields(raw, ['removed']); return Object.freeze({ removed: number(raw['removed']) }); },
    async threadEntries(id, options) {
      const limit = options?.limit ?? 100; const after = options?.after; const before = options?.before;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (after !== undefined && before !== undefined)
        || [after, before].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000))) invalid('INVALID_CURSOR');
      const query = new URLSearchParams({ limit: String(limit), ...(after === undefined ? {} : { after: String(after) }), ...(before === undefined ? {} : { before: String(before) }) });
      const raw = await command(`${path(id)}/entries?${query}`, 'GET', options?.signal); fields(raw, ['entries']);
      if (!Array.isArray(raw['entries']) || raw['entries'].length > limit) invalid();
      const entries = (raw['entries'] as unknown[]).map(readThreadEntry); let prior = after ?? 0;
      for (const item of entries) { if (item.sequence <= prior || (before !== undefined && item.sequence >= before)) invalid(); prior = item.sequence; }
      return Object.freeze(entries);
    },
  };
}

/** Content-free lifecycle event schema, shared with the headless validator. */
export function approvalEvent(type: string, metadata: unknown): void {
  const raw = object(metadata);
  if (type === 'approval.requested') {
    fields(raw, ['callId', 'toolId', 'digest', 'expiresAtMs']); shortText(raw['callId']); id(raw['toolId']); number(raw['expiresAtMs'], 1);
    if (typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest'])) invalid();
  } else if (type === 'approval.resolved') {
    fields(raw, ['callId', 'toolId', 'decision'], ['actorId']); shortText(raw['callId']); id(raw['toolId']);
    if (!['approved', 'rejected', 'expired'].includes(String(raw['decision']))) invalid(); if (raw['actorId'] !== undefined) id(raw['actorId']);
  } else { fields(raw, ['callId']); shortText(raw['callId']); }
}
