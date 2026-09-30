import { StorageError, memoryIndexFacade, type MemoryChange, type MemoryEdgeRow, type MemoryIndexStore, type MemoryRow, type MemoryVectorRow } from '@mayura/storage-contracts';
import { compareKeys, key, parts } from './keys.js';
import { json } from './layout.js';
import type { DocumentSession, DocumentTransaction } from './session.js';

/**
 * A scope's memory: `r`+id each record, `t`+id its terms and visibility (what ranking scans), `d`+id each edge,
 * `c`+sequence the change feed, `s` the scope's head, `x`+embedder each vector index.
 */
const memory = (scope: string) => key('mem', scope);
/** The edges touching a record: `o`+edge leaving it, `i`+edge arriving at it. */
const touching = (scope: string, recordId: string) => key('memedge', scope, recordId);
/** One embedder's vectors: `v`+record. */
const vectorsOf = (scope: string, embedderId: string) => key('memvec', scope, embedderId);
const place = { record: (id: string) => key('r', id), terms: (id: string) => key('t', id), edge: (id: string) => key('d', id), change: (sequence: number) => key('c', sequence),
  head: key('s'), index: (embedderId: string) => key('x', embedderId), out: (id: string) => key('o', id), in: (id: string) => key('i', id), vector: (recordId: string) => key('v', recordId) };
const kinds = { record: key('r'), terms: key('t'), edge: key('d'), change: key('c'), index: key('x'), out: key('o'), in: key('i'), vector: key('v') };

interface TermsDocument {
  id: string; version: number; status: MemoryRow['status']; sensitivity: MemoryRow['sensitivity']; validFrom: string | null; validUntil: string | null;
  termCount: number; terms: [string, number][];
}
interface IndexDocument { embedderId: string; dimensions: number; trainedAt: number; centroids: string; epoch: number }
interface VectorDocument { recordId: string; recordVersion: number; vector: string; list: number | null; epoch: number }
function conflict(message = 'The memory record or edge version changed.'): never { throw new StorageError('CONFLICT', message); }
function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored native memory failed integrity validation.'); }
const byId = <T extends { id: string }>(a: T, b: T) => compareKeys(a.id, b.id);
/** Authorized, current, active: as in SQL, a record without `validFrom` is never current and a missing `validUntil` never expires. */
const visible = (row: { status: string; sensitivity: string; validFrom: string | null; validUntil: string | null }, sensitivities: readonly string[], asOf: string) =>
  row.status === 'active' && sensitivities.includes(row.sensitivity) && row.validFrom !== null && row.validFrom <= asOf && (row.validUntil === null || row.validUntil > asOf);
/** Items per transaction for writes that stand alone (vectors, list assignments), within every backend's commit limit. */
const CHUNK = 32;

/** Native memory on documents, command for command what the SQL layer does. Every write to a scope holds its head. */
export function documentMemory(transaction: DocumentTransaction, available: () => void): MemoryIndexStore {
  const change = async (session: DocumentSession, scope: string, kind: MemoryChange['kind'], id: string, version: number, status: string): Promise<number> => {
    const head = json<{ sequence: number }>(await session.get(memory(scope), place.head, true));
    const sequence = (head?.sequence ?? 0) + 1;
    await session.put(memory(scope), place.head, JSON.stringify({ sequence }));
    session.insert(memory(scope), place.change(sequence), JSON.stringify({ sequence, kind, id, version, status } satisfies MemoryChange));
    return sequence;
  };
  const records = async (session: DocumentSession, scope: string, ids: readonly string[]) =>
    (await session.getMany(ids.map(id => ({ partition: memory(scope), sort: place.record(id) })))).map(text => json<MemoryRow>(text));
  /** Every record's terms and visibility in the scope, a page at a time. */
  const allTerms = async (session: DocumentSession, scope: string): Promise<TermsDocument[]> => {
    const rows: TermsDocument[] = []; let cursor: string | undefined;
    for (;;) {
      const page = await session.query(memory(scope), { prefix: kinds.terms, ...(cursor === undefined ? {} : { after: cursor }), limit: 1_000 });
      rows.push(...page.map(item => json<TermsDocument>(item.body)!));
      if (page.length < 1_000) return rows;
      cursor = page[page.length - 1]!.sort;
    }
  };
  const read = <T>(body: (session: DocumentSession) => Promise<T>) => transaction(body);
  const edge = async (session: DocumentSession, scope: string, id: string) => json<MemoryEdgeRow>(await session.get(memory(scope), place.edge(id)));

  const dispatch = async (method: string, command: Record<string, unknown>): Promise<unknown> => {
    const scope = command['scope'] as string;
    switch (method) {
      case 'putRecord': return transaction(async session => {
        await session.get(memory(scope), place.head, true);
        const row = command['record'] as MemoryRow; const expected = command['expectedVersion'] as number; const postings = command['terms'] as [string, number][];
        const current = json<MemoryRow>(await session.get(memory(scope), place.record(row.id)));
        if ((current?.version ?? 0) !== expected) conflict();
        if (current?.status === 'deleted') conflict('A deleted memory record cannot be replaced.');
        await session.put(memory(scope), place.record(row.id), JSON.stringify(row));
        await session.put(memory(scope), place.terms(row.id), JSON.stringify({ id: row.id, version: row.version, status: row.status, sensitivity: row.sensitivity, validFrom: row.validFrom,
          validUntil: row.validUntil, termCount: postings.reduce((sum, [, frequency]) => sum + frequency, 0), terms: postings.map(([term, frequency]) => [term, frequency]) } satisfies TermsDocument));
        // Stale vectors never survive a content change; inactive records keep none.
        for (const index of await session.query(memory(scope), { prefix: kinds.index })) {
          const embedderId = json<IndexDocument>(index.body)!.embedderId;
          if (await session.get(vectorsOf(scope, embedderId), place.vector(row.id)) !== undefined) await session.delete(vectorsOf(scope, embedderId), place.vector(row.id));
        }
        if (row.status === 'deleted') {
          const ids = new Set((await session.query(touching(scope, row.id), { prefix: kinds.out })).map(item => parts(item.sort)[1]!));
          for (const item of await session.query(touching(scope, row.id), { prefix: kinds.in })) ids.add(parts(item.sort)[1]!);
          for (const id of [...ids].sort(compareKeys)) {
            const found = await edge(session, scope, id); if (!found || found.status !== 'active') continue;
            const version = found.version + 1;
            await session.put(memory(scope), place.edge(id), JSON.stringify({ ...found, status: 'deleted', version, body: null, validFrom: null, validUntil: null, updatedAt: row.updatedAt } satisfies MemoryEdgeRow));
            await change(session, scope, 'edge', id, version, 'deleted');
          }
        }
        return { record: row, sequence: await change(session, scope, 'record', row.id, row.version, row.status) };
      });
      case 'getRecords': {
        const ids = command['ids'] as string[]; if (ids.length === 0) return [];
        return read(async session => (await records(session, scope, ids)).filter((row): row is MemoryRow => row !== undefined).sort(byId));
      }
      case 'listRecords': {
        const statuses = command['statuses'] as string[]; const sensitivities = command['sensitivities'] as string[]; const limit = command['limit'] as number;
        if (statuses.length === 0 || sensitivities.length === 0) return [];
        return read(async session => {
          const found: MemoryRow[] = []; let cursor = command['after'] === undefined ? undefined : place.record(command['after'] as string);
          for (;;) {
            const page = await session.query(memory(scope), { prefix: kinds.record, ...(cursor === undefined ? {} : { after: cursor }), limit: 500 });
            for (const item of page) {
              const row = json<MemoryRow>(item.body)!;
              if (statuses.includes(row.status) && sensitivities.includes(row.sensitivity)) { found.push(row); if (found.length >= limit) return found; }
            }
            if (page.length < 500) return found;
            cursor = page[page.length - 1]!.sort;
          }
        });
      }
      case 'postings': {
        const wanted = new Set(command['terms'] as string[]); const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        if (wanted.size === 0 || sensitivities.length === 0) return { documents: 0, averageLength: 0, postings: [] };
        return read(async session => {
          const current = (await allTerms(session, scope)).filter(row => visible(row, sensitivities, asOf));
          const total = current.reduce((sum, row) => sum + row.termCount, 0);
          const postings = current.sort(byId).flatMap(row => row.terms.filter(([term]) => wanted.has(term)).sort(([a], [b]) => compareKeys(a, b))
            .map(([term, frequency]) => ({ id: row.id, term, frequency, length: Math.max(1, row.termCount) })));
          return { documents: current.length, averageLength: current.length === 0 ? 0 : total / current.length, postings: postings.slice(0, command['limit'] as number) };
        });
      }
      case 'rank': {
        const wanted = new Set(command['terms'] as string[]); const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        if (wanted.size === 0 || sensitivities.length === 0) return { documents: 0, hits: [] };
        return read(async session => {
          const current = (await allTerms(session, scope)).filter(row => visible(row, sensitivities, asOf));
          if (current.length === 0) return { documents: 0, hits: [] };
          const average = Math.max(1, current.reduce((sum, row) => sum + row.termCount, 0) / current.length);
          const df = new Map<string, number>();
          for (const row of current) for (const [term] of row.terms) if (wanted.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
          if (df.size === 0) return { documents: current.length, hits: [] };
          const weight = new Map([...df].map(([term, count]) => [term, Math.log(1 + (current.length - count + 0.5) / (count + 0.5))]));
          // Okapi BM25 (k1 = 1.2, b = 0.75), as the SQL and MongoDB stores compute it.
          const hits = current.map(row => ({ id: row.id, score: row.terms.reduce((sum, [term, frequency]) => sum + (weight.has(term)
            ? weight.get(term)! * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * (row.termCount / average))) : 0), 0),
          matched: row.terms.some(([term]) => weight.has(term)) })).filter(hit => hit.matched)
            .sort((a, b) => b.score - a.score || compareKeys(a.id, b.id)).slice(0, command['limit'] as number).map(hit => ({ id: hit.id, score: hit.score }));
          return { documents: current.length, hits };
        });
      }
      case 'putEdge': return transaction(async session => {
        await session.get(memory(scope), place.head, true);
        const row = command['edge'] as MemoryEdgeRow; const expected = command['expectedVersion'] as number;
        const current = await edge(session, scope, row.id);
        if ((current?.version ?? 0) !== expected) conflict();
        if (current?.status === 'deleted') conflict('A deleted memory edge cannot be replaced.');
        if (current && (current.from !== row.from || current.to !== row.to)) conflict('Memory edge endpoints are immutable.');
        // As in SQL, both endpoints must be distinct active records: an edge from a record to itself finds only one.
        if (row.status === 'active' && (await records(session, scope, [...new Set([row.from, row.to])])).filter(found => found?.status === 'active').length !== 2) {
          conflict('Both memory edge endpoints must be active records in this scope.');
        }
        await session.put(memory(scope), place.edge(row.id), JSON.stringify(row));
        if (!current) {
          await session.put(touching(scope, row.from), place.out(row.id), '{}');
          await session.put(touching(scope, row.to), place.in(row.id), '{}');
        }
        return { edge: row, sequence: await change(session, scope, 'edge', row.id, row.version, row.status) };
      });
      case 'getEdge': return read(session => edge(session, scope, command['id'] as string));
      case 'listEdges': return read(async session => (await session.query(memory(scope), { prefix: kinds.edge,
        ...(command['after'] === undefined ? {} : { after: place.edge(command['after'] as string) }), limit: command['limit'] as number })).map(item => json<MemoryEdgeRow>(item.body)!));
      case 'edges': {
        const ids = command['recordIds'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        const relations = command['relations'] as string[] | undefined; const direction = command['direction'] as string; const limit = command['limit'] as number;
        if (ids.length === 0 || sensitivities.length === 0 || relations?.length === 0) return [];
        return read(async session => {
          const sides: ['out' | 'in', 'from' | 'to', 'from' | 'to'][] = direction === 'out' ? [['out', 'from', 'to']] : direction === 'in' ? [['in', 'to', 'from']] : [['out', 'from', 'to'], ['in', 'to', 'from']];
          const rows: MemoryEdgeRow[] = []; const seen = new Set<string>(); const recordCache = new Map<string, MemoryRow | undefined>();
          const current = async (id: string) => { if (!recordCache.has(id)) recordCache.set(id, (await records(session, scope, [id]))[0]); const row = recordCache.get(id); return row !== undefined && visible(row, sensitivities, asOf); };
          for (const [side, near, far] of sides) {
            const found: MemoryEdgeRow[] = []; const edgeIds = new Set<string>();
            for (const id of ids) for (const item of await session.query(touching(scope, id), { prefix: side === 'out' ? kinds.out : kinds.in })) edgeIds.add(parts(item.sort)[1]!);
            for (const id of [...edgeIds].sort(compareKeys)) {
              const row = await edge(session, scope, id);
              if (!row || row.status !== 'active' || !ids.includes(row[near]) || (relations && !relations.includes(row.relation))) continue;
              if ((row.validFrom !== null && row.validFrom > asOf) || (row.validUntil !== null && row.validUntil <= asOf)) continue;
              if (!await current(row[near]) || !await current(row[far])) continue;
              found.push(row); if (found.length >= limit) break;
            }
            for (const row of found) if (!seen.has(row.id) && rows.length < limit) { seen.add(row.id); rows.push(row); }
          }
          return rows.sort(byId);
        });
      }
      case 'putVectors': {
        const entries = command['entries'] as MemoryVectorRow[]; const embedderId = command['embedderId'] as string; const dimensions = command['dimensions'] as number;
        if (entries.length === 0) return { written: 0, stale: [] };
        const stale: string[] = []; let written = 0;
        // Each vector stands alone: large batches commit in chunks.
        for (let offset = 0; offset < entries.length; offset += CHUNK) {
          const result = await transaction(async session => {
            const chunk = entries.slice(offset, offset + CHUNK);
            const known = json<IndexDocument>(await session.get(memory(scope), place.index(embedderId)));
            if (known && known.dimensions !== dimensions) conflict('The embedder dimensions changed; use a new embedder id.');
            const current = await records(session, scope, chunk.map(entry => entry.recordId));
            const outcome = { stale: [] as string[], written: 0 };
            for (const [index, entry] of chunk.entries()) {
              const record = current[index];
              if (record?.status !== 'active' || record.version !== entry.recordVersion) { outcome.stale.push(entry.recordId); continue; }
              await session.put(vectorsOf(scope, embedderId), place.vector(entry.recordId), JSON.stringify({ recordId: entry.recordId, recordVersion: entry.recordVersion, vector: entry.vector,
                list: entry.list, epoch: known?.epoch ?? 0 } satisfies VectorDocument));
              outcome.written++;
            }
            if (!known) await session.put(memory(scope), place.index(embedderId), JSON.stringify({ embedderId, dimensions, trainedAt: 0, centroids: '[]', epoch: 0 } satisfies IndexDocument));
            return outcome;
          });
          stale.push(...result.stale); written += result.written;
        }
        return { written, stale };
      }
      case 'missingVectors': {
        const sensitivities = command['sensitivities'] as string[]; if (sensitivities.length === 0) return [];
        return read(async session => {
          const active = (await allTerms(session, scope)).filter(row => row.status === 'active' && sensitivities.includes(row.sensitivity)).sort(byId);
          const found: { id: string; version: number }[] = [];
          for (let offset = 0; offset < active.length && found.length < (command['limit'] as number); offset += 100) {
            const page = active.slice(offset, offset + 100);
            const stored = await session.getMany(page.map(row => ({ partition: vectorsOf(scope, command['embedderId'] as string), sort: place.vector(row.id) })));
            page.forEach((row, index) => { if (json<VectorDocument>(stored[index])?.recordVersion !== row.version && found.length < (command['limit'] as number)) found.push({ id: row.id, version: row.version }); });
          }
          return found;
        });
      }
      case 'vectors': {
        const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string; const lists = command['lists'] as number[] | undefined;
        const embedderId = command['embedderId'] as string; const limit = command['limit'] as number;
        if (sensitivities.length === 0) return [];
        return read(async session => {
          const index = json<IndexDocument>(await session.get(memory(scope), place.index(embedderId)));
          const found: MemoryVectorRow[] = []; let cursor = command['after'] === undefined ? undefined : place.vector(command['after'] as string);
          for (;;) {
            const page = await session.query(vectorsOf(scope, embedderId), { prefix: kinds.vector, ...(cursor === undefined ? {} : { after: cursor }), limit: 500 });
            const candidates = page.map(item => json<VectorDocument>(item.body)!).map(row => ({ ...row, list: index && row.epoch === index.epoch ? row.list : null }))
              .filter(row => lists === undefined || row.list === null || lists.includes(row.list));
            const terms = await session.getMany(candidates.map(row => ({ partition: memory(scope), sort: place.terms(row.recordId) })));
            for (const [position, row] of candidates.entries()) {
              const record = json<TermsDocument>(terms[position]);
              if (!record || record.version !== row.recordVersion || !visible(record, sensitivities, asOf)) continue;
              found.push({ recordId: row.recordId, recordVersion: row.recordVersion, vector: row.vector, list: row.list });
              if (found.length >= limit) return found;
            }
            if (page.length < 500) return found;
            cursor = page[page.length - 1]!.sort;
          }
        });
      }
      case 'indexState': return read(async session => {
        const index = json<IndexDocument>(await session.get(memory(scope), place.index(command['embedderId'] as string)));
        const count = await session.count(vectorsOf(scope, command['embedderId'] as string), { prefix: kinds.vector });
        return { vectors: count, trainedAt: index?.trainedAt ?? 0, dimensions: index?.dimensions ?? 0, centroids: index ? JSON.parse(index.centroids) as unknown : [] };
      });
      case 'setCentroids': return transaction(async session => {
        await session.get(memory(scope), place.head, true);
        const index = json<IndexDocument>(await session.get(memory(scope), place.index(command['embedderId'] as string)));
        if (!index || index.dimensions !== command['dimensions']) conflict('The memory vector index does not exist or has different dimensions.');
        // A new epoch clears every vector's list at once: a list assigned under an older epoch reads as none.
        await session.put(memory(scope), place.index(index.embedderId), JSON.stringify({ ...index, centroids: JSON.stringify(command['centroids']), trainedAt: command['trainedAt'] as number, epoch: index.epoch + 1 } satisfies IndexDocument));
        return undefined;
      });
      case 'assignLists': {
        const entries = command['entries'] as [string, number][]; const embedderId = command['embedderId'] as string; let assigned = 0;
        for (let offset = 0; offset < entries.length; offset += CHUNK) {
          assigned += await transaction(async session => {
            const index = json<IndexDocument>(await session.get(memory(scope), place.index(embedderId)));
            let count = 0;
            for (const [recordId, list] of entries.slice(offset, offset + CHUNK)) {
              const vector = json<VectorDocument>(await session.get(vectorsOf(scope, embedderId), place.vector(recordId))); if (!vector) continue;
              await session.put(vectorsOf(scope, embedderId), place.vector(recordId), JSON.stringify({ ...vector, list, epoch: index?.epoch ?? 0 })); count++;
            }
            return count;
          });
        }
        return assigned;
      }
      case 'changes': return read(async session => (await session.query(memory(scope), { prefix: kinds.change, after: place.change(command['after'] as number), limit: command['limit'] as number }))
        .map(item => json<MemoryChange>(item.body)!));
      case 'stats': return read(async session => {
        const active = (await allTerms(session, scope)).filter(row => row.status === 'active').length;
        let edges = 0; let cursor: string | undefined;
        for (;;) {
          const page = await session.query(memory(scope), { prefix: kinds.edge, ...(cursor === undefined ? {} : { after: cursor }), limit: 1_000 });
          edges += page.filter(item => json<MemoryEdgeRow>(item.body)!.status === 'active').length;
          if (page.length < 1_000) break; cursor = page[page.length - 1]!.sort;
        }
        const head = json<{ sequence: number }>(await session.get(memory(scope), place.head));
        return { records: active, edges, sequence: head?.sequence ?? 0 };
      });
      default: return corrupt();
    }
  };
  let initialized = false;
  return memoryIndexFacade(async (method, input) => {
    available();
    if (method === 'initialize') { initialized = true; return undefined; }
    if (!initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize native memory storage before use.');
    return dispatch(method, input as Record<string, unknown>);
  });
}
