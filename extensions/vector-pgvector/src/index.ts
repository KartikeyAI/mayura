import { MayuraError, type Permissions, type Scope } from 'mayura/core';
import { sha256Hex } from 'mayura/core/host';
import type { RagChunk, RagQuery, RagVector, VectorStore } from 'mayura/rag';
import { cancelled, checkedEntries, checkedQuery, chunk, id, integer, matches, scopeKey, snapshot } from 'mayura/rag/host';
export interface SqlVectorOptions {
  /** Host-owned pool/client. Must bind parameters; never concatenate caller input into SQL. */
  readonly execute:(sql:string,parameters:readonly (string|number)[],signal:AbortSignal)=>Promise<readonly Record<string,unknown>[]>;
  readonly location:'local'|'hosted'; readonly table:string; readonly dimensions:number; readonly costMicros:number; readonly permissions:Permissions;
}
/** Provision pgvector separately; initialize creates only the explicitly named Mayura table. */
export function pgvectorStore(options:SqlVectorOptions):VectorStore & {initialize(signal:AbortSignal):Promise<void>} {
  const dimensions=integer(options.dimensions,1,4096);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);
  if(!/^[a-z][a-z0-9_]{0,62}$/u.test(options.table))throw new MayuraError('INVALID_CONFIG','Invalid pgvector table.');const table=`"${options.table}"`;
  const execute=async(sql:string,params:readonly(string|number)[],signal:AbortSignal)=>{cancelled(signal);if(!options.permissions.allow.includes('rag:transport:pgvector'))throw new MayuraError('PERMISSION_DENIED','pgvector transport permission required.');try{const rows=await options.execute(sql,params,signal);cancelled(signal);return rows;}catch{throw new MayuraError('STORAGE_UNAVAILABLE','pgvector operation failed; reconcile uncertain writes before retrying.');}};
  const ns=(scope:Scope,space:string)=>sha256Hex(scopeKey(scope,space));
  return Object.freeze({id:'pgvector',dimensions,costMicros,location:options.location,
    async initialize(signal:AbortSignal){if(!options.permissions.allow.includes('rag:admin'))throw new MayuraError('PERMISSION_DENIED','RAG schema permission required.');await execute(`CREATE TABLE IF NOT EXISTS ${table} (namespace text NOT NULL, id text NOT NULL, chunk jsonb NOT NULL, metadata jsonb NOT NULL, embedding vector(${dimensions}) NOT NULL, PRIMARY KEY(namespace,id))`,[],signal);},
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal){const key=ns(scope,space);for(const entry of checkedEntries(entries,dimensions))await execute(`INSERT INTO ${table}(namespace,id,chunk,metadata,embedding) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::vector) ON CONFLICT(namespace,id) DO UPDATE SET chunk=EXCLUDED.chunk, metadata=EXCLUDED.metadata, embedding=EXCLUDED.embedding`,[key,entry.chunk.id,JSON.stringify(entry.chunk),JSON.stringify(entry.chunk.metadata),JSON.stringify(entry.values)],signal);},
    async query(raw:RagQuery){const q=checkedQuery(raw,dimensions);const rows=await execute(`SELECT chunk, 1-(embedding <=> $2::vector) AS score FROM ${table} WHERE namespace=$1 AND metadata @> $3::jsonb ORDER BY embedding <=> $2::vector, id LIMIT $4`,[ns(q.scope,q.space),JSON.stringify(q.vector),JSON.stringify(q.filter),q.limit],q.signal);if(rows.length>q.limit)throw new Error();return snapshot(rows.map(row=>{const item=chunk(typeof row['chunk']==='string'?JSON.parse(row['chunk']) as RagChunk:row['chunk'] as RagChunk);const score=Number(row['score']);if(!Number.isFinite(score)||!matches(item.metadata,q.filter))throw new Error();return {chunk:item,score};}));},
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal){if(ids.length>128)throw new Error();const checked=ids.map(id);await execute(`DELETE FROM ${table} WHERE namespace=$1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,[ns(scope,space),JSON.stringify(checked)],signal);},
  });
}
