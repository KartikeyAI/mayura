import type { ClientSession, Collection, Db, Document } from 'mongodb';
import { StorageError, storageError, type MemoryChange, type MemoryEdgeRow, type MemoryIndexMethod, type MemoryIndexStore, type MemoryRow, type MemoryVectorRow } from 'mayura/storage-contracts';
import { memoryIndexFacade } from 'mayura/storage-sql/host';

/** Runs `body` as one transaction; the store's own implementation, which retries transient write conflicts. */
export type Transaction = <T>(body: (session: ClientSession) => Promise<T>) => Promise<T>;

interface RecordDocument {
  scope: string; id: string; version: number; status: MemoryRow['status']; sensitivity: MemoryRow['sensitivity']; body: string | null; termCount: number;
  validFrom: string | null; validUntil: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; supersededBy: string | null;
}
interface EdgeDocument {
  scope: string; id: string; version: number; status: MemoryEdgeRow['status']; from: string; to: string; relation: string; body: string | null;
  validFrom: string | null; validUntil: string | null; createdAt: string; updatedAt: string;
}
interface TermDocument { scope: string; term: string; recordId: string; frequency: number }
interface VectorDocument { scope: string; embedderId: string; recordId: string; recordVersion: number; vector: string; list: number | null }
interface IndexDocument { scope: string; embedderId: string; dimensions: number; trainedAt: number; centroids: string }
interface ChangeDocument { scope: string; sequence: number; kind: MemoryChange['kind']; id: string; version: number; status: string }
interface ScopeDocument { _id: string; sequence: number }

function conflict(message = 'The memory record or edge version changed.'): never { throw new StorageError('CONFLICT', message); }
function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored native memory failed integrity validation.'); }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) corrupt(); return value as number; }
const json = (text: string | null) => { try { return text === null ? null : JSON.parse(text) as Record<string, never>; } catch { return corrupt(); } };
const noId = { projection: { _id: 0 } } as const;

function recordRow(document: RecordDocument): MemoryRow {
  return { id: document.id, version: integer(document.version), status: document.status, sensitivity: document.sensitivity, body: json(document.body), validFrom: document.validFrom,
    validUntil: document.validUntil, createdAt: document.createdAt, updatedAt: document.updatedAt, deletedAt: document.deletedAt, supersededBy: document.supersededBy };
}
function edgeRow(document: EdgeDocument): MemoryEdgeRow {
  return { id: document.id, version: integer(document.version), status: document.status, from: document.from, to: document.to, relation: document.relation,
    body: json(document.body), validFrom: document.validFrom, validUntil: document.validUntil, createdAt: document.createdAt, updatedAt: document.updatedAt };
}
/**
 * Authorized, current, active: the only records ranking and traversal may ever see. As in SQL, a record without a
 * `validFrom` is never current (a missing value fails the comparison), and a missing `validUntil` never expires.
 */
function visible(sensitivities: readonly string[], asOf: string, prefix = ''): Document {
  return { [`${prefix}status`]: 'active', [`${prefix}sensitivity`]: { $in: [...sensitivities] }, [`${prefix}validFrom`]: { $lte: asOf },
    $or: [{ [`${prefix}validUntil`]: null }, { [`${prefix}validUntil`]: { $gt: asOf } }] };
}

/**
 * Native memory on MongoDB, command for command what the SQL layer does. Every mutation is one transaction; writes to a
 * scope go through that scope's document, so concurrent writers to a scope conflict and one is retried, and its counter
 * gives the scope's change sequence without gaps.
 */
export function mongoMemory(db: Db, transaction: Transaction, available: () => void): MemoryIndexStore {
  const records: Collection<RecordDocument> = db.collection('mayura_memory_records');
  const terms: Collection<TermDocument> = db.collection('mayura_memory_terms');
  const edges: Collection<EdgeDocument> = db.collection('mayura_memory_edges');
  const vectors: Collection<VectorDocument> = db.collection('mayura_memory_vectors');
  const indexes: Collection<IndexDocument> = db.collection('mayura_memory_indexes');
  const changes: Collection<ChangeDocument> = db.collection('mayura_memory_changes');
  const scopes: Collection<ScopeDocument> = db.collection('mayura_memory_scopes');
  let initialized = false;

  /** Serializes the scope's writers: every mutation writes the scope's document. */
  const lockScope = (session: ClientSession, scope: string) => scopes.updateOne({ _id: scope }, { $setOnInsert: { sequence: 0 } }, { upsert: true, session });
  const change = async (session: ClientSession, scope: string, kind: MemoryChange['kind'], id: string, version: number, status: string): Promise<number> => {
    const bumped = await scopes.findOneAndUpdate({ _id: scope }, { $inc: { sequence: 1 } }, { upsert: true, returnDocument: 'after', session });
    const sequence = integer(bumped?.sequence);
    await changes.insertOne({ scope, sequence, kind, id, version, status }, { session });
    return sequence;
  };
  const corpus = async (session: ClientSession | undefined, scope: string, sensitivities: readonly string[], asOf: string) => {
    const [stats] = await records.aggregate<{ documents: number; total: number }>([{ $match: { scope, ...visible(sensitivities, asOf) } },
      { $group: { _id: null, documents: { $sum: 1 }, total: { $sum: '$termCount' } } }], session ? { session } : {}).toArray();
    return { documents: integer(stats?.documents ?? 0), total: integer(stats?.total ?? 0) };
  };
  /** Joins documents to the visible record `localField` names, keeping only those with one. */
  const joinVisible = (localField: string, as: string, sensitivities: readonly string[], asOf: string, extra: Document = {}): Document[] => [
    { $lookup: { from: 'mayura_memory_records', let: { scope: '$scope', id: `$${localField}` }, as,
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$scope', '$$scope'] }, { $eq: ['$id', '$$id'] }] }, ...visible(sensitivities, asOf), ...extra } }, { $project: { _id: 0 } }] } },
    { $unwind: `$${as}` },
  ];

  const dispatch = async (method: MemoryIndexMethod, command: Record<string, unknown>): Promise<unknown> => {
    const scope = command['scope'] as string;
    switch (method) {
      case 'putRecord': return transaction(async session => {
        await lockScope(session, scope);
        const row = command['record'] as MemoryRow; const expected = command['expectedVersion'] as number; const postings = command['terms'] as [string, number][];
        const current = await records.findOne({ scope, id: row.id }, { ...noId, session });
        if ((current ? integer(current.version) : 0) !== expected) conflict();
        if (current?.status === 'deleted') conflict('A deleted memory record cannot be replaced.');
        const document: RecordDocument = { scope, id: row.id, version: row.version, status: row.status, sensitivity: row.sensitivity, body: row.body === null ? null : JSON.stringify(row.body),
          termCount: postings.reduce((sum, [, frequency]) => sum + frequency, 0), validFrom: row.validFrom, validUntil: row.validUntil, createdAt: row.createdAt,
          updatedAt: row.updatedAt, deletedAt: row.deletedAt, supersededBy: row.supersededBy };
        await records.replaceOne({ scope, id: row.id }, document, { upsert: true, session });
        await terms.deleteMany({ scope, recordId: row.id }, { session });
        if (postings.length) await terms.insertMany(postings.map(([term, frequency]) => ({ scope, term, recordId: row.id, frequency })), { session });
        // Stale vectors never survive a content change; inactive records keep none.
        await vectors.deleteMany({ scope, recordId: row.id }, { session });
        if (row.status === 'deleted') {
          const touching = await edges.find({ scope, status: 'active', $or: [{ from: row.id }, { to: row.id }] }, { ...noId, session }).toArray();
          for (const edge of touching) {
            const version = integer(edge.version) + 1;
            await edges.updateOne({ scope, id: edge.id }, { $set: { status: 'deleted', version, body: null, validFrom: null, validUntil: null, updatedAt: row.updatedAt } }, { session });
            await change(session, scope, 'edge', edge.id, version, 'deleted');
          }
        }
        return { record: row, sequence: await change(session, scope, 'record', row.id, row.version, row.status) };
      });
      case 'getRecords': {
        const ids = command['ids'] as string[]; if (ids.length === 0) return [];
        return (await records.find({ scope, id: { $in: ids } }, noId).sort({ id: 1 }).toArray()).map(recordRow);
      }
      case 'listRecords': {
        const statuses = command['statuses'] as string[]; const sensitivities = command['sensitivities'] as string[];
        if (statuses.length === 0 || sensitivities.length === 0) return [];
        const after = command['after'] as string | undefined;
        return (await records.find({ scope, status: { $in: statuses as never[] }, sensitivity: { $in: sensitivities as never[] }, ...(after === undefined ? {} : { id: { $gt: after } }) }, noId)
          .sort({ id: 1 }).limit(command['limit'] as number).toArray()).map(recordRow);
      }
      case 'postings': {
        const wanted = command['terms'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        if (wanted.length === 0 || sensitivities.length === 0) return { documents: 0, averageLength: 0, postings: [] };
        return transaction(async session => {
          const { documents, total } = await corpus(session, scope, sensitivities, asOf);
          const rows = await terms.aggregate<{ recordId: string; term: string; frequency: number; record: RecordDocument }>([
            { $match: { scope, term: { $in: wanted } } }, ...joinVisible('recordId', 'record', sensitivities, asOf),
            { $sort: { recordId: 1, term: 1 } }, { $limit: command['limit'] as number }], { session }).toArray();
          return { documents, averageLength: documents === 0 ? 0 : total / documents,
            postings: rows.map(row => ({ id: row.recordId, term: row.term, frequency: integer(row.frequency), length: Math.max(1, integer(row.record.termCount)) })) };
        });
      }
      case 'rank': {
        const wanted = command['terms'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        if (wanted.length === 0 || sensitivities.length === 0) return { documents: 0, hits: [] };
        return transaction(async session => {
          const { documents, total } = await corpus(session, scope, sensitivities, asOf);
          if (documents === 0) return { documents: 0, hits: [] };
          const average = Math.max(1, total / documents);
          const frequencies = await terms.aggregate<{ _id: string; df: number }>([{ $match: { scope, term: { $in: wanted } } }, ...joinVisible('recordId', 'record', sensitivities, asOf),
            { $group: { _id: '$term', df: { $sum: 1 } } }], { session }).toArray();
          const weights = frequencies.map(row => [row._id, Math.log(1 + (documents - row.df + 0.5) / (row.df + 0.5))] as const);
          if (weights.length === 0) return { documents, hits: [] };
          // Okapi BM25 (k1 = 1.2, b = 0.75), ranked and limited by the database so only the top hits leave it.
          const weight = { $switch: { branches: weights.map(([term, value]) => ({ case: { $eq: ['$term', term] }, then: value })), default: 0 } };
          const score = { $divide: [{ $multiply: [weight, { $multiply: ['$frequency', 2.2] }] },
            { $add: ['$frequency', { $multiply: [1.2, { $add: [0.25, { $multiply: [0.75, { $divide: ['$record.termCount', average] }] }] }] }] }] };
          const hits = await terms.aggregate<{ _id: string; score: number }>([{ $match: { scope, term: { $in: weights.map(([term]) => term) } } }, ...joinVisible('recordId', 'record', sensitivities, asOf),
            { $group: { _id: '$recordId', score: { $sum: score } } }, { $sort: { score: -1, _id: 1 } }, { $limit: command['limit'] as number }], { session }).toArray();
          return { documents, hits: hits.map(hit => ({ id: hit._id, score: hit.score })) };
        });
      }
      case 'putEdge': return transaction(async session => {
        await lockScope(session, scope);
        const edge = command['edge'] as MemoryEdgeRow; const expected = command['expectedVersion'] as number;
        const current = await edges.findOne({ scope, id: edge.id }, { ...noId, session });
        if ((current ? integer(current.version) : 0) !== expected) conflict();
        if (current?.status === 'deleted') conflict('A deleted memory edge cannot be replaced.');
        if (current && (current.from !== edge.from || current.to !== edge.to)) conflict('Memory edge endpoints are immutable.');
        // As in SQL, both endpoints must be distinct active records: an edge from a record to itself finds only one.
        if (edge.status === 'active' && await records.countDocuments({ scope, status: 'active', id: { $in: [edge.from, edge.to] } }, { session }) !== 2) {
          conflict('Both memory edge endpoints must be active records in this scope.');
        }
        await edges.replaceOne({ scope, id: edge.id }, { scope, id: edge.id, version: edge.version, status: edge.status, from: edge.from, to: edge.to, relation: edge.relation,
          body: edge.body === null ? null : JSON.stringify(edge.body), validFrom: edge.validFrom, validUntil: edge.validUntil, createdAt: edge.createdAt, updatedAt: edge.updatedAt },
        { upsert: true, session });
        return { edge, sequence: await change(session, scope, 'edge', edge.id, edge.version, edge.status) };
      });
      case 'getEdge': {
        const found = await edges.findOne({ scope, id: command['id'] as string }, noId);
        return found ? edgeRow(found) : undefined;
      }
      case 'listEdges': {
        const after = command['after'] as string | undefined;
        return (await edges.find({ scope, ...(after === undefined ? {} : { id: { $gt: after } }) }, noId).sort({ id: 1 }).limit(command['limit'] as number).toArray()).map(edgeRow);
      }
      case 'edges': {
        const ids = command['recordIds'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        const relations = command['relations'] as string[] | undefined; const direction = command['direction'] as string; const limit = command['limit'] as number;
        if (ids.length === 0 || sensitivities.length === 0 || relations?.length === 0) return [];
        const sides = direction === 'out' ? [['from', 'to']] : direction === 'in' ? [['to', 'from']] : [['from', 'to'], ['to', 'from']];
        const rows: EdgeDocument[] = []; const seen = new Set<string>();
        for (const [near, far] of sides as [string, string][]) {
          const found = await edges.aggregate<EdgeDocument>([
            { $match: { scope, status: 'active', [near]: { $in: ids }, ...(relations ? { relation: { $in: relations } } : {}),
              $and: [{ $or: [{ validFrom: null }, { validFrom: { $lte: asOf } }] }, { $or: [{ validUntil: null }, { validUntil: { $gt: asOf } }] }] } },
            ...joinVisible(near, 'nearRecord', sensitivities, asOf), ...joinVisible(far, 'farRecord', sensitivities, asOf),
            { $sort: { id: 1 } }, { $limit: limit }, { $project: { _id: 0, nearRecord: 0, farRecord: 0 } }]).toArray();
          for (const row of found) if (!seen.has(row.id) && rows.length < limit) { seen.add(row.id); rows.push(row); }
        }
        return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(edgeRow);
      }
      case 'putVectors': return transaction(async session => {
        const entries = command['entries'] as MemoryVectorRow[]; const embedderId = command['embedderId'] as string;
        if (entries.length === 0) return { written: 0, stale: [] };
        const current = new Map((await records.find({ scope, status: 'active', id: { $in: entries.map(entry => entry.recordId) } }, { projection: { _id: 0, id: 1, version: 1 }, session }).toArray())
          .map(row => [row.id, integer(row.version)]));
        const known = await indexes.findOne({ scope, embedderId }, { ...noId, session });
        if (known && integer(known.dimensions) !== command['dimensions']) conflict('The embedder dimensions changed; use a new embedder id.');
        const stale: string[] = []; let written = 0;
        for (const entry of entries) {
          if (current.get(entry.recordId) !== entry.recordVersion) { stale.push(entry.recordId); continue; }
          await vectors.replaceOne({ scope, embedderId, recordId: entry.recordId }, { scope, embedderId, recordId: entry.recordId, recordVersion: entry.recordVersion, vector: entry.vector, list: entry.list },
            { upsert: true, session });
          written++;
        }
        if (!known) await indexes.insertOne({ scope, embedderId, dimensions: command['dimensions'] as number, trainedAt: 0, centroids: '[]' }, { session });
        return { written, stale };
      });
      case 'missingVectors': {
        const sensitivities = command['sensitivities'] as string[]; if (sensitivities.length === 0) return [];
        const rows = await records.aggregate<{ id: string; version: number }>([
          { $match: { scope, status: 'active', sensitivity: { $in: sensitivities } } },
          { $lookup: { from: 'mayura_memory_vectors', let: { scope: '$scope', id: '$id', version: '$version' }, as: 'current',
            pipeline: [{ $match: { embedderId: command['embedderId'], $expr: { $and: [{ $eq: ['$scope', '$$scope'] }, { $eq: ['$recordId', '$$id'] }, { $eq: ['$recordVersion', '$$version'] }] } } }, { $limit: 1 }] } },
          { $match: { current: { $size: 0 } } }, { $sort: { id: 1 } }, { $limit: command['limit'] as number }, { $project: { _id: 0, id: 1, version: 1 } }]).toArray();
        return rows.map(row => ({ id: row.id, version: integer(row.version) }));
      }
      case 'vectors': {
        const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string; const lists = command['lists'] as number[] | undefined;
        const after = command['after'] as string | undefined;
        if (sensitivities.length === 0) return [];
        const listed = lists === undefined ? {} : { $or: [{ list: null }, ...(lists.length > 0 ? [{ list: { $in: lists } }] : [])] };
        const rows = await vectors.aggregate<VectorDocument>([
          { $match: { scope, embedderId: command['embedderId'], ...listed, ...(after === undefined ? {} : { recordId: { $gt: after } }) } },
          { $lookup: { from: 'mayura_memory_records', let: { scope: '$scope', id: '$recordId', version: '$recordVersion' }, as: 'record',
            pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$scope', '$$scope'] }, { $eq: ['$id', '$$id'] }, { $eq: ['$version', '$$version'] }] }, ...visible(sensitivities, asOf) } }, { $limit: 1 }] } },
          { $unwind: '$record' }, { $sort: { recordId: 1 } }, { $limit: command['limit'] as number }, { $project: { _id: 0, record: 0 } }]).toArray();
        return rows.map(row => ({ recordId: row.recordId, recordVersion: integer(row.recordVersion), vector: row.vector, list: row.list === null ? null : integer(row.list) }));
      }
      case 'indexState': return transaction(async session => {
        const index = await indexes.findOne({ scope, embedderId: command['embedderId'] as string }, { ...noId, session });
        const count = await vectors.countDocuments({ scope, embedderId: command['embedderId'] as string }, { session });
        return { vectors: count, trainedAt: index ? integer(index.trainedAt) : 0, dimensions: index ? integer(index.dimensions) : 0, centroids: index ? json(index.centroids) ?? [] : [] };
      });
      case 'setCentroids': return transaction(async session => {
        await lockScope(session, scope);
        const updated = await indexes.updateOne({ scope, embedderId: command['embedderId'] as string, dimensions: command['dimensions'] as number },
          { $set: { centroids: JSON.stringify(command['centroids']), trainedAt: command['trainedAt'] as number } }, { session });
        if (updated.matchedCount !== 1) conflict('The memory vector index does not exist or has different dimensions.');
        await vectors.updateMany({ scope, embedderId: command['embedderId'] as string }, { $set: { list: null } }, { session });
        return undefined;
      });
      case 'assignLists': return transaction(async session => {
        let assigned = 0;
        for (const [recordId, list] of command['entries'] as [string, number][]) {
          assigned += (await vectors.updateOne({ scope, embedderId: command['embedderId'] as string, recordId }, { $set: { list } }, { session })).matchedCount;
        }
        return assigned;
      });
      case 'changes': {
        const rows = await changes.find({ scope, sequence: { $gt: command['after'] as number } }, noId).sort({ sequence: 1 }).limit(command['limit'] as number).toArray();
        return rows.map((row): MemoryChange => ({ sequence: integer(row.sequence), kind: row.kind, id: row.id, version: integer(row.version), status: row.status }));
      }
      case 'stats': return transaction(async session => {
        // A transaction's operations run one at a time: MongoDB refuses concurrent ones on the same session.
        const recordCount = await records.countDocuments({ scope, status: 'active' }, { session });
        const edgeCount = await edges.countDocuments({ scope, status: 'active' }, { session });
        const head = await scopes.findOne({ _id: scope }, { session });
        return { records: recordCount, edges: edgeCount, sequence: head ? integer(head.sequence) : 0 };
      });
      default: return corrupt();
    }
  };

  return memoryIndexFacade(async (method, input) => {
    available();
    if (method === 'initialize') {
      if (!initialized) try {
        await records.createIndexes([{ key: { scope: 1, id: 1 }, name: 'mayura_memory_records_id', unique: true }, { key: { scope: 1, status: 1, sensitivity: 1, id: 1 }, name: 'mayura_memory_records_status' }]);
        await terms.createIndexes([{ key: { scope: 1, term: 1, recordId: 1 }, name: 'mayura_memory_terms_term', unique: true }, { key: { scope: 1, recordId: 1 }, name: 'mayura_memory_terms_record' }]);
        await edges.createIndexes([{ key: { scope: 1, id: 1 }, name: 'mayura_memory_edges_id', unique: true }, { key: { scope: 1, from: 1, status: 1 }, name: 'mayura_memory_edges_from' },
          { key: { scope: 1, to: 1, status: 1 }, name: 'mayura_memory_edges_to' }]);
        await vectors.createIndexes([{ key: { scope: 1, embedderId: 1, recordId: 1 }, name: 'mayura_memory_vectors_id', unique: true }, { key: { scope: 1, embedderId: 1, list: 1 }, name: 'mayura_memory_vectors_list' }]);
        await indexes.createIndexes([{ key: { scope: 1, embedderId: 1 }, name: 'mayura_memory_indexes_id', unique: true }]);
        await changes.createIndexes([{ key: { scope: 1, sequence: 1 }, name: 'mayura_memory_changes_sequence', unique: true }]);
        initialized = true;
      } catch (error) { throw storageError(error); }
      return undefined;
    }
    if (!initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize native memory storage before use.');
    try { return await dispatch(method, input as Record<string, unknown>); }
    catch (error) { throw error instanceof StorageError ? error : storageError(error); }
  });
}
