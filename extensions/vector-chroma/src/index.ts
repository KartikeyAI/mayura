import { MayuraError, type Scope } from 'mayura/core';
import { sha256Hex } from 'mayura/core/host';
import type { RagChunk, RagHit, RagQuery, RagVector, VectorStore } from 'mayura/rag';
import { checkedEntries, checkedQuery, chunk, id, integer, matches, ragHttp, scopeKey, snapshot, type RagHttpOptions } from 'mayura/rag/host';
export interface Options extends RagHttpOptions { readonly dimensions:number; readonly costMicros:number; readonly collection:string }
function object(raw:unknown):Record<string,unknown> { if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new MayuraError('INVALID_OUTPUT','Invalid vector service response.'); return raw as Record<string,unknown>; }
function list(raw:unknown):unknown[] { if (!Array.isArray(raw) || raw.length>1000) throw new MayuraError('INVALID_OUTPUT','Invalid vector service results.'); return raw; }
function namespace(scope:Scope,space:string):string { return sha256Hex(scopeKey(scope,space)); }
function hit(raw:unknown,score:unknown,filter:RagQuery['filter']):RagHit {
  const item=chunk(typeof raw==='string' ? JSON.parse(raw) as RagChunk : raw as RagChunk);
  if (typeof score!=='number' || !Number.isFinite(score) || !matches(item.metadata,filter)) throw new MayuraError('INVALID_OUTPUT','Vector service returned an invalid or unfiltered result.');
  return {chunk:item,score};
}
export interface ChromaOptions extends Options {readonly tenant:string;readonly database:string}
export function chromaVectorStore(options:ChromaOptions):VectorStore {
  const dimensions=integer(options.dimensions,1,4096);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);const request=ragHttp('chroma',options);
  const path=`/api/v2/tenants/${encodeURIComponent(id(options.tenant))}/databases/${encodeURIComponent(id(options.database))}/collections/${encodeURIComponent(id(options.collection))}`;
  return Object.freeze({id:'chroma',dimensions,costMicros,location:'hosted' as const,
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal) {
      const ns=namespace(scope,space);const checked=checkedEntries(entries,dimensions);await request(`${path}/upsert`,{ids:checked.map(entry=>`${ns}:${entry.chunk.id}`),embeddings:checked.map(entry=>entry.values),documents:checked.map(entry=>entry.chunk.text),metadatas:checked.map(entry=>({...entry.chunk.metadata,mayuraNamespace:ns,mayuraChunk:JSON.stringify(entry.chunk)}))},signal);
    },
    async query(raw:RagQuery) {
      const q=checkedQuery(raw,dimensions);const ns=namespace(q.scope,q.space);const terms=[{mayuraNamespace:{$eq:ns}},...Object.entries(q.filter).map(([key,value])=>({[key]:{$eq:value}}))];
      const response=await request(`${path}/query`,{query_embeddings:[q.vector],n_results:q.limit,where:terms.length===1?terms[0]:{$and:terms},include:['metadatas','distances']},q.signal);
      const ids=list(list(response['ids'])[0]);const metas=list(list(response['metadatas'])[0]);const distances=list(list(response['distances'])[0]);if(ids.length!==metas.length||ids.length!==distances.length)throw new Error();
      return snapshot(ids.map((value,index)=>{const meta=object(metas[index]);if(meta['mayuraNamespace']!==ns||typeof distances[index]!=='number')throw new Error();const result=hit(meta['mayuraChunk'],1-(distances[index] as number),q.filter);if(value!==`${ns}:${result.chunk.id}`)throw new Error();return result;}));
    },
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal) {if(ids.length>128)throw new Error();const ns=namespace(scope,space);await request(`${path}/delete`,{ids:ids.map(value=>`${ns}:${id(value)}`)},signal);},
  });
}
