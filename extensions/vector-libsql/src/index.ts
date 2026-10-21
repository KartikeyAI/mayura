import { MayuraError, type Permissions, type Scope } from 'mayura/core';
import { sha256Hex } from 'mayura/core/host';
import type { RagChunk, RagQuery, RagVector, VectorStore } from 'mayura/rag';
import { cancelled, checkedEntries, checkedQuery, chunk, id, integer, matches, scopeKey, snapshot } from 'mayura/rag/host';
export interface SqlVectorOptions {
  /** Host-owned pool/client. Must bind parameters; never concatenate caller input into SQL. */
  readonly execute:(sql:string,parameters:readonly (string|number)[],signal:AbortSignal)=>Promise<readonly Record<string,unknown>[]>;
  readonly location:'local'|'hosted'; readonly table:string; readonly dimensions:number; readonly costMicros:number; readonly permissions:Permissions;
}
/** Native libSQL F32 vectors, exact cosine ordering and parameterized scope/metadata filters. */
export function libsqlVectorStore(options:SqlVectorOptions):VectorStore & {initialize(signal:AbortSignal):Promise<void>} {
  const dimensions=integer(options.dimensions,1,4096);const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);
  if(!/^[a-z][a-z0-9_]{0,62}$/u.test(options.table))throw new MayuraError('INVALID_CONFIG','Invalid libSQL vector table.');const table=`"${options.table}"`;
  const execute=async(sql:string,params:readonly(string|number)[],signal:AbortSignal)=>{cancelled(signal);if(!options.permissions.allow.includes('rag:transport:libsql'))throw new MayuraError('PERMISSION_DENIED','libSQL transport permission required.');try{const rows=await options.execute(sql,params,signal);cancelled(signal);return rows;}catch{throw new MayuraError('STORAGE_UNAVAILABLE','libSQL vector operation failed; reconcile uncertain writes before retrying.');}};
  const ns=(scope:Scope,space:string)=>sha256Hex(scopeKey(scope,space));
  return Object.freeze({id:'libsql',dimensions,costMicros,location:options.location,
    async initialize(signal:AbortSignal){if(!options.permissions.allow.includes('rag:admin'))throw new MayuraError('PERMISSION_DENIED','RAG schema permission required.');await execute(`CREATE TABLE IF NOT EXISTS ${table} (namespace TEXT NOT NULL, id TEXT NOT NULL, chunk TEXT NOT NULL, metadata TEXT NOT NULL, embedding F32_BLOB(${dimensions}) NOT NULL, PRIMARY KEY(namespace,id))`,[],signal);},
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal){const key=ns(scope,space);for(const entry of checkedEntries(entries,dimensions))await execute(`INSERT INTO ${table}(namespace,id,chunk,metadata,embedding) VALUES(?,?,?,?,vector32(?)) ON CONFLICT(namespace,id) DO UPDATE SET chunk=excluded.chunk,metadata=excluded.metadata,embedding=excluded.embedding`,[key,entry.chunk.id,JSON.stringify(entry.chunk),JSON.stringify(entry.chunk.metadata),JSON.stringify(entry.values)],signal);},
    async query(raw:RagQuery){const q=checkedQuery(raw,dimensions);const filters=Object.entries(q.filter);const clauses=filters.map(()=> '(json_type(metadata, ?) IN (SELECT value FROM json_each(?)) AND json_extract(metadata, ?) = ?)').join(' AND ');const bindings=filters.flatMap(([key,value])=>[`$.${key}`,JSON.stringify(typeof value==='boolean'?[String(value)]:typeof value==='number'?['integer','real']:['text']),`$.${key}`,typeof value==='boolean'?Number(value):value]);
      const rows=await execute(`SELECT chunk, 1-vector_distance_cos(embedding,vector32(?)) AS score FROM ${table} WHERE namespace=? ${clauses?'AND '+clauses:''} ORDER BY score DESC,id LIMIT ?`,[JSON.stringify(q.vector),ns(q.scope,q.space),...bindings,q.limit],q.signal);if(rows.length>q.limit)throw new Error();return snapshot(rows.map(row=>{const item=chunk(JSON.parse(row['chunk'] as string) as RagChunk);const score=Number(row['score']);if(!Number.isFinite(score)||!matches(item.metadata,q.filter))throw new Error();return {chunk:item,score};}));},
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal){if(ids.length>128)throw new Error();await execute(`DELETE FROM ${table} WHERE namespace=? AND id IN (SELECT value FROM json_each(?))`,[ns(scope,space),JSON.stringify(ids.map(id))],signal);},
  });
}
