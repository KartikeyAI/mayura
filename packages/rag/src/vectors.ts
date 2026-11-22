import { MayuraError, type Scope } from '@mayura/core';
import type { RagChunk, RagHit, RagQuery, RagVector, VectorStore } from './contracts.js';
import { cancelled, chunk, id, integer, matches, metadata, scopeKey, snapshot, vector } from './validation.js';
import { Bm25Index } from './bm25.js';
import { lexicalDocumentKey,lexicalDocumentText,sourceGroupIdentity } from './document-lexical.js';
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
export function inMemoryVectorStore(options: {
  readonly dimensions: number; readonly maxVectors: number;
  /** Default is normalized term frequency. BM25 maintains statistics within each scope/index partition. */
  readonly lexicalScoring?: 'term-frequency' | 'bm25';
  /** Default is chunk. Document BM25 merges consistent source intervals and returns a real passage witness. */
  readonly lexicalUnit?: 'chunk' | 'document';
  /** Return the best exact-cosine passage per document before applying the candidate limit. */
  readonly semanticUnit?: 'chunk' | 'document';
  /** Document scoring defaults to max; mean averages every matching chunk cosine without new embeddings. */
  readonly documentScore?: 'max' | 'mean';
}): VectorStore {
  const dimensions = integer(options.dimensions, 1, 4096); const cap = integer(options.maxVectors, 1, 100_000);
  if(options.lexicalScoring!==undefined&&!['term-frequency','bm25'].includes(options.lexicalScoring))throw new MayuraError('INVALID_CONFIG','Invalid lexical scoring mode.');
  if(options.lexicalUnit!==undefined&&!['chunk','document'].includes(options.lexicalUnit)||options.lexicalUnit==='document'&&options.lexicalScoring!=='bm25')throw new MayuraError('INVALID_CONFIG','Document lexical units require BM25 scoring.');
  if(options.semanticUnit!==undefined&&!['chunk','document'].includes(options.semanticUnit))throw new MayuraError('INVALID_CONFIG','Invalid semantic candidate unit.');
  if(options.documentScore!==undefined&&!['max','mean'].includes(options.documentScore)||options.documentScore==='mean'&&options.semanticUnit!=='document')throw new MayuraError('INVALID_CONFIG','Mean semantic scoring requires document candidates.');
  const lexicalIndexes=new Map<string,Bm25Index>();
  const documentGroups=new Map<string,Map<string,Map<string,RagChunk>>>();
  const partitions = new Map<string, Map<string, RagVector>>(); let count = 0;
  const ordered = (hits: RagHit[], limit: number) => snapshot(hits.sort((a,b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0,limit));
  return Object.freeze({ id: 'mayura.rag.memory', dimensions, costMicros: 0, location: 'local' as const,
    async upsert(scope: Scope, space: string, entries: readonly RagVector[], signal: AbortSignal) {
      cancelled(signal); const key = scopeKey(scope, space); const checked = checkedEntries(entries, dimensions); const current = partitions.get(key) ?? new Map<string,RagVector>();
      const added = checked.filter(entry => !current.has(entry.chunk.id)).length;
      if (count + added > cap) throw new MayuraError('BUDGET_EXCEEDED','RAG vector capacity exceeded.');
      if(options.lexicalScoring==='bm25'){
        // Validate every affected revision before changing any row or posting, including overwrites.
        const existing=documentGroups.get(key)??new Map<string,Map<string,RagChunk>>();const updates=new Map<string,Map<string,RagChunk>>();
        const group=(id:string)=>{let value=updates.get(id);if(!value){value=new Map(existing.get(id));updates.set(id,value);}return value;};
        if(options.lexicalUnit==='document')for(const entry of checked){const old=current.get(entry.chunk.id);if(old)group(lexicalDocumentKey(old.chunk)).delete(old.chunk.id);group(lexicalDocumentKey(entry.chunk)).set(entry.chunk.id,entry.chunk);}
        const texts=new Map([...updates].map(([id,rows])=>[id,lexicalDocumentText(rows)]));
        let index=lexicalIndexes.get(key);if(!index){index=new Bm25Index();lexicalIndexes.set(key,index);}
        if(options.lexicalUnit==='document'){for(const [id,rows]of updates){if(rows.size){existing.set(id,rows);index.set(id,texts.get(id)!);}else{existing.delete(id);index.delete(id);}}documentGroups.set(key,existing);}
        else for(const entry of checked)index.set(entry.chunk.id,entry.chunk.text);
      }
      checked.forEach(entry => current.set(entry.chunk.id, entry)); partitions.set(key,current); count += added;
    },
    async query(raw: RagQuery) {
      const q = checkedQuery(raw,dimensions); const rows = partitions.get(scopeKey(q.scope,q.space));
      let hits=[...(rows?.values() ?? [])].filter(row => matches(row.chunk.metadata,q.filter)).map(row => ({ chunk: row.chunk, score: cosine(q.vector,row.values) }));
      if(options.semanticUnit==='document'){
        // Reduce within the verified partition/filter, keeping an actual stored passage and stable ties.
        const totals=new Map<string,{sum:number;count:number}>();const best=new Map<string,RagHit>();for(const hit of hits){const key=sourceGroupIdentity(hit.chunk);const old=best.get(key);
          const total=totals.get(key)??{sum:0,count:0};total.sum+=hit.score;total.count++;totals.set(key,total);
          if(!old||hit.score>old.score||hit.score===old.score&&hit.chunk.id.localeCompare(old.chunk.id)<0)best.set(key,hit);}
        const documents=new Map<string,RagHit>();
        for(const [key,witness]of best){const hit=options.documentScore==='mean'?{...witness,score:totals.get(key)!.sum/totals.get(key)!.count}:witness;const old=documents.get(hit.chunk.documentId);
          if(!old||hit.score>old.score||hit.score===old.score&&hit.chunk.id.localeCompare(old.chunk.id)<0)documents.set(hit.chunk.documentId,hit);}
        hits=[...documents.values()];
      }
      return ordered(hits,q.limit);
    },
    async lexical(q: Omit<RagQuery,'vector'> & { readonly text: string }) {
      cancelled(q.signal); metadata(q.filter); integer(q.limit,1,100);
      if(options.lexicalScoring==='bm25'){
        const key=scopeKey(q.scope,q.space);const rows=partitions.get(key);const scores=lexicalIndexes.get(key)?.scores(q.text);
        if(options.lexicalUnit==='document'){
          const groups=documentGroups.get(key);const index=lexicalIndexes.get(key)!;
          // Bound passage scoring to documents that can reach the limit. Include cutoff ties so the
          // final real-witness ID tie-break stays identical to scoring the entire partition.
          const eligible=[...(scores??[])].filter(([id])=>{const first=groups?.get(id)?.values().next().value;return first&&matches(first.metadata,q.filter);}).sort((a,b)=>b[1]-a[1]);
          const cutoff=eligible[q.limit-1]?.[1]??-Infinity;
          return ordered(eligible.filter(([,score])=>score>=cutoff).flatMap(([id,score])=>{
            const allowed=[...(groups?.get(id)?.values()??[])].filter(c=>matches(c.metadata,q.filter));
            const witness=allowed.map(chunk=>({chunk,score:index.scoreText(q.text,chunk.text)})).sort((a,b)=>b.score-a.score||a.chunk.id.localeCompare(b.chunk.id))[0];
            return witness&&witness.score>0?[{chunk:witness.chunk,score}]:[];
          }),q.limit);
        }
        return ordered([...(scores??[])].flatMap(([id,score])=>{const row=rows?.get(id);return row&&matches(row.chunk.metadata,q.filter)?[{chunk:row.chunk,score}]:[];}),q.limit);
      }
      const terms = [...new Set(q.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0,64);
      return ordered([...(partitions.get(scopeKey(q.scope,q.space))?.values() ?? [])].filter(row => matches(row.chunk.metadata,q.filter)).map(row => {
        const words = row.chunk.text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
        return { chunk: row.chunk, score: terms.reduce((sum, term) => sum + words.filter(word => word === term).length / (words.length + 1), 0) };
      }).filter(hit => hit.score > 0),q.limit);
    },
    async delete(scope: Scope, space: string, ids: readonly string[], signal: AbortSignal) {
      cancelled(signal); if (ids.length > 128) throw new MayuraError('INVALID_INPUT','RAG deletion batch is too large.');
      const checked = ids.map(id); const key = scopeKey(scope,space); const rows = partitions.get(key);
      const groups=documentGroups.get(key);const affected=new Set<string>();
      for (const value of checked){const old=rows?.get(value);if(rows?.delete(value)){count--;if(options.lexicalUnit==='document'&&old){const id=lexicalDocumentKey(old.chunk);groups?.get(id)?.delete(value);affected.add(id);}else lexicalIndexes.get(key)?.delete(value);}}
      for(const id of affected){const group=groups?.get(id);if(group?.size)lexicalIndexes.get(key)?.set(id,lexicalDocumentText(group));else{groups?.delete(id);lexicalIndexes.get(key)?.delete(id);}}
      if (rows?.size === 0){partitions.delete(key);lexicalIndexes.delete(key);documentGroups.delete(key);}
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
