import { MayuraError, type Scope } from 'mayura/core';
import { sha256Hex } from 'mayura/core/host';
import type { RagChunk, RagHit, RagQuery, RagVector, VectorStore } from 'mayura/rag';
import { checkedEntries, checkedQuery, chunk, id, integer, matches, ragHttp, scopeKey, snapshot, type RagHttpOptions } from 'mayura/rag/host';
export interface Options extends RagHttpOptions { readonly dimensions:number; readonly costMicros:number; readonly collection:string }
function object(raw:unknown):Record<string,unknown> { if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new MayuraError('INVALID_OUTPUT','Invalid vector service response.'); return raw as Record<string,unknown>; }
function list(raw:unknown):unknown[] { if (!Array.isArray(raw) || raw.length>1000) throw new MayuraError('INVALID_OUTPUT','Invalid vector service results.'); return raw; }
function namespace(scope:Scope,space:string):string { return sha256Hex(scopeKey(scope,space)); }
function uuid(value:string):string { const raw=sha256Hex(value);return `${raw.slice(0,8)}-${raw.slice(8,12)}-4${raw.slice(13,16)}-a${raw.slice(17,20)}-${raw.slice(20,32)}`; }
function hit(raw:unknown,score:unknown,filter:RagQuery['filter']):RagHit {
  const item=chunk(typeof raw==='string' ? JSON.parse(raw) as RagChunk : raw as RagChunk);
  if (typeof score!=='number' || !Number.isFinite(score) || !matches(item.metadata,filter)) throw new MayuraError('INVALID_OUTPUT','Vector service returned an invalid or unfiltered result.');
  return {chunk:item,score};
}
export function qdrantVectorStore(options:Options):VectorStore {
  const dimensions=integer(options.dimensions,1,4096); const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);const request=ragHttp('qdrant',options);const path=`/collections/${encodeURIComponent(id(options.collection))}/points`;
  return Object.freeze({id:'qdrant',dimensions,costMicros,location:'hosted' as const,
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal) {
      const ns=namespace(scope,space);await request(`${path}?wait=true`,{points:checkedEntries(entries,dimensions).map(entry=>({id:uuid(`${ns}:${entry.chunk.id}`),vector:entry.values,payload:{...entry.chunk.metadata,mayuraNamespace:ns,mayuraChunk:JSON.stringify(entry.chunk)}}))},signal,'PUT');
    },
    async query(raw:RagQuery) {
      const q=checkedQuery(raw,dimensions); const ns=namespace(q.scope,q.space); const response=await request(`${path}/query`,{query:q.vector,limit:q.limit,with_payload:true,filter:{must:[{key:'mayuraNamespace',match:{value:ns}},...Object.entries(q.filter).map(([key,value])=>(typeof value==='number' ? {key,range:{gte:value,lte:value}} : {key,match:{value}}))]}},q.signal);
      return snapshot(list(object(response['result'])['points']).map(row=>{const value=object(row);const payload=object(value['payload']);if(payload['mayuraNamespace']!==ns)throw new Error();const result=hit(payload['mayuraChunk'],value['score'],q.filter);if(value['id']!==uuid(`${ns}:${result.chunk.id}`))throw new Error();return result;}));
    },
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal) {if(ids.length>128)throw new Error();const ns=namespace(scope,space);await request(`${path}/delete?wait=true`,{points:ids.map(value=>uuid(`${ns}:${id(value)}`))},signal);},
  });
}
