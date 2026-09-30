import {
  StorageError, memoryIndexCommand, memoryIndexResult,
  type MemoryChange, type MemoryEdgeRow, type MemoryIndexMethod, type MemoryRow, type MemoryRowSensitivity, type MemoryVectorRow,
} from '@mayura/storage-contracts';
import type { JsonObject } from '@mayura/core';
import { lockSql, storedInteger } from './aggregate-session.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';
import { advisoryLock, updateReturning } from './dialect.js';

interface RecordRow {
  id: string; version: number | string; status: string; sensitivity: string; body: string | null; valid_from: string | null; valid_until: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; superseded_by: string | null;
}
interface EdgeRow {
  id: string; version: number | string; status: string; from_id: string; to_id: string; relation: string; body: string | null;
  valid_from: string | null; valid_until: string | null; created_at: string; updated_at: string;
}
interface VectorSqlRow { record_id: string; record_version: number | string; vector: string; list: number | string | null }
function conflict(message = 'The memory record or edge version changed.'): never { throw new StorageError('CONFLICT', message); }
function corrupt(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored native memory failed integrity validation.'); }
const marks = (count: number): string => Array.from({ length: count }, () => '?').join(',');

/** Table-backed native memory. Every mutation is one transaction; reads filter authorization inside the query. */
export class MemoryIndexDatabase {
  private initialized = false;
  constructor(private readonly backend: SchedulerBackend) {}
  private t(name: string): string { return `${this.backend.prefix}mayura_memory_${name}`; }
  /** PostgreSQL index names are never schema-qualified; they live in their table's schema. */
  private i(name: string): string { return `${this.backend.dialect === 'sqlite' ? this.backend.prefix : ''}mayura_memory_${name}`; }

  async execute(method: MemoryIndexMethod, raw: unknown): Promise<unknown> {
    const command = memoryIndexCommand(method, raw) as Record<string, unknown>;
    if (method === 'initialize') { await this.initialize(); return undefined; }
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize native memory storage before use.');
    const result = await this.dispatch(method, command);
    return memoryIndexResult(method, result, command as JsonObject);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const text = 'TEXT'; const big = this.backend.dialect === 'sqlite' ? 'INTEGER' : 'BIGINT';
    await this.backend.transaction(async tx => {
      await advisoryLock(tx, this.backend, `mayura:memory-schema:${this.backend.prefix}`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.t('records')} (
        scope ${text} NOT NULL, id ${text} NOT NULL, version ${big} NOT NULL, status ${text} NOT NULL CHECK(status IN ('active','superseded','deleted')),
        sensitivity ${text} NOT NULL, body ${text}, term_count INTEGER NOT NULL DEFAULT 0, valid_from ${text}, valid_until ${text},
        created_at ${text} NOT NULL, updated_at ${text} NOT NULL, deleted_at ${text}, superseded_by ${text}, PRIMARY KEY(scope, id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${this.i('records_status')} ON ${this.t('records')} (scope, status, sensitivity, id)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.t('terms')} (
        scope ${text} NOT NULL, term ${text} NOT NULL, record_id ${text} NOT NULL, frequency INTEGER NOT NULL, PRIMARY KEY(scope, term, record_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${this.i('terms_record')} ON ${this.t('terms')} (scope, record_id)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.t('edges')} (
        scope ${text} NOT NULL, id ${text} NOT NULL, version ${big} NOT NULL, status ${text} NOT NULL CHECK(status IN ('active','deleted')),
        from_id ${text} NOT NULL, to_id ${text} NOT NULL, relation ${text} NOT NULL, body ${text}, valid_from ${text}, valid_until ${text},
        created_at ${text} NOT NULL, updated_at ${text} NOT NULL, PRIMARY KEY(scope, id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${this.i('edges_from')} ON ${this.t('edges')} (scope, from_id, status)`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${this.i('edges_to')} ON ${this.t('edges')} (scope, to_id, status)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.t('vectors')} (
        scope ${text} NOT NULL, embedder_id ${text} NOT NULL, record_id ${text} NOT NULL, record_version ${big} NOT NULL,
        vector ${text} NOT NULL, list INTEGER, PRIMARY KEY(scope, embedder_id, record_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS ${this.i('vectors_list')} ON ${this.t('vectors')} (scope, embedder_id, list)`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.t('indexes')} (
        scope ${text} NOT NULL, embedder_id ${text} NOT NULL, dimensions INTEGER NOT NULL, trained_at ${big} NOT NULL, centroids ${text} NOT NULL,
        PRIMARY KEY(scope, embedder_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.t('changes')} (
        scope ${text} NOT NULL, sequence ${big} NOT NULL, kind ${text} NOT NULL, id ${text} NOT NULL, version ${big} NOT NULL, status ${text} NOT NULL,
        PRIMARY KEY(scope, sequence))`);
    });
    this.initialized = true;
  }

  private async lockScope(tx: SchedulerSession, scope: string): Promise<void> {
    await advisoryLock(tx, this.backend, JSON.stringify(['mayura:memory-scope:v1', this.backend.prefix, scope]));
  }
  private async change(tx: SchedulerSession, scope: string, kind: 'record' | 'edge', id: string, version: number, status: string): Promise<number> {
    const last = (await tx.query<{ sequence: number | string | null }>(`SELECT MAX(sequence) AS sequence FROM ${this.t('changes')} WHERE scope = ?`, [scope]))[0]?.sequence;
    const sequence = (last === null || last === undefined ? 0 : storedInteger(last)) + 1;
    await tx.query(`INSERT INTO ${this.t('changes')} (scope, sequence, kind, id, version, status) VALUES (?, ?, ?, ?, ?, ?)`, [scope, sequence, kind, id, version, status]);
    return sequence;
  }
  private record(row: RecordRow): MemoryRow {
    try {
      return { id: row.id, version: storedInteger(row.version), status: row.status as MemoryRow['status'], sensitivity: row.sensitivity as MemoryRowSensitivity,
        body: row.body === null ? null : JSON.parse(row.body) as JsonObject, validFrom: row.valid_from, validUntil: row.valid_until,
        createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, supersededBy: row.superseded_by };
    } catch { return corrupt(); }
  }
  private edge(row: EdgeRow): MemoryEdgeRow {
    try {
      return { id: row.id, version: storedInteger(row.version), status: row.status as MemoryEdgeRow['status'], from: row.from_id, to: row.to_id,
        relation: row.relation, body: row.body === null ? null : JSON.parse(row.body) as JsonObject, validFrom: row.valid_from, validUntil: row.valid_until,
        createdAt: row.created_at, updatedAt: row.updated_at };
    } catch { return corrupt(); }
  }
  /**
   * Authorized, current, active: the only rows ranking and traversal may ever see. Joins against records use CROSS JOIN
   * so SQLite drives from the selective term/vector/edge index instead of scanning every record (PostgreSQL still plans freely).
   */
  private visible(alias: string, sensitivities: readonly string[]): string {
    return `${alias}.status = 'active' AND ${alias}.sensitivity IN (${marks(sensitivities.length)}) AND ${alias}.valid_from <= ? AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ?)`;
  }

  private async dispatch(method: MemoryIndexMethod, command: Record<string, unknown>): Promise<unknown> {
    const scope = command['scope'] as string;
    switch (method) {
      case 'putRecord': return this.backend.transaction(async tx => {
        await this.lockScope(tx, scope);
        const row = command['record'] as MemoryRow; const expected = command['expectedVersion'] as number; const terms = command['terms'] as [string, number][];
        const current = (await tx.query<RecordRow>(`SELECT * FROM ${this.t('records')} WHERE scope = ? AND id = ?${lockSql(this.backend)}`, [scope, row.id]))[0];
        if ((current ? storedInteger(current.version) : 0) !== expected) conflict();
        if (current?.status === 'deleted') conflict('A deleted memory record cannot be replaced.');
        const termCount = terms.reduce((sum, [, frequency]) => sum + frequency, 0);
        const values = [row.version, row.status, row.sensitivity, row.body === null ? null : JSON.stringify(row.body), termCount, row.validFrom, row.validUntil,
          row.createdAt, row.updatedAt, row.deletedAt, row.supersededBy];
        if (current) await tx.query(`UPDATE ${this.t('records')} SET version = ?, status = ?, sensitivity = ?, body = ?, term_count = ?, valid_from = ?, valid_until = ?,
          created_at = ?, updated_at = ?, deleted_at = ?, superseded_by = ? WHERE scope = ? AND id = ?`, [...values, scope, row.id]);
        else await tx.query(`INSERT INTO ${this.t('records')} (version, status, sensitivity, body, term_count, valid_from, valid_until, created_at, updated_at,
          deleted_at, superseded_by, scope, id) VALUES (${marks(13)})`, [...values, scope, row.id]);
        await tx.query(`DELETE FROM ${this.t('terms')} WHERE scope = ? AND record_id = ?`, [scope, row.id]);
        for (let index = 0; index < terms.length; index += 200) {
          const chunk = terms.slice(index, index + 200);
          await tx.query(`INSERT INTO ${this.t('terms')} (scope, term, record_id, frequency) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}`,
            chunk.flatMap(([term, frequency]) => [scope, term, row.id, frequency]));
        }
        // Stale vectors never survive a content change; inactive records keep none.
        await tx.query(`DELETE FROM ${this.t('vectors')} WHERE scope = ? AND record_id = ?`, [scope, row.id]);
        if (row.status === 'deleted') {
          const touching = await tx.query<EdgeRow>(`SELECT * FROM ${this.t('edges')} WHERE scope = ? AND status = 'active' AND (from_id = ? OR to_id = ?)${lockSql(this.backend)}`, [scope, row.id, row.id]);
          for (const edge of touching) {
            const version = storedInteger(edge.version) + 1;
            await tx.query(`UPDATE ${this.t('edges')} SET status = 'deleted', version = ?, body = NULL, valid_from = NULL, valid_until = NULL, updated_at = ? WHERE scope = ? AND id = ?`,
              [version, row.updatedAt, scope, edge.id]);
            await this.change(tx, scope, 'edge', edge.id, version, 'deleted');
          }
        }
        const sequence = await this.change(tx, scope, 'record', row.id, row.version, row.status);
        return { record: row, sequence };
      });
      case 'getRecords': {
        const ids = command['ids'] as string[]; if (ids.length === 0) return [];
        const rows = await this.backend.transaction(tx => tx.query<RecordRow>(`SELECT * FROM ${this.t('records')} WHERE scope = ? AND id IN (${marks(ids.length)}) ORDER BY id`, [scope, ...ids]));
        return rows.map(row => this.record(row));
      }
      case 'listRecords': {
        const statuses = command['statuses'] as string[]; const sensitivities = command['sensitivities'] as string[];
        if (statuses.length === 0 || sensitivities.length === 0) return [];
        const after = command['after'] as string | undefined;
        const rows = await this.backend.transaction(tx => tx.query<RecordRow>(`SELECT * FROM ${this.t('records')} WHERE scope = ? AND status IN (${marks(statuses.length)})
          AND sensitivity IN (${marks(sensitivities.length)})${after === undefined ? '' : ' AND id > ?'} ORDER BY id LIMIT ?`,
          [scope, ...statuses, ...sensitivities, ...(after === undefined ? [] : [after]), command['limit']]));
        return rows.map(row => this.record(row));
      }
      case 'postings': {
        const terms = command['terms'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        if (terms.length === 0 || sensitivities.length === 0) return { documents: 0, averageLength: 0, postings: [] };
        return this.backend.transaction(async tx => {
          const corpus = (await tx.query<{ documents: number | string; total: number | string | null }>(`SELECT COUNT(*) AS documents, SUM(r.term_count) AS total
            FROM ${this.t('records')} r WHERE r.scope = ? AND ${this.visible('r', sensitivities)}`, [scope, ...sensitivities, asOf, asOf]))[0];
          const documents = storedInteger(corpus?.documents ?? 0); const total = corpus?.total === null || corpus?.total === undefined ? 0 : storedInteger(corpus.total);
          const rows = await tx.query<{ record_id: string; term: string; frequency: number | string; term_count: number | string }>(`SELECT t.record_id, t.term, t.frequency, r.term_count
            FROM ${this.t('terms')} t CROSS JOIN ${this.t('records')} r
            WHERE r.scope = t.scope AND r.id = t.record_id AND t.scope = ? AND t.term IN (${marks(terms.length)}) AND ${this.visible('r', sensitivities)} ORDER BY t.record_id, t.term LIMIT ?`,
            [scope, ...terms, ...sensitivities, asOf, asOf, command['limit']]);
          return { documents, averageLength: documents === 0 ? 0 : total / documents,
            postings: rows.map(row => ({ id: row.record_id, term: row.term, frequency: storedInteger(row.frequency), length: Math.max(1, storedInteger(row.term_count)) })) };
        });
      }
      case 'rank': {
        const terms = command['terms'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        if (terms.length === 0 || sensitivities.length === 0) return { documents: 0, hits: [] };
        return this.backend.transaction(async tx => {
          const corpus = (await tx.query<{ documents: number | string; total: number | string | null }>(`SELECT COUNT(*) AS documents, SUM(r.term_count) AS total
            FROM ${this.t('records')} r WHERE r.scope = ? AND ${this.visible('r', sensitivities)}`, [scope, ...sensitivities, asOf, asOf]))[0];
          const documents = storedInteger(corpus?.documents ?? 0);
          if (documents === 0) return { documents: 0, hits: [] };
          const average = Math.max(1, (corpus?.total === null || corpus?.total === undefined ? 0 : storedInteger(corpus.total)) / documents);
          const frequencies = await tx.query<{ term: string; df: number | string }>(`SELECT t.term, COUNT(*) AS df FROM ${this.t('terms')} t
            CROSS JOIN ${this.t('records')} r WHERE r.scope = t.scope AND r.id = t.record_id AND t.scope = ? AND t.term IN (${marks(terms.length)})
            AND ${this.visible('r', sensitivities)} GROUP BY t.term`, [scope, ...terms, ...sensitivities, asOf, asOf]);
          const weights = frequencies.map(row => { const df = storedInteger(row.df); return [row.term, Math.log(1 + (documents - df + 0.5) / (df + 0.5))] as const; });
          if (weights.length === 0) return { documents, hits: [] };
          const real = 'DOUBLE PRECISION';
          // Okapi BM25 (k1 = 1.2, b = 0.75), ranked and limited by the database so only the top hits leave it. Grouping on an
          // expression keeps SQLite on the (scope, term) index instead of scanning the scope's postings in record order.
          const rows = await tx.query<{ record_id: string; score: number | string }>(`SELECT t.record_id || '' AS record_id, SUM((CASE t.term ${weights.map(() => `WHEN ? THEN CAST(? AS ${real})`).join(' ')} ELSE 0 END)
            * (CAST(t.frequency AS ${real}) * 2.2) / (CAST(t.frequency AS ${real}) + 1.2 * (0.25 + 0.75 * CAST(r.term_count AS ${real}) / CAST(? AS ${real})))) AS score
            FROM ${this.t('terms')} t CROSS JOIN ${this.t('records')} r
            WHERE r.scope = t.scope AND r.id = t.record_id AND t.scope = ? AND t.term IN (${marks(weights.length)}) AND ${this.visible('r', sensitivities)}
            GROUP BY t.record_id || '' ORDER BY score DESC, record_id ASC LIMIT ?`,
            [...weights.flat(), average, scope, ...weights.map(([term]) => term), ...sensitivities, asOf, asOf, command['limit']]);
          return { documents, hits: rows.map(row => ({ id: row.record_id, score: Number(row.score) })) };
        });
      }
      case 'putEdge': return this.backend.transaction(async tx => {
        await this.lockScope(tx, scope);
        const edge = command['edge'] as MemoryEdgeRow; const expected = command['expectedVersion'] as number;
        const current = (await tx.query<EdgeRow>(`SELECT * FROM ${this.t('edges')} WHERE scope = ? AND id = ?${lockSql(this.backend)}`, [scope, edge.id]))[0];
        if ((current ? storedInteger(current.version) : 0) !== expected) conflict();
        if (current?.status === 'deleted') conflict('A deleted memory edge cannot be replaced.');
        if (current && (current.from_id !== edge.from || current.to_id !== edge.to)) conflict('Memory edge endpoints are immutable.');
        if (edge.status === 'active') {
          const endpoints = await tx.query<{ id: string }>(`SELECT id FROM ${this.t('records')} WHERE scope = ? AND status = 'active' AND id IN (?, ?)${lockSql(this.backend)}`, [scope, edge.from, edge.to]);
          if (endpoints.length !== 2) conflict('Both memory edge endpoints must be active records in this scope.');
        }
        const values = [edge.version, edge.status, edge.from, edge.to, edge.relation, edge.body === null ? null : JSON.stringify(edge.body), edge.validFrom, edge.validUntil, edge.createdAt, edge.updatedAt];
        if (current) await tx.query(`UPDATE ${this.t('edges')} SET version = ?, status = ?, from_id = ?, to_id = ?, relation = ?, body = ?, valid_from = ?, valid_until = ?,
          created_at = ?, updated_at = ? WHERE scope = ? AND id = ?`, [...values, scope, edge.id]);
        else await tx.query(`INSERT INTO ${this.t('edges')} (version, status, from_id, to_id, relation, body, valid_from, valid_until, created_at, updated_at, scope, id)
          VALUES (${marks(12)})`, [...values, scope, edge.id]);
        return { edge, sequence: await this.change(tx, scope, 'edge', edge.id, edge.version, edge.status) };
      });
      case 'getEdge': {
        const row = (await this.backend.transaction(tx => tx.query<EdgeRow>(`SELECT * FROM ${this.t('edges')} WHERE scope = ? AND id = ?`, [scope, command['id']])))[0];
        return row ? this.edge(row) : undefined;
      }
      case 'listEdges': {
        const after = command['after'] as string | undefined;
        const rows = await this.backend.transaction(tx => tx.query<EdgeRow>(`SELECT * FROM ${this.t('edges')} WHERE scope = ?${after === undefined ? '' : ' AND id > ?'} ORDER BY id LIMIT ?`,
          [scope, ...(after === undefined ? [] : [after]), command['limit']]));
        return rows.map(row => this.edge(row));
      }
      case 'edges': {
        const ids = command['recordIds'] as string[]; const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string;
        const relations = command['relations'] as string[] | undefined; const direction = command['direction'] as string;
        if (ids.length === 0 || sensitivities.length === 0 || relations?.length === 0) return [];
        const sides = direction === 'out' ? [['from_id', 'to_id']] : direction === 'in' ? [['to_id', 'from_id']] : [['from_id', 'to_id'], ['to_id', 'from_id']];
        const rows: EdgeRow[] = []; const seen = new Set<string>();
        for (const [near, far] of sides) {
          const found = await this.backend.transaction(tx => tx.query<EdgeRow>(`SELECT e.* FROM ${this.t('edges')} e
            CROSS JOIN ${this.t('records')} a CROSS JOIN ${this.t('records')} b
            WHERE a.scope = e.scope AND a.id = e.${near} AND b.scope = e.scope AND b.id = e.${far} AND e.scope = ? AND e.status = 'active' AND e.${near} IN (${marks(ids.length)})${relations ? ` AND e.relation IN (${marks(relations.length)})` : ''}
            AND (e.valid_from IS NULL OR e.valid_from <= ?) AND (e.valid_until IS NULL OR e.valid_until > ?)
            AND ${this.visible('a', sensitivities)} AND ${this.visible('b', sensitivities)} ORDER BY e.id LIMIT ?`,
            [scope, ...ids, ...(relations ?? []), asOf, asOf, ...sensitivities, asOf, asOf, ...sensitivities, asOf, asOf, command['limit']]));
          for (const row of found) if (!seen.has(row.id) && rows.length < (command['limit'] as number)) { seen.add(row.id); rows.push(row); }
        }
        return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(row => this.edge(row));
      }
      case 'putVectors': return this.backend.transaction(async tx => {
        const entries = command['entries'] as MemoryVectorRow[]; const embedderId = command['embedderId'] as string;
        if (entries.length === 0) return { written: 0, stale: [] };
        const current = new Map((await tx.query<{ id: string; version: number | string }>(`SELECT id, version FROM ${this.t('records')} WHERE scope = ? AND status = 'active'
          AND id IN (${marks(entries.length)})`, [scope, ...entries.map(entry => entry.recordId)])).map(row => [row.id, storedInteger(row.version)]));
        const stale: string[] = []; let written = 0;
        const known = (await tx.query<{ dimensions: number | string }>(`SELECT dimensions FROM ${this.t('indexes')} WHERE scope = ? AND embedder_id = ?`, [scope, embedderId]))[0];
        if (known && storedInteger(known.dimensions) !== command['dimensions']) conflict('The embedder dimensions changed; use a new embedder id.');
        for (const entry of entries) {
          if (current.get(entry.recordId) !== entry.recordVersion) { stale.push(entry.recordId); continue; }
          await tx.query(`DELETE FROM ${this.t('vectors')} WHERE scope = ? AND embedder_id = ? AND record_id = ?`, [scope, embedderId, entry.recordId]);
          await tx.query(`INSERT INTO ${this.t('vectors')} (scope, embedder_id, record_id, record_version, vector, list) VALUES (?, ?, ?, ?, ?, ?)`,
            [scope, embedderId, entry.recordId, entry.recordVersion, entry.vector, entry.list]);
          written++;
        }
        if (!known) await tx.query(`INSERT INTO ${this.t('indexes')} (scope, embedder_id, dimensions, trained_at, centroids) VALUES (?, ?, ?, 0, '[]')`, [scope, embedderId, command['dimensions']]);
        return { written, stale };
      });
      case 'missingVectors': {
        const sensitivities = command['sensitivities'] as string[]; if (sensitivities.length === 0) return [];
        const rows = await this.backend.transaction(tx => tx.query<{ id: string; version: number | string }>(`SELECT r.id, r.version FROM ${this.t('records')} r
          LEFT JOIN ${this.t('vectors')} v ON v.scope = r.scope AND v.record_id = r.id AND v.embedder_id = ? AND v.record_version = r.version
          WHERE r.scope = ? AND r.status = 'active' AND r.sensitivity IN (${marks(sensitivities.length)}) AND v.record_id IS NULL ORDER BY r.id LIMIT ?`,
          [command['embedderId'], scope, ...sensitivities, command['limit']]));
        return rows.map(row => ({ id: row.id, version: storedInteger(row.version) }));
      }
      case 'vectors': {
        const sensitivities = command['sensitivities'] as string[]; const asOf = command['asOf'] as string; const lists = command['lists'] as number[] | undefined;
        const after = command['after'] as string | undefined;
        if (sensitivities.length === 0) return [];
        // Unassigned and listed vectors are read as two index-friendly branches rather than one OR predicate, and list reads
        // order by an expression so SQLite keeps the list index instead of merging both branches through the primary key.
        const branch = (condition: string, values: readonly unknown[]) => ({ sql: `SELECT v.record_id, v.record_version, v.vector, v.list FROM ${this.t('vectors')} v
          CROSS JOIN ${this.t('records')} r
          WHERE r.scope = v.scope AND r.id = v.record_id AND r.version = v.record_version AND v.scope = ? AND v.embedder_id = ?${condition} AND ${this.visible('r', sensitivities)}${after === undefined ? '' : ' AND v.record_id > ?'}`,
          values: [scope, command['embedderId'], ...values, ...sensitivities, asOf, asOf, ...(after === undefined ? [] : [after])] });
        const parts = lists === undefined ? [branch('', [])]
          : [branch(' AND v.list IS NULL', []), ...(lists.length > 0 ? [branch(` AND v.list IN (${marks(lists.length)})`, lists)] : [])];
        const rows = await this.backend.transaction(tx => tx.query<VectorSqlRow>(`SELECT * FROM (${parts.map(part => part.sql).join(' UNION ALL ')}) selected
          ORDER BY ${lists !== undefined && lists.length > 0 ? "record_id || ''" : 'record_id'} LIMIT ?`,
          [...parts.flatMap(part => part.values), command['limit']]));
        return rows.map(row => ({ recordId: row.record_id, recordVersion: storedInteger(row.record_version), vector: row.vector, list: row.list === null ? null : storedInteger(row.list) }));
      }
      case 'indexState': return this.backend.transaction(async tx => {
        const index = (await tx.query<{ dimensions: number | string; trained_at: number | string; centroids: string }>(`SELECT dimensions, trained_at, centroids FROM ${this.t('indexes')}
          WHERE scope = ? AND embedder_id = ?`, [scope, command['embedderId']]))[0];
        const count = (await tx.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM ${this.t('vectors')} WHERE scope = ? AND embedder_id = ?`, [scope, command['embedderId']]))[0];
        let centroids: unknown = [];
        try { centroids = index ? JSON.parse(index.centroids) : []; } catch { corrupt(); }
        return { vectors: storedInteger(count?.count ?? 0), trainedAt: index ? storedInteger(index.trained_at) : 0, dimensions: index ? storedInteger(index.dimensions) : 0, centroids };
      });
      case 'setCentroids': return this.backend.transaction(async tx => {
        await this.lockScope(tx, scope);
        const updated = await updateReturning<{ scope: string }>(tx, this.backend, `UPDATE ${this.t('indexes')} SET centroids = ?, trained_at = ? WHERE scope = ? AND embedder_id = ? AND dimensions = ?`,
          [JSON.stringify(command['centroids']), command['trainedAt'], scope, command['embedderId'], command['dimensions']], 'scope',
          `SELECT scope FROM ${this.t('indexes')} WHERE scope = ? AND embedder_id = ? AND dimensions = ?`, [scope, command['embedderId'], command['dimensions']]);
        if (updated.length !== 1) conflict('The memory vector index does not exist or has different dimensions.');
        await tx.query(`UPDATE ${this.t('vectors')} SET list = NULL WHERE scope = ? AND embedder_id = ?`, [scope, command['embedderId']]);
        return undefined;
      });
      case 'assignLists': return this.backend.transaction(async tx => {
        let assigned = 0;
        for (const [recordId, list] of command['entries'] as [string, number][]) {
          const rows = await updateReturning<{ record_id: string }>(tx, this.backend, `UPDATE ${this.t('vectors')} SET list = ? WHERE scope = ? AND embedder_id = ? AND record_id = ?`,
            [list, scope, command['embedderId'], recordId], 'record_id',
            `SELECT record_id FROM ${this.t('vectors')} WHERE scope = ? AND embedder_id = ? AND record_id = ?`, [scope, command['embedderId'], recordId]);
          assigned += rows.length;
        }
        return assigned;
      });
      case 'changes': {
        const rows = await this.backend.transaction(tx => tx.query<{ sequence: number | string; kind: string; id: string; version: number | string; status: string }>(
          `SELECT sequence, kind, id, version, status FROM ${this.t('changes')} WHERE scope = ? AND sequence > ? ORDER BY sequence LIMIT ?`, [scope, command['after'], command['limit']]));
        return rows.map((row): MemoryChange => ({ sequence: storedInteger(row.sequence), kind: row.kind as MemoryChange['kind'], id: row.id, version: storedInteger(row.version), status: row.status }));
      }
      case 'stats': return this.backend.transaction(async tx => {
        const records = (await tx.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM ${this.t('records')} WHERE scope = ? AND status = 'active'`, [scope]))[0];
        const edges = (await tx.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM ${this.t('edges')} WHERE scope = ? AND status = 'active'`, [scope]))[0];
        const sequence = (await tx.query<{ sequence: number | string | null }>(`SELECT MAX(sequence) AS sequence FROM ${this.t('changes')} WHERE scope = ?`, [scope]))[0]?.sequence;
        return { records: storedInteger(records?.count ?? 0), edges: storedInteger(edges?.count ?? 0), sequence: sequence === null || sequence === undefined ? 0 : storedInteger(sequence) };
      });
      default: return corrupt();
    }
  }
}
