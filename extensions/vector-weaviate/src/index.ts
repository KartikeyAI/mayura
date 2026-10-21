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
/** Requires a provisioned self-provided cosine-vector collection with field-tokenized namespace/filter strings. */
export function weaviateVectorStore(options:Options):VectorStore {
  const dimensions=integer(options.dimensions,1,4096);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);const request=ragHttp('weaviate',options);
  const collection=options.collection;if(!/^[A-Z][A-Za-z0-9_]{0,63}$/u.test(collection))throw new MayuraError('INVALID_CONFIG','Invalid Weaviate collection.');
  const equal=(key:string,value:string|number|boolean)=>({path:[key],operator:'Equal',...(typeof value==='number'?{valueNumber:value}:typeof value==='boolean'?{valueBoolean:value}:{valueText:value})});
  return Object.freeze({id:'weaviate',dimensions,costMicros,location:'hosted' as const,
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal) {
      const ns=namespace(scope,space);const response=await request('/v1/batch/objects',{objects:checkedEntries(entries,dimensions).map(entry=>({class:collection,id:uuid(`${ns}:${entry.chunk.id}`),vector:entry.values,properties:{...entry.chunk.metadata,mayuraNamespace:ns,mayuraId:entry.chunk.id,mayuraChunk:JSON.stringify(entry.chunk)}}))},signal);
      const rows=list(response['results']);if(rows.length!==entries.length||rows.some(row=>object(row)['result']&&object(object(row)['result'])['errors']))throw new MayuraError('MODEL_FAILED','Weaviate rejected one or more staged vectors.');
    },
    async query(raw:RagQuery) {
      const q=checkedQuery(raw,dimensions);const ns=namespace(q.scope,q.space);const where={operator:'And',operands:[equal('mayuraNamespace',ns),...Object.entries(q.filter).map(([key,value])=>equal(key,value))]};
      // JSON-encode every literal; only the host-validated class name enters GraphQL syntax.
      const literal=(raw:unknown,key=''):string=> {
        if(Array.isArray(raw))return `[${raw.map(value=>literal(value)).join(',')}]`;
        if(raw && typeof raw==='object')return `{${Object.entries(raw).map(([field,value])=>`${field}:${literal(value,field)}`).join(',')}}`;
        if(key==='operator' && (raw==='And'||raw==='Equal'))return raw;
        return JSON.stringify(raw);
      };
      const response=await request('/v1/graphql',{query:`{Get{${collection}(nearVector:{vector:${JSON.stringify(q.vector)}},where:${literal(where)},limit:${q.limit}){mayuraNamespace mayuraChunk _additional{id distance}}}}`},q.signal);
      if(response['errors'])throw new MayuraError('MODEL_FAILED','Weaviate query failed.');
      return snapshot(list(object(object(response['data'])['Get'])[collection]).map(raw=>{const row=object(raw);const extra=object(row['_additional']);if(row['mayuraNamespace']!==ns||typeof extra['distance']!=='number')throw new Error();const result=hit(row['mayuraChunk'],1-(extra['distance'] as number),q.filter);if(extra['id']!==uuid(`${ns}:${result.chunk.id}`))throw new Error();return result;}));
    },
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal) {
      if(ids.length<1||ids.length>128)throw new Error();const ns=namespace(scope,space);
      const response=await request('/v1/batch/objects',{match:{class:collection,where:{operator:'And',operands:[equal('mayuraNamespace',ns),{operator:'Or',operands:ids.map(value=>equal('mayuraId',id(value)))}]}},output:'minimal',dryRun:false},signal,'DELETE');
      const results=object(response['results']);if(typeof results['failed']!=='number'||results['failed']!==0)throw new MayuraError('MODEL_FAILED','Weaviate deletion was incomplete.');
    },
  });
}
