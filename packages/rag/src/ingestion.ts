import { MayuraError, type JsonObject } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { defineTool } from '@mayura/tools';
import { defineWorkflow } from '@mayura/workflows';
import type { AggregateStore } from '@mayura/storage-contracts';
import type { RagAccess, RagCatalog, RagDocument, RagEmbedder, RagRevision, VectorStore } from './contracts.js';
import { chunkDocument, type ChunkOptions } from './loaders.js';
import { access, cancelled, document, hash, id, integer, revision, sameScope, schema, scopeKey, snapshot, vector } from './validation.js';
export interface RagIngestionInput { readonly document: RagDocument; readonly expectedRevision: string | null }
export interface RagIngestionOptions extends RagAccess {
  readonly id: string; readonly version: string; readonly store: VectorStore; readonly catalog: RagCatalog;
  readonly journal: AggregateStore; readonly embedder: RagEmbedder; readonly chunking: ChunkOptions;
  readonly maxCostMicros: number; readonly timeoutMs: number;
  readonly contextualizer?: {readonly id:string;readonly costMicros:number;readonly location:'local'|'hosted';contextualize(document:RagDocument,chunks:readonly string[],signal:AbortSignal):Promise<readonly string[]>};
}
/** Pin all index-affecting settings. Changing content, metadata, model or chunking creates a new identity. */
export function ragIndexSpace(embedder: RagEmbedder, chunking: ChunkOptions, contextualizerId = 'none'): string {
  return sha256Hex(JSON.stringify(['mayura.rag.v1',id(embedder.id),integer(embedder.dimensions,1,4096),chunking.maxChars,chunking.overlapChars,chunking.maxChunks,chunking.mode ?? 'recursive',chunking.parentChars ?? null,contextualizerId]));
}
/** Two durable steps: stage once, then CAS publication. Started uncertain stages are never automatically replayed. */
export function defineRagIngestion(options: RagIngestionOptions) {
  const boundary = access(options); const embedder = options.embedder; const timeoutMs = integer(options.timeoutMs,1,30_000);
  const chunking = snapshot(options.chunking); const space = ragIndexSpace(embedder,chunking,options.contextualizer?.id); const name = id(options.id);
  if(!['local','hosted'].includes(options.store.location)||!['local','hosted'].includes(embedder.location)||options.contextualizer&&!['local','hosted'].includes(options.contextualizer.location))throw new MayuraError('INVALID_CONFIG','RAG adapter location must be explicit.');
  integer(embedder.maxBatch,1,2048); const maxChunks = integer(chunking.maxChunks,1,128);
  if (options.store.dimensions !== embedder.dimensions) throw new MayuraError('INVALID_CONFIG','RAG ingestion dimensions do not match.');
  const cost = (integer(embedder.costMicros,0,Number.MAX_SAFE_INTEGER) + integer(options.store.costMicros,0,Number.MAX_SAFE_INTEGER)) * Math.ceil(maxChunks/embedder.maxBatch) + (options.contextualizer ? integer(options.contextualizer.costMicros,0,Number.MAX_SAFE_INTEGER) : 0);
  integer(cost,0,integer(options.maxCostMicros,0,Number.MAX_SAFE_INTEGER));
  const input = schema<RagIngestionInput>(raw => {
    const value = raw as RagIngestionInput;
    if (!value || Object.keys(value).sort().join(',') !== 'document,expectedRevision') throw new Error();
    return snapshot({ document:document(value.document),expectedRevision:value.expectedRevision === null ? null : hash(value.expectedRevision) });
  });
  const staged = schema<{ documentId:string; expectedRevision:string | null; next:RagRevision }>(raw => {
    const value = raw as { documentId:string; expectedRevision:string | null; next:RagRevision };
    return { documentId:id(value.documentId),expectedRevision:value.expectedRevision === null ? null : hash(value.expectedRevision),next:revision(value.next) };
  });
  const stage = defineTool({ id:`${name}.stage`,version:options.version,description:'Stage a bounded content-addressed RAG revision exactly once per durable claim.',input,output:staged,
    effects:'write',capabilities:['rag:index',...(embedder.location === 'hosted' ? ['rag:embed'] : [])],costMicros:cost,timeoutMs,
    async execute(command,context) {
      if (!sameScope(context.scope,boundary.scope)) throw new MayuraError('PERMISSION_DENIED','RAG ingestion scope mismatch.');
      boundary.require('rag:index'); if (embedder.location === 'hosted') boundary.require('rag:embed');
      const signal = context.signal; const doc = command.document;
      if(options.contextualizer) boundary.require(`rag:contextualize:${id(options.contextualizer.id)}`);
      if (!boundary.profile.includes(doc.sensitivity) || (embedder.location === 'hosted' || options.store.location === 'hosted' || options.contextualizer?.location === 'hosted') && !boundary.hosted.includes(doc.sensitivity)) throw new MayuraError('PERMISSION_DENIED','RAG ingestion sensitivity is not admitted.');
      await boundary.authorize('index',doc.id,signal);
      const contentHash = sha256Hex(JSON.stringify([doc.id,doc.text,doc.reference,Object.entries(doc.metadata).sort(([a],[b]) => a.localeCompare(b)),doc.sensitivity]));
      const current = await options.catalog.read(boundary.scope,doc.id,signal); cancelled(signal);
      if (current && !current.deleted && current.contentHash === contentHash && current.space === space) {
        // Even no-op ingestion must be based on the exact host-selected revision.
        if (command.expectedRevision !== current.revision) throw new MayuraError('CONFLICT','RAG expected revision changed.');
        context.reportUsage({knownCostMicros:0,unknownCostMicros:0}); return { documentId:doc.id,expectedRevision:current.revision,next:current };
      }
      if ((current?.revision ?? null) !== command.expectedRevision) throw new MayuraError('CONFLICT','RAG expected revision changed.');
      const revisionId = sha256Hex(JSON.stringify([space,contentHash,command.expectedRevision]));
      let chunks = chunkDocument(doc,revisionId,chunking);
      const next: RagRevision = { revision:revisionId,space,contentHash,chunkIds:chunks.map(value => value.id),deleted:false };
      const namespace = sha256Hex(scopeKey(boundary.scope,'rag.claims.v1'));
      const claim = await options.journal.create({ scope:namespace,id:revisionId,idempotencyKey:revisionId,definitionHash:space,
        state:{status:'claimed',documentId:doc.id,next:next as unknown as JsonObject},events:[{type:'rag.stage.claimed',data:{revision:revisionId}}] }); cancelled(signal);
      if (!claim.created) {
        if (claim.record.definitionHash !== space || claim.record.state['status'] !== 'prepared' || JSON.stringify(revision(claim.record.state['next'] as unknown as RagRevision)) !== JSON.stringify(revision(next))) throw new MayuraError('CONFLICT','RAG stage is already claimed; reconcile its result without repeating paid work.');
        return { documentId:doc.id,expectedRevision:command.expectedRevision,next:revision(claim.record.state['next'] as unknown as RagRevision) };
      }
      if(options.contextualizer) {
        await boundary.authorize('index',doc.id,signal);
        const contexts=await options.contextualizer.contextualize(doc,chunks.map(item=>item.text),signal);cancelled(signal);
        if(!Array.isArray(contexts)||contexts.length!==chunks.length||contexts.some(value=>typeof value!=='string'||!value.trim()||value.length>1000))throw new MayuraError('INVALID_OUTPUT','Invalid contextual retrieval output.');
        chunks=snapshot(chunks.map((item,index)=>({...item,context:contexts[index]!})));
      }
      // Claim remains uncertain on any failure, cancellation or lost acknowledgement. No automatic retries.
      for (let offset = 0; offset < chunks.length; offset += embedder.maxBatch) {
        await boundary.authorize('index',doc.id,signal); const batch = chunks.slice(offset,offset+embedder.maxBatch);
        const inputs=batch.map(item => (item.context ? item.context+'\n' : '')+item.text);
        const cacheScope=sha256Hex(scopeKey(boundary.scope,`rag.embeddings.${space}`));
        const values:(readonly number[])[]=new Array(batch.length);const pending:{index:number;key:string;version:number}[]=[];const duplicateOf=new Map<number,number>();const seenInputs=new Map<string,number>();
        for(let index=0;index<inputs.length;index++) {
          const key=sha256Hex(JSON.stringify([inputs[index],doc.sensitivity]));
          if(seenInputs.has(key)){duplicateOf.set(index,seenInputs.get(key)!);continue;}seenInputs.set(key,index);
          const cached=await options.journal.create({scope:cacheScope,id:key,idempotencyKey:key,definitionHash:space,state:{status:'claimed'},events:[{type:'rag.embedding.claimed',data:{}}]});cancelled(signal);
          if(cached.created)pending.push({index,key,version:cached.record.version});
          else if(cached.record.definitionHash===space&&cached.record.state['status']==='prepared')values[index]=vector(cached.record.state['values'] as number[],embedder.dimensions);
          else throw new MayuraError('CONFLICT','RAG embedding is already claimed; reconcile its result without repeating paid work.');
        }
        if(pending.length) {
          await boundary.authorize('index',doc.id,signal);
          const fresh=await embedder.embed(pending.map(item=>inputs[item.index]!),signal);cancelled(signal);
          if(!Array.isArray(fresh)||fresh.length!==pending.length)throw new MayuraError('INVALID_OUTPUT','Invalid RAG embedding count.');
          for(let index=0;index<pending.length;index++) {
            const item=pending[index]!;const admitted=vector(fresh[index]!,embedder.dimensions);values[item.index]=admitted;
            await options.journal.update({scope:cacheScope,id:item.key,expectedVersion:item.version,state:{status:'prepared',values:[...admitted]},events:[{type:'rag.embedding.prepared',data:{}}]});cancelled(signal);
          }
        }
        for(const [target,source] of duplicateOf)values[target]=values[source]!;
        await boundary.authorize('index',doc.id,signal);
        await options.store.upsert(boundary.scope,space,batch.map((item,index) => ({ chunk:item,values:vector(values[index]!,embedder.dimensions) })),signal); cancelled(signal);
      }
      await options.journal.update({scope:namespace,id:revisionId,expectedVersion:claim.record.version,state:{ status:'prepared',documentId:doc.id,next:next as unknown as JsonObject },events:[{type:'rag.stage.prepared',data:{revision:revisionId}}]}); cancelled(signal);
      return { documentId:doc.id,expectedRevision:command.expectedRevision,next };
    },
  });
  const publish = defineTool({ id:`${name}.publish`,version:options.version,description:'Publish only a prepared RAG revision using a catalog compare-and-set.',input:staged,output:staged,
    effects:'write',capabilities:['rag:index'],costMicros:0,timeoutMs,
    async execute(value,context) {
      if (!sameScope(context.scope,boundary.scope)) throw new MayuraError('PERMISSION_DENIED','RAG ingestion scope mismatch.'); boundary.require('rag:index');
      await boundary.authorize('index',value.documentId,context.signal);
      // Only the durable stage's stored receipt can authorize catalog publication.
      const current = await options.catalog.read(boundary.scope,value.documentId,context.signal);
      if (current?.revision !== value.next.revision) {
        const record = await options.journal.read(sha256Hex(scopeKey(boundary.scope,'rag.claims.v1')),value.next.revision); cancelled(context.signal);
        if (!record || record.definitionHash!==space || record.state['status'] !== 'prepared' || record.state['documentId'] !== value.documentId || JSON.stringify(record.state['next']) !== JSON.stringify(value.next)) throw new MayuraError('CONFLICT','RAG prepared stage receipt is missing.');
      }
      await boundary.authorize('index',value.documentId,context.signal);
      await options.catalog.publish(boundary.scope,value.documentId,value.expectedRevision,value.next,context.signal); return value;
    },
  });
  return defineWorkflow({id:name,version:options.version,input,output:staged,
    nodes:[{kind:'tool',id:'stage',tool:stage,input:{kind:'input',path:[]}},{kind:'tool',id:'publish',tool:publish,dependsOn:['stage'],input:{kind:'step',stepId:'stage',path:[]}}],result:{kind:'step',stepId:'publish',path:[]} });
}
/** Revoke visibility first. Old physical vectors can be removed separately using the returned immutable ids. */
export async function deleteRagDocument(options: RagAccess & { readonly catalog:RagCatalog; readonly documentId:string; readonly expectedRevision:string; readonly signal:AbortSignal }): Promise<RagRevision> {
  const boundary = access(options); boundary.require('rag:index'); const name = id(options.documentId); const expected = hash(options.expectedRevision);
  await boundary.authorize('delete',name,options.signal); const current = await options.catalog.read(boundary.scope,name,options.signal); cancelled(options.signal);
  if (!current || current.revision !== expected) throw new MayuraError('CONFLICT','RAG deletion revision changed.');
  const next = { ...current,revision:sha256Hex(JSON.stringify(['deleted',expected])),deleted:true };
  await options.catalog.publish(boundary.scope,name,expected,next,options.signal); return snapshot(next);
}

export interface RagClaimVerification {
  readonly scope:import('@mayura/core').Scope; readonly kind:'stage'|'embedding'; readonly claimId:string;
  readonly space:string; readonly state:Readonly<JsonObject>;
}
/** Recover a prepared receipt only from a trusted external verifier, without repeating model or vector writes. */
export async function reconcileRagClaim(options:RagAccess & {
  readonly journal:AggregateStore;readonly space:string;readonly claimId:string;readonly kind:'stage'|'embedding';readonly documentId:string;readonly signal:AbortSignal;
  readonly verify:(claim:RagClaimVerification,signal:AbortSignal)=>Promise<{readonly verified:true;readonly values?:readonly number[]}|undefined>;
  readonly dimensions:number;
}):Promise<void> {
  const boundary=access(options);boundary.require('rag:reconcile');await boundary.authorize('reconcile',options.kind==='embedding'?'collection':id(options.documentId),options.signal);
  const space=hash(options.space);const claimId=hash(options.claimId);if(!['stage','embedding'].includes(options.kind))throw new MayuraError('INVALID_INPUT','Invalid RAG claim kind.');
  const namespace=sha256Hex(scopeKey(boundary.scope,options.kind==='stage'?'rag.claims.v1':`rag.embeddings.${space}`));
  const current=await options.journal.read(namespace,claimId);cancelled(options.signal);
  if(!current||current.definitionHash!==space)throw new MayuraError('NOT_FOUND','RAG claim not found.');
  if(current.state['status']==='prepared')return;
  if(current.state['status']!=='claimed'||options.kind==='stage'&&current.state['documentId']!==options.documentId)throw new MayuraError('CONFLICT','RAG claim cannot be reconciled.');
  const proof=await options.verify(snapshot({scope:boundary.scope,kind:options.kind,claimId,space,state:current.state}),options.signal);cancelled(options.signal);
  if(!proof||proof.verified!==true)throw new MayuraError('CONFLICT','RAG claim result was not verified.');
  const next=options.kind==='stage'?{...current.state,status:'prepared'}:{status:'prepared',values:[...vector(proof.values!,integer(options.dimensions,1,4096))]};
  await boundary.authorize('reconcile',options.kind==='embedding'?'collection':options.documentId,options.signal);
  await options.journal.update({scope:namespace,id:claimId,expectedVersion:current.version,state:next,events:[{type:'rag.claim.reconciled',data:{kind:options.kind}}]});cancelled(options.signal);
}
