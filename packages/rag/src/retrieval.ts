import { MayuraError } from '@mayura/core';
import type { RagAccess, RagCatalog, RagEmbedder, RagHit, RagMetadata, RagQueryTransform, RagReranker, RetrievalResult, Retriever, VectorStore } from './contracts.js';
import { access, cancelled, chunk, id, integer, matches, metadata, snapshot, text, vector } from './validation.js';
export interface RetrieverOptions extends RagAccess {
  readonly store: VectorStore; readonly catalog: RagCatalog; readonly embedder: RagEmbedder; readonly space: string;
  readonly parentDocuments?: boolean;
  readonly mode?: 'semantic' | 'hybrid'; readonly filter?: RagMetadata; readonly limit: number; readonly candidateLimit: number;
  readonly transform?: RagQueryTransform; readonly reranker?: RagReranker;
  readonly maxQueries: number; readonly maxCostMicros: number; readonly timeoutMs: number; readonly maxConcurrent: number;
}
/** Reserve declared worst-case cost before any callback. Returned costs are reservations, never a bill estimate. */
export function createRetriever(options: RetrieverOptions): Retriever {
  const boundary = access(options); const store = options.store; const embedder = options.embedder; const space = id(options.space);
  const limit = integer(options.limit,1,100); const candidates = integer(options.candidateLimit,limit,100);
  const queries = integer(options.maxQueries,1,4); const timeout = integer(options.timeoutMs,1,30_000); const cap = integer(options.maxConcurrent,1,128);
  const filter = metadata(options.filter ?? {}); const transform = options.transform; const reranker = options.reranker;
  if(options.mode!==undefined && !['semantic','hybrid'].includes(options.mode) || transform && (!['rewrite','multi-query','hyde'].includes(transform.mode) || transform.mode==='multi-query' && queries<2)) throw new MayuraError('INVALID_CONFIG','Invalid RAG retrieval mode or query budget.');
  if(!['local','hosted'].includes(store.location)||!['local','hosted'].includes(embedder.location)||reranker&&!['local','hosted'].includes(reranker.location))throw new MayuraError('INVALID_CONFIG','RAG adapter location must be explicit.');
  integer(embedder.maxBatch,1,2048); integer(embedder.dimensions,1,4096); id(embedder.id);
  if (store.dimensions !== embedder.dimensions || options.mode === 'hybrid' && !store.lexical) throw new MayuraError('INVALID_CONFIG','RAG index dimensions or hybrid capability do not match.');
  const cost = integer(embedder.costMicros,0,Number.MAX_SAFE_INTEGER) * Math.ceil(queries / embedder.maxBatch)
    + queries * (options.mode === 'hybrid' ? 2 : 1) * integer(store.costMicros,0,Number.MAX_SAFE_INTEGER)
    + (transform ? integer(transform.costMicros,0,Number.MAX_SAFE_INTEGER) : 0) + (reranker ? integer(reranker.costMicros,0,Number.MAX_SAFE_INTEGER) : 0);
  integer(cost,0,integer(options.maxCostMicros,0,Number.MAX_SAFE_INTEGER)); let active = 0;
  const retrieve: Retriever['retrieve'] = async (raw, supplied = {}) => {
    const query = text(raw,2000); boundary.require('rag:read'); if (embedder.location === 'hosted') boundary.require('rag:embed');
    if (transform) boundary.require(`rag:transform:${id(transform.id)}`); if (reranker) boundary.require(`rag:rerank:${id(reranker.id)}`);
    if (active >= cap) throw new MayuraError('BUDGET_EXCEEDED','RAG concurrent retrieval limit exceeded.');
    const control = new AbortController(); const relay = () => control.abort(); supplied.signal?.addEventListener('abort',relay,{ once:true }); if (supplied.signal?.aborted) relay();
    const timer = setTimeout(relay,timeout); const signal = control.signal; const started = Date.now(); active++;
    const work = async () => {
      await boundary.authorize('search','collection',signal);
      let texts = [query];
      if (transform) {
        const changed = await transform.transform(query,signal); cancelled(signal);
        if (!Array.isArray(changed) || changed.length < 1 || changed.length > queries - (transform.mode === 'multi-query' ? 1 : 0)) throw new MayuraError('INVALID_OUTPUT','RAG query transform exceeded its query budget.');
        texts = [...new Set([...(transform.mode === 'multi-query' ? [query] : []), ...changed.map(value => text(value,2000))])];
      }
      const lists: (readonly RagHit[])[] = [];
      for (let offset = 0; offset < texts.length; offset += embedder.maxBatch) {
        await boundary.authorize('search','collection',signal); const batch = texts.slice(offset,offset + embedder.maxBatch); const embedded = await embedder.embed(batch,signal); cancelled(signal);
        if (!Array.isArray(embedded) || embedded.length !== batch.length) throw new MayuraError('INVALID_OUTPUT','Invalid RAG embedding batch.');
        for (let index = 0; index < batch.length; index++) {
          const q = { scope: boundary.scope, space, vector: vector(embedded[index]!,embedder.dimensions), limit: candidates, filter, signal };
          lists.push(await store.query(q)); cancelled(signal);
          if (options.mode === 'hybrid') { lists.push(await store.lexical!({ scope: boundary.scope, space, text: batch[index]!, limit:candidates,filter,signal })); cancelled(signal); }
        }
      }
      const combined = new Map<string,RagHit>(); let seen = 0;
      for (const list of lists) {
        if (!Array.isArray(list) || list.length > candidates) throw new MayuraError('INVALID_OUTPUT','RAG store exceeded its candidate budget.');
        const unique = new Set<string>();
        for (let rank = 0; rank < list.length; rank++) {
          const hit = list[rank]!; const item = chunk(hit.chunk);
          if (!Number.isFinite(hit.score) || unique.has(item.id)) throw new MayuraError('INVALID_OUTPUT','Invalid or duplicate RAG search hit.'); unique.add(item.id);
          if (!matches(item.metadata,filter) || !boundary.profile.includes(item.sensitivity)) continue;
          const published = await options.catalog.read(boundary.scope,item.documentId,signal); cancelled(signal);
          if (!published || published.deleted || published.revision !== item.revision || published.space !== space || !published.chunkIds.includes(item.id)) continue;
          if (options.authorization) {
            const decision = await options.authorization.authorize(boundary.scope,'read',{ kind:'rag_document',id:item.documentId,scope:boundary.scope },{ signal }); cancelled(signal);
            if (decision.effect !== 'allow') {
              if (['unavailable','cancelled','limit_exceeded'].includes(decision.reason)) throw new MayuraError('PERMISSION_DENIED','RAG authorization is unavailable.');
              continue;
            }
          }
          seen++; const previous = combined.get(item.id); combined.set(item.id,{ chunk:item, score:(previous?.score ?? 0) + 1 / (60 + rank + 1) });
        }
      }
      let hits = [...combined.values()].sort((a,b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0,candidates);
      if (reranker && hits.length) {
        if (reranker.location === 'hosted' && hits.some(hit => !boundary.hosted.includes(hit.chunk.sensitivity))) throw new MayuraError('PERMISSION_DENIED','RAG hosted reranking sensitivity is not admitted.');
        for(const hit of hits)await boundary.authorize('read',hit.chunk.documentId,signal);
        const ranked = await reranker.rank(query,hits.map(hit => (hit.chunk.context ? hit.chunk.context+'\n' : '')+hit.chunk.text),signal); cancelled(signal);
        if (!Array.isArray(ranked) || ranked.length > hits.length || new Set(ranked.map(row => row.index)).size !== ranked.length) throw new MayuraError('INVALID_OUTPUT','Invalid RAG reranking result.');
        hits = ranked.map(row => { integer(row.index,0,hits.length - 1); if (!Number.isFinite(row.score)) throw new MayuraError('INVALID_OUTPUT','Invalid reranking score.'); return { chunk:hits[row.index]!.chunk,score:row.score }; }).sort((a,b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
      }
      // Recheck publication and policy after hosted work before releasing evidence.
      const released: RagHit[] = [];
      for (const hit of hits.slice(0,limit)) {
        const current = await options.catalog.read(boundary.scope,hit.chunk.documentId,signal); cancelled(signal);
        if (!current || current.deleted || current.revision !== hit.chunk.revision || current.space !== space || !current.chunkIds.includes(hit.chunk.id)) continue;
        await boundary.authorize('read',hit.chunk.documentId,signal); released.push({...hit,...(options.parentDocuments && hit.chunk.parent ? {parent:hit.chunk.parent} : {})});
      }
      return snapshot({ hits:released, metrics:{ queries:texts.length,candidates:seen,returned:released.length,reservedCostMicros:cost,durationMs:Date.now() - started } });
    };
    // Keep the admission occupied until an abort-ignoring adapter actually settles.
    const pending = work().finally(() => { active--; clearTimeout(timer); supplied.signal?.removeEventListener('abort',relay); });
    return await new Promise<RetrievalResult>((resolve,reject) => {
      const abort = () => reject(new MayuraError('CANCELLED','RAG retrieval cancelled or timed out.'));
      signal.addEventListener('abort',abort,{once:true}); if (signal.aborted) abort();
      void pending.then(result => { signal.removeEventListener('abort',abort); if (!signal.aborted) resolve(result); }, () => { signal.removeEventListener('abort',abort); reject(new MayuraError(signal.aborted ? 'CANCELLED' : 'MODEL_FAILED','RAG retrieval could not complete.')); });
    });
  };
  return Object.freeze({ scope:boundary.scope,costMicros:cost,retrieve });
}
