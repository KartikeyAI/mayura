import { MayuraError, type JsonObject, type Scope } from '@mayura/core';
import { base64ToBytes, bytesToBase64, sha256Hex } from '@mayura/core/host';
import type { MemoryIndexStore, MemoryRow, MemoryRowSensitivity } from '@mayura/storage-contracts';
import type { RagChunk, RagHit, RagQuery, RagVector, VectorStore } from './contracts.js';
import { cancelled, chunk, id, integer, matches, scopeKey, snapshot } from './validation.js';
import { checkedEntries, checkedQuery, cosine } from './vectors.js';
const sensitivities: readonly MemoryRowSensitivity[] = ['public','internal','confidential','restricted'];
function encode(values: readonly number[]): string {
  const data = new Uint8Array(values.length*4); const view = new DataView(data.buffer); values.forEach((value,index) => view.setFloat32(index*4,value,true)); return bytesToBase64(data);
}
function decode(raw: string, dimensions: number): number[] {
  const data = base64ToBytes(raw); if (data.length !== dimensions*4) throw new MayuraError('INVALID_OUTPUT','Invalid stored RAG vector.');
  const view = new DataView(data.buffer,data.byteOffset,data.byteLength); return Array.from({length:dimensions},(_,index) => view.getFloat32(index*4,true));
}
/** Reuses the native memory tables in a domain-separated scope, without creating user-visible memory records. */
export function nativeMemoryVectorStore(options: { readonly memory:MemoryIndexStore; readonly dimensions:number; readonly maxScan:number; readonly location:'local'|'hosted'; readonly costMicros:number }): VectorStore {
  if(!['local','hosted'].includes(options.location))throw new MayuraError('INVALID_CONFIG','Native RAG storage location is required.');
  const costMicros=integer(options.costMicros,0,Number.MAX_SAFE_INTEGER);
  const dimensions = integer(options.dimensions,1,4096); const maxScan = integer(options.maxScan,1,100_000); const db = options.memory;
  const key = (scope: Scope,space: string) => sha256Hex(`rag.v1:${scopeKey(scope,space)}`);
  const read = async (namespace:string,ids:readonly string[]) => await db.getRecords({scope:namespace,ids});
  const fromRows = (rows: readonly MemoryRow[], scores: ReadonlyMap<string,number>, filter: RagQuery['filter']): RagHit[] => rows.filter(row => row.status === 'active' && row.body && scores.has(row.id)).map(row => ({chunk:chunk(row.body as unknown as RagChunk),score:scores.get(row.id)!})).filter(hit => matches(hit.chunk.metadata,filter));
  return Object.freeze({ id:'mayura.rag.native-memory',dimensions,costMicros,location:options.location,
    async upsert(scope:Scope,space:string,entries:readonly RagVector[],signal:AbortSignal) {
      cancelled(signal); const namespace = key(scope,space); const checked = checkedEntries(entries,dimensions);
      for (const entry of checked) {
        cancelled(signal); const existing = (await read(namespace,[entry.chunk.id]))[0]; cancelled(signal);
        if (existing && (existing.status !== 'active' || JSON.stringify(existing.body) !== JSON.stringify(entry.chunk))) throw new MayuraError('CONFLICT','Immutable RAG chunk changed.');
        if (!existing) {
          const now = new Date().toISOString(); const counts = new Map<string,number>();
          for (const term of entry.chunk.text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []) if (term.length <=64) counts.set(term,(counts.get(term) ?? 0)+1);
          await db.putRecord({scope:namespace,expectedVersion:0,record:{ id:entry.chunk.id,version:1,status:'active',sensitivity:entry.chunk.sensitivity,body:entry.chunk as unknown as JsonObject,validFrom:now,validUntil:null,createdAt:now,updatedAt:now,deletedAt:null,supersededBy:null },terms:[...counts].slice(0,4096)}); cancelled(signal);
        }
        const result = await db.putVectors({scope:namespace,embedderId:space,dimensions,entries:[{recordId:entry.chunk.id,recordVersion:1,vector:encode(entry.values),list:null}]}); cancelled(signal);
        if (result.written !== 1) throw new MayuraError('CONFLICT','RAG chunk changed during indexing.');
      }
    },
    async query(raw:RagQuery) {
      const q = checkedQuery(raw,dimensions); const namespace = key(q.scope,q.space); const hits:RagHit[] = []; let after:string | undefined; let scanned=0;
      for (;;) {
        const rows = await db.vectors({scope:namespace,embedderId:q.space,limit:Math.min(1000,maxScan-scanned+1),sensitivities,asOf:new Date().toISOString(),...(after ? {after} : {})}); cancelled(q.signal);
        scanned += rows.length; if (scanned > maxScan) throw new MayuraError('BUDGET_EXCEEDED','RAG native vector scan limit exceeded.');
        if (!rows.length) break;
        const scores = new Map(rows.map(row => [row.recordId,cosine(q.vector,decode(row.vector,dimensions))]));
        hits.push(...fromRows(await read(namespace,rows.map(row => row.recordId)),scores,q.filter)); cancelled(q.signal);
        after = rows.at(-1)!.recordId;
        if (rows.length < Math.min(1000,maxScan-scanned+rows.length+1)) break;
      }
      return snapshot(hits.sort((a,b) => b.score-a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0,q.limit));
    },
    async lexical(q:Omit<RagQuery,'vector'> & {readonly text:string}) {
      cancelled(q.signal); integer(q.limit,1,100); const namespace=key(q.scope,q.space);
      const terms=[...new Set(q.text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter(term => term.length<=64).slice(0,32); if (!terms.length) return [];
      const ranked=await db.rank({scope:namespace,terms,limit:q.limit,sensitivities,asOf:new Date().toISOString()}); cancelled(q.signal);
      const result=fromRows(await read(namespace,ranked.hits.map(row => row.id)),new Map(ranked.hits.map(row => [row.id,row.score])),q.filter); cancelled(q.signal); return snapshot(result.sort((a,b)=>b.score-a.score));
    },
    async delete(scope:Scope,space:string,ids:readonly string[],signal:AbortSignal) {
      cancelled(signal); if (ids.length>128) throw new MayuraError('INVALID_INPUT','RAG deletion batch too large.'); const namespace=key(scope,space);
      for (const row of await read(namespace,ids.map(id))) {
        cancelled(signal); if (row.status === 'deleted') continue;
        await db.putRecord({scope:namespace,expectedVersion:row.version,record:{...row,version:row.version+1,status:'deleted',body:null,validFrom:null,validUntil:null,updatedAt:new Date().toISOString(),deletedAt:new Date().toISOString()},terms:[]}); cancelled(signal);
      }
    },
  });
}
