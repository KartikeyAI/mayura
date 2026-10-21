import { MayuraError, type Scope } from '@mayura/core';
import type { RagHit, RagQuery, RagVector, VectorStore } from './contracts.js';
import { cancelled, chunk, id, integer, matches, metadata, scopeKey, snapshot, vector } from './validation.js';
export function cosine(left: readonly number[], right: readonly number[]): number { return left.reduce((sum, value, index) => sum + value * right[index]!, 0); }
export function checkedQuery(input: RagQuery, dimensions: number): RagQuery {
  cancelled(input.signal); return { ...input, scope: snapshot(input.scope), space: id(input.space), vector: vector(input.vector, dimensions), limit: integer(input.limit, 1, 100), filter: metadata(input.filter) };
}
export function checkedEntries(entries: readonly RagVector[], dimensions: number): readonly RagVector[] {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128) throw new MayuraError('INVALID_INPUT', 'RAG vector batch must contain 1–128 chunks.');
  const output = entries.map(entry => ({ chunk: chunk(entry.chunk), values: vector(entry.values, dimensions) }));
  if (new Set(output.map(entry => entry.chunk.id)).size !== output.length) throw new MayuraError('INVALID_INPUT', 'Duplicate RAG chunk ids.');
  return snapshot(output);
}
/** Scope-partitioned exact cosine and lexical reference backend. Writes are synchronous and atomic per batch. */
export function inMemoryVectorStore(options: { readonly dimensions: number; readonly maxVectors: number }): VectorStore {
  const dimensions = integer(options.dimensions, 1, 4096); const cap = integer(options.maxVectors, 1, 100_000);
  const partitions = new Map<string, Map<string, RagVector>>(); let count = 0;
  const ordered = (hits: RagHit[], limit: number) => snapshot(hits.sort((a,b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0,limit));
  return Object.freeze({ id: 'mayura.rag.memory', dimensions, costMicros: 0, location: 'local' as const,
    async upsert(scope: Scope, space: string, entries: readonly RagVector[], signal: AbortSignal) {
      cancelled(signal); const key = scopeKey(scope, space); const checked = checkedEntries(entries, dimensions); const current = partitions.get(key) ?? new Map<string,RagVector>();
      const added = checked.filter(entry => !current.has(entry.chunk.id)).length;
      if (count + added > cap) throw new MayuraError('BUDGET_EXCEEDED','RAG vector capacity exceeded.');
      checked.forEach(entry => current.set(entry.chunk.id, entry)); partitions.set(key,current); count += added;
    },
    async query(raw: RagQuery) {
      const q = checkedQuery(raw,dimensions); const rows = partitions.get(scopeKey(q.scope,q.space));
      return ordered([...(rows?.values() ?? [])].filter(row => matches(row.chunk.metadata,q.filter)).map(row => ({ chunk: row.chunk, score: cosine(q.vector,row.values) })), q.limit);
    },
    async lexical(q: Omit<RagQuery,'vector'> & { readonly text: string }) {
      cancelled(q.signal); metadata(q.filter); integer(q.limit,1,100);
      const terms = [...new Set(q.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0,64);
      return ordered([...(partitions.get(scopeKey(q.scope,q.space))?.values() ?? [])].filter(row => matches(row.chunk.metadata,q.filter)).map(row => {
        const words = row.chunk.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
        return { chunk: row.chunk, score: terms.reduce((sum, term) => sum + words.filter(word => word === term).length / (words.length + 1), 0) };
      }).filter(hit => hit.score > 0),q.limit);
    },
    async delete(scope: Scope, space: string, ids: readonly string[], signal: AbortSignal) {
      cancelled(signal); if (ids.length > 128) throw new MayuraError('INVALID_INPUT','RAG deletion batch is too large.');
      const checked = ids.map(id); const key = scopeKey(scope,space); const rows = partitions.get(key);
      for (const value of checked) if (rows?.delete(value)) count--; if (rows?.size === 0) partitions.delete(key);
    },
  });
}

/** Compose a semantic backend with a lexical mirror. Publication stays hidden until both staged writes succeed. */
export function hybridVectorStore(options:{readonly semantic:VectorStore;readonly lexical:VectorStore}):VectorStore {
  const a=options.semantic;const b=options.lexical;if(a.dimensions!==b.dimensions||!b.lexical)throw new MayuraError('INVALID_CONFIG','Hybrid RAG requires matching dimensions and an explicit lexical backend.');
  const costMicros=integer(a.costMicros+b.costMicros,0,Number.MAX_SAFE_INTEGER);
  return Object.freeze({id:`hybrid.${a.id}.${b.id}`,dimensions:a.dimensions,costMicros,location:a.location==='hosted'||b.location==='hosted'?'hosted' as const:'local' as const,
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal){const admitted=checkedEntries(entries,a.dimensions);await a.upsert(scope,space,admitted,signal);cancelled(signal);await b.upsert(scope,space,admitted,signal);cancelled(signal);},
    query:a.query.bind(a),lexical:b.lexical.bind(b),
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal){await a.delete(scope,space,ids,signal);cancelled(signal);await b.delete(scope,space,ids,signal);cancelled(signal);},
  });
}
