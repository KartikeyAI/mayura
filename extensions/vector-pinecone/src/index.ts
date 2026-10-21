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
export function pineconeVectorStore(options:Options):VectorStore {
  const dimensions=integer(options.dimensions,1,4096); const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER); const request=ragHttp('pinecone',options);
  return Object.freeze({id:'pinecone',dimensions,costMicros,location:'hosted' as const,
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal) {
      await request('/vectors/upsert',{namespace:namespace(scope,space),vectors:checkedEntries(entries,dimensions).map(entry=>({id:entry.chunk.id,values:entry.values,metadata:{...entry.chunk.metadata,mayuraNamespace:namespace(scope,space),mayuraChunk:JSON.stringify(entry.chunk)}}))},signal);
    },
    async query(raw:RagQuery) {
      const q=checkedQuery(raw,dimensions); const response=await request('/query',{namespace:namespace(q.scope,q.space),vector:q.vector,topK:q.limit,includeMetadata:true,includeValues:false,filter:Object.fromEntries(Object.entries(q.filter).map(([key,value])=>[key,{$eq:value}]))},q.signal);
      return snapshot(list(response['matches']).map(row=>{const value=object(row);if(object(value['metadata'])['mayuraNamespace']!==namespace(q.scope,q.space))throw new Error(); const result=hit(object(value['metadata'])['mayuraChunk'],value['score'],q.filter);if(value['id']!==result.chunk.id)throw new Error();return result;}));
    },
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal) {if(ids.length>128)throw new Error();await request('/vectors/delete',{namespace:namespace(scope,space),ids:ids.map(id)},signal);},
  });
}
