import { freezeJson, jsonValue, type JsonObject } from '@mayura/core';
import { StorageError, type AggregateStore } from './contracts.js';

/**
 * Table-backed native memory persistence. The store owns atomicity, compare-and-set, index maintenance and
 * authorization filtering inside queries; `@mayura/memory` owns record semantics, permissions and hooks.
 */
export type MemoryRowStatus = 'active' | 'superseded' | 'deleted';
export type MemoryRowSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export interface MemoryRow {
  readonly id: string;
  readonly version: number;
  readonly status: MemoryRowStatus;
  readonly sensitivity: MemoryRowSensitivity;
  /** Record content and provenance; `null` for a tombstone, which retains no content. */
  readonly body: JsonObject | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly supersededBy: string | null;
}
export interface MemoryEdgeRow {
  readonly id: string;
  readonly version: number;
  readonly status: 'active' | 'deleted';
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly body: JsonObject | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MemoryVectorRow { readonly recordId: string; readonly recordVersion: number; readonly vector: string; readonly list: number | null }
export interface MemoryChange { readonly sequence: number; readonly kind: 'record' | 'edge'; readonly id: string; readonly version: number; readonly status: string }
/** Authorization filter applied inside every read query. */
export interface MemoryFilter { readonly sensitivities: readonly MemoryRowSensitivity[]; readonly asOf: string }

export interface MemoryIndexStore {
  initialize(): Promise<void>;
  /** CAS on `expectedVersion` (0 = must not exist). A tombstone is never replaced. Maintains terms, vectors and edges atomically. */
  putRecord(command: { readonly scope: string; readonly record: MemoryRow; readonly expectedVersion: number; readonly terms: readonly (readonly [string, number])[] }):
    Promise<{ readonly record: MemoryRow; readonly sequence: number }>;
  getRecords(command: { readonly scope: string; readonly ids: readonly string[] }): Promise<readonly MemoryRow[]>;
  listRecords(command: { readonly scope: string; readonly after?: string; readonly limit: number; readonly statuses: readonly MemoryRowStatus[]; readonly sensitivities: readonly MemoryRowSensitivity[] }):
    Promise<readonly MemoryRow[]>;
  /** Postings for authorized, current, active records, plus corpus statistics for ranking. */
  postings(command: { readonly scope: string; readonly terms: readonly string[]; readonly limit: number } & MemoryFilter):
    Promise<{ readonly documents: number; readonly averageLength: number; readonly postings: readonly { readonly id: string; readonly term: string; readonly frequency: number; readonly length: number }[] }>;
  /** CAS edge write. An active edge requires both endpoints to be active records in scope. */
  putEdge(command: { readonly scope: string; readonly edge: MemoryEdgeRow; readonly expectedVersion: number }): Promise<{ readonly edge: MemoryEdgeRow; readonly sequence: number }>;
  getEdge(command: { readonly scope: string; readonly id: string }): Promise<MemoryEdgeRow | undefined>;
  /** Every edge, including tombstones, in id order (for export). */
  listEdges(command: { readonly scope: string; readonly after?: string; readonly limit: number }): Promise<readonly MemoryEdgeRow[]>;
  /** Active, current edges touching the given records whose other endpoint is also authorized. */
  edges(command: { readonly scope: string; readonly recordIds: readonly string[]; readonly direction: 'out' | 'in' | 'both'; readonly relations?: readonly string[]; readonly limit: number } & MemoryFilter):
    Promise<readonly MemoryEdgeRow[]>;
  /** Stores vectors for exact record versions; entries for changed or inactive records are reported stale and not written. */
  putVectors(command: { readonly scope: string; readonly embedderId: string; readonly dimensions: number; readonly entries: readonly MemoryVectorRow[] }):
    Promise<{ readonly written: number; readonly stale: readonly string[] }>;
  /** Active records in the profile lacking a current vector for the embedder. */
  missingVectors(command: { readonly scope: string; readonly embedderId: string; readonly sensitivities: readonly MemoryRowSensitivity[]; readonly limit: number }):
    Promise<readonly { readonly id: string; readonly version: number }[]>;
  /** Vectors of authorized current records; `lists` restricts to IVF lists plus not-yet-assigned vectors. */
  vectors(command: { readonly scope: string; readonly embedderId: string; readonly lists?: readonly number[]; readonly after?: string; readonly limit: number } & MemoryFilter):
    Promise<readonly MemoryVectorRow[]>;
  indexState(command: { readonly scope: string; readonly embedderId: string }):
    Promise<{ readonly vectors: number; readonly trainedAt: number; readonly dimensions: number; readonly centroids: readonly string[] }>;
  /** Replace the IVF centroids; every vector becomes unassigned until `assignLists`. */
  setCentroids(command: { readonly scope: string; readonly embedderId: string; readonly dimensions: number; readonly centroids: readonly string[]; readonly trainedAt: number }): Promise<void>;
  assignLists(command: { readonly scope: string; readonly embedderId: string; readonly entries: readonly (readonly [string, number])[] }): Promise<number>;
  changes(command: { readonly scope: string; readonly after: number; readonly limit: number }): Promise<readonly MemoryChange[]>;
  stats(command: { readonly scope: string }): Promise<{ readonly records: number; readonly edges: number; readonly sequence: number }>;
}
export interface MemoryIndexAggregateStore extends AggregateStore { readonly memory: MemoryIndexStore }
export type MemoryIndexMethod = keyof MemoryIndexStore;

const methods = new Set<MemoryIndexMethod>(['initialize', 'putRecord', 'getRecords', 'listRecords', 'postings', 'putEdge', 'getEdge', 'listEdges', 'edges',
  'putVectors', 'missingVectors', 'vectors', 'indexState', 'setCentroids', 'assignLists', 'changes', 'stats']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const scopeKey = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const sensitivities: readonly MemoryRowSensitivity[] = ['public', 'internal', 'confidential', 'restricted'];
const statuses: readonly MemoryRowStatus[] = ['active', 'superseded', 'deleted'];
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Decoded byte length of canonical base64 without Node buffers (this package is runtime-neutral). */
function decodedBytes(value: string): number { return value.length % 4 !== 0 ? -1 : value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0); }
export const MEMORY_MAX_BODY_BYTES = 65_536;
export const MEMORY_MAX_BATCH = 1_000;

function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded native memory command.'); }
function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Native memory storage failed integrity validation.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function id(value: unknown): string { if (typeof value !== 'string' || !identifier.test(value)) invalid(); return value as string; }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(); return value as number;
}
function time(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 32 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value as string;
}
function list<T>(value: unknown, maximum: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(); return (value as unknown[]).map(item);
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function body(value: unknown): JsonObject | null {
  if (value === null) return null;
  try { const parsed = jsonValue(value, { maxBytes: MEMORY_MAX_BODY_BYTES, maxDepth: 12 }); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid(); return parsed as JsonObject; }
  catch { return invalid(); }
}
function vector(value: unknown): string { if (typeof value !== 'string' || value.length === 0 || value.length > 65_536 || !base64.test(value)) invalid(); return value as string; }
function filter(value: Record<string, unknown>): MemoryFilter {
  return { sensitivities: list(value['sensitivities'], 4, entry => member(entry, sensitivities)), asOf: time(value['asOf'])! };
}

export function memoryRow(value: unknown): MemoryRow {
  const row = record(value);
  keys(row, ['id', 'version', 'status', 'sensitivity', 'body', 'validFrom', 'validUntil', 'createdAt', 'updatedAt', 'deletedAt', 'supersededBy']);
  const status = member(row['status'], statuses); const content = body(row['body']);
  const result: MemoryRow = { id: id(row['id']), version: integer(row['version'], 1), status, sensitivity: member(row['sensitivity'], sensitivities), body: content,
    validFrom: time(row['validFrom'], true), validUntil: time(row['validUntil'], true), createdAt: time(row['createdAt'])!, updatedAt: time(row['updatedAt'])!,
    deletedAt: time(row['deletedAt'], true), supersededBy: row['supersededBy'] === null ? null : id(row['supersededBy']) };
  // A tombstone carries no content and no validity; live records carry both.
  if ((status === 'deleted') !== (content === null) || (status === 'deleted') !== (result.deletedAt !== null)
    || (status === 'deleted') !== (result.validFrom === null) || (status === 'superseded') !== (result.supersededBy !== null)) invalid();
  return result;
}
export function memoryEdgeRow(value: unknown): MemoryEdgeRow {
  const row = record(value);
  keys(row, ['id', 'version', 'status', 'from', 'to', 'relation', 'body', 'validFrom', 'validUntil', 'createdAt', 'updatedAt']);
  const status = member(row['status'], ['active', 'deleted'] as const); const content = body(row['body']);
  const result: MemoryEdgeRow = { id: id(row['id']), version: integer(row['version'], 1), status, from: id(row['from']), to: id(row['to']), relation: id(row['relation']),
    body: content, validFrom: time(row['validFrom'], true), validUntil: time(row['validUntil'], true), createdAt: time(row['createdAt'])!, updatedAt: time(row['updatedAt'])! };
  if ((status === 'deleted') !== (content === null) || (status === 'deleted') !== (result.validFrom === null) || result.from === result.to) invalid();
  return result;
}
function vectorRow(value: unknown): MemoryVectorRow {
  const row = record(value); keys(row, ['recordId', 'recordVersion', 'vector', 'list']);
  return { recordId: id(row['recordId']), recordVersion: integer(row['recordVersion'], 1), vector: vector(row['vector']), list: row['list'] === null ? null : integer(row['list'], 0, 1_023) };
}

/** Validate and snapshot a command before it crosses a process or database boundary. */
export function memoryIndexCommand(method: MemoryIndexMethod, value: unknown): JsonObject {
  if (!methods.has(method)) invalid();
  const input = record(value); const scope = method === 'initialize' ? undefined : input['scope'];
  if (scope !== undefined && (typeof scope !== 'string' || !scopeKey.test(scope))) invalid();
  let output: Record<string, unknown>;
  switch (method) {
    case 'initialize': keys(input, []); output = {}; break;
    case 'putRecord': {
      keys(input, ['scope', 'record', 'expectedVersion', 'terms']);
      const row = memoryRow(input['record']); const expectedVersion = integer(input['expectedVersion']);
      if (row.version <= expectedVersion) invalid();
      const terms = list(input['terms'], 4_096, entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length === 0 || entry[0].length > 64) invalid();
        return [entry[0] as string, integer(entry[1], 1, 1_000_000)] as const;
      });
      if (new Set(terms.map(([term]) => term)).size !== terms.length || (row.status !== 'active' && terms.length > 0)) invalid();
      output = { scope, record: row, expectedVersion, terms }; break;
    }
    case 'getRecords': keys(input, ['scope', 'ids']); output = { scope, ids: list(input['ids'], MEMORY_MAX_BATCH, id) }; break;
    case 'listRecords':
      keys(input, ['scope', 'limit', 'statuses', 'sensitivities'], ['after']);
      output = { scope, limit: integer(input['limit'], 1, MEMORY_MAX_BATCH), statuses: list(input['statuses'], 3, entry => member(entry, statuses)),
        sensitivities: list(input['sensitivities'], 4, entry => member(entry, sensitivities)), ...(input['after'] === undefined ? {} : { after: id(input['after']) }) }; break;
    case 'postings':
      keys(input, ['scope', 'terms', 'limit', 'sensitivities', 'asOf']);
      output = { scope, terms: list(input['terms'], 32, entry => { if (typeof entry !== 'string' || entry.length === 0 || entry.length > 64) invalid(); return entry; }),
        limit: integer(input['limit'], 1, 100_000), ...filter(input) }; break;
    case 'putEdge': {
      keys(input, ['scope', 'edge', 'expectedVersion']); const edge = memoryEdgeRow(input['edge']); const expectedVersion = integer(input['expectedVersion']);
      if (edge.version <= expectedVersion) invalid(); output = { scope, edge, expectedVersion }; break;
    }
    case 'getEdge': keys(input, ['scope', 'id']); output = { scope, id: id(input['id']) }; break;
    case 'listEdges': keys(input, ['scope', 'limit'], ['after']); output = { scope, limit: integer(input['limit'], 1, MEMORY_MAX_BATCH), ...(input['after'] === undefined ? {} : { after: id(input['after']) }) }; break;
    case 'edges':
      keys(input, ['scope', 'recordIds', 'direction', 'limit', 'sensitivities', 'asOf'], ['relations']);
      output = { scope, recordIds: list(input['recordIds'], MEMORY_MAX_BATCH, id), direction: member(input['direction'], ['out', 'in', 'both'] as const),
        limit: integer(input['limit'], 1, 10_000), ...filter(input), ...(input['relations'] === undefined ? {} : { relations: list(input['relations'], 32, id) }) }; break;
    case 'putVectors': {
      keys(input, ['scope', 'embedderId', 'dimensions', 'entries']);
      const dimensions = integer(input['dimensions'], 1, 4_096);
      const entries = list(input['entries'], MEMORY_MAX_BATCH, vectorRow);
      if (entries.some(entry => decodedBytes(entry.vector) !== dimensions * 4) || new Set(entries.map(entry => entry.recordId)).size !== entries.length) invalid();
      output = { scope, embedderId: id(input['embedderId']), dimensions, entries }; break;
    }
    case 'missingVectors':
      keys(input, ['scope', 'embedderId', 'sensitivities', 'limit']);
      output = { scope, embedderId: id(input['embedderId']), sensitivities: list(input['sensitivities'], 4, entry => member(entry, sensitivities)), limit: integer(input['limit'], 1, MEMORY_MAX_BATCH) }; break;
    case 'vectors':
      keys(input, ['scope', 'embedderId', 'limit', 'sensitivities', 'asOf'], ['lists', 'after']);
      output = { scope, embedderId: id(input['embedderId']), limit: integer(input['limit'], 1, 5_000), ...filter(input),
        ...(input['lists'] === undefined ? {} : { lists: list(input['lists'], 1_024, entry => integer(entry, 0, 1_023)) }),
        ...(input['after'] === undefined ? {} : { after: id(input['after']) }) }; break;
    case 'indexState': keys(input, ['scope', 'embedderId']); output = { scope, embedderId: id(input['embedderId']) }; break;
    case 'setCentroids': {
      keys(input, ['scope', 'embedderId', 'dimensions', 'centroids', 'trainedAt']);
      const dimensions = integer(input['dimensions'], 1, 4_096); const centroids = list(input['centroids'], 1_024, vector);
      if (centroids.some(entry => decodedBytes(entry) !== dimensions * 4)) invalid();
      output = { scope, embedderId: id(input['embedderId']), dimensions, centroids, trainedAt: integer(input['trainedAt']) }; break;
    }
    case 'assignLists':
      keys(input, ['scope', 'embedderId', 'entries']);
      output = { scope, embedderId: id(input['embedderId']), entries: list(input['entries'], 10_000, entry => {
        if (!Array.isArray(entry) || entry.length !== 2) invalid(); return [id(entry[0]), integer(entry[1], 0, 1_023)] as const; }) }; break;
    case 'changes': keys(input, ['scope', 'after', 'limit']); output = { scope, after: integer(input['after']), limit: integer(input['limit'], 1, MEMORY_MAX_BATCH) }; break;
    case 'stats': keys(input, ['scope']); output = { scope }; break;
  }
  return freezeJson(jsonValue(output!, { maxBytes: 64 * 1_048_576, maxNodes: 2_000_000 })) as JsonObject;
}

/** Revalidate adapter results against the command that produced them. */
export function memoryIndexResult(method: MemoryIndexMethod, value: unknown, command: JsonObject): unknown {
  try {
    switch (method) {
      case 'initialize': case 'setCentroids': if (value !== undefined && value !== null) corrupt(); return undefined;
      case 'putRecord': {
        const result = record(value); keys(result, ['record', 'sequence']); const row = memoryRow(result['record']);
        if (JSON.stringify(row) !== JSON.stringify(command['record'])) corrupt();
        return freezeJson(jsonValue({ record: row, sequence: integer(result['sequence'], 1) }));
      }
      case 'getRecords': case 'listRecords': {
        const rows = list(value, MEMORY_MAX_BATCH, memoryRow);
        if (method === 'getRecords' && rows.some(row => !(command['ids'] as string[]).includes(row.id))) corrupt();
        if (method === 'listRecords' && (rows.length > (command['limit'] as number) || rows.some(row => !(command['statuses'] as string[]).includes(row.status)
          || !(command['sensitivities'] as string[]).includes(row.sensitivity)))) corrupt();
        return freezeJson(jsonValue(rows));
      }
      case 'postings': {
        const result = record(value); keys(result, ['documents', 'averageLength', 'postings']);
        const averageLength = result['averageLength'];
        if (typeof averageLength !== 'number' || !Number.isFinite(averageLength) || averageLength < 0) corrupt();
        const postings = list(result['postings'], command['limit'] as number, entry => {
          const posting = record(entry); keys(posting, ['id', 'term', 'frequency', 'length']);
          if (!(command['terms'] as string[]).includes(posting['term'] as string)) corrupt();
          return { id: id(posting['id']), term: posting['term'] as string, frequency: integer(posting['frequency'], 1), length: integer(posting['length'], 1) };
        });
        return freezeJson(jsonValue({ documents: integer(result['documents']), averageLength, postings }));
      }
      case 'putEdge': {
        const result = record(value); keys(result, ['edge', 'sequence']); const edge = memoryEdgeRow(result['edge']);
        if (JSON.stringify(edge) !== JSON.stringify(command['edge'])) corrupt();
        return freezeJson(jsonValue({ edge, sequence: integer(result['sequence'], 1) }));
      }
      case 'getEdge': return value === undefined || value === null ? undefined : freezeJson(jsonValue(memoryEdgeRow(value)));
      case 'listEdges': return freezeJson(jsonValue(list(value, command['limit'] as number, memoryEdgeRow)));
      case 'edges': return freezeJson(jsonValue(list(value, command['limit'] as number, entry => {
        const edge = memoryEdgeRow(entry); if (edge.status !== 'active') corrupt(); return edge; })));
      case 'putVectors': {
        const result = record(value); keys(result, ['written', 'stale']);
        return freezeJson(jsonValue({ written: integer(result['written'], 0, MEMORY_MAX_BATCH), stale: list(result['stale'], MEMORY_MAX_BATCH, id) }));
      }
      case 'missingVectors': return freezeJson(jsonValue(list(value, command['limit'] as number, entry => {
        const row = record(entry); keys(row, ['id', 'version']); return { id: id(row['id']), version: integer(row['version'], 1) }; })));
      case 'vectors': return freezeJson(jsonValue(list(value, command['limit'] as number, vectorRow)));
      case 'indexState': {
        const result = record(value); keys(result, ['vectors', 'trainedAt', 'dimensions', 'centroids']);
        return freezeJson(jsonValue({ vectors: integer(result['vectors']), trainedAt: integer(result['trainedAt']), dimensions: integer(result['dimensions']),
          centroids: list(result['centroids'], 1_024, vector) }));
      }
      case 'assignLists': return integer(value, 0, 10_000);
      case 'changes': {
        let previous = command['after'] as number;
        return freezeJson(jsonValue(list(value, command['limit'] as number, entry => {
          const change = record(entry); keys(change, ['sequence', 'kind', 'id', 'version', 'status']);
          const sequence = integer(change['sequence'], 1); if (sequence <= previous) corrupt(); previous = sequence;
          return { sequence, kind: member(change['kind'], ['record', 'edge'] as const), id: id(change['id']), version: integer(change['version'], 1),
            status: member(change['status'], ['active', 'superseded', 'deleted'] as const) };
        })));
      }
      case 'stats': {
        const result = record(value); keys(result, ['records', 'edges', 'sequence']);
        return freezeJson(jsonValue({ records: integer(result['records']), edges: integer(result['edges']), sequence: integer(result['sequence']) }));
      }
    }
  } catch (error) { if (error instanceof StorageError && error.code !== 'INVALID_INPUT') throw error; return corrupt(); }
  return corrupt();
}

/** Client-side facade: validate commands before sending and results after receiving. */
export function memoryIndexFacade(request: (method: MemoryIndexMethod, input: JsonObject) => Promise<unknown>): MemoryIndexStore {
  const call = async <T>(method: MemoryIndexMethod, value: unknown): Promise<T> => {
    const command = memoryIndexCommand(method, value);
    return memoryIndexResult(method, await request(method, command), command) as T;
  };
  return Object.freeze<MemoryIndexStore>({
    initialize: () => call('initialize', {}), putRecord: value => call('putRecord', value), getRecords: value => call('getRecords', value),
    listRecords: value => call('listRecords', value), postings: value => call('postings', value), putEdge: value => call('putEdge', value),
    getEdge: value => call('getEdge', value), listEdges: value => call('listEdges', value), edges: value => call('edges', value), putVectors: value => call('putVectors', value),
    missingVectors: value => call('missingVectors', value), vectors: value => call('vectors', value), indexState: value => call('indexState', value),
    setCentroids: value => call('setCentroids', value), assignLists: value => call('assignLists', value), changes: value => call('changes', value),
    stats: value => call('stats', value),
  });
}
