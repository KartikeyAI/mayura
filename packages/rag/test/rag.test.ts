import {afterEach,describe,expect,it,vi} from 'vitest';
import {Budget,createAuthorizer,type Authorizer} from '@mayura/core';
import {sha256Hex} from '@mayura/core/host';
import {hashingEmbedder} from '@mayura/memory';
import {createSqliteStore} from '@mayura/storage-sqlite';
import {createWorkflowRuntime} from '@mayura/workflows';
import {invokeTool} from '@mayura/tools';
import {aggregateRagCatalog,chunkDocument,citationCoverage,createRetriever,defineRagIngestion,defineRetrievalTool,deleteRagDocument,inMemoryVectorStore,loadJson,loadMarkdown,loadText,ragEmbedder,ragIndexSpace,reconcileRagClaim,retrievalQuality,type RagAccess,type RetrieverOptions} from '../src/index.js';
const scope={principalId:'alice',projectId:'docs'};const signal=()=>new AbortController().signal;
const resources:{close():unknown}[]=[];afterEach(async()=>{for(const resource of resources.splice(0))await resource.close();vi.useRealTimers();});
const chunking={maxChars:64,overlapChars:0,maxChunks:8,mode:'fixed' as const};
async function fixture(authorization?:Authorizer) {
  const journal=createSqliteStore({filename:':memory:'});await journal.initialize();resources.push(journal);
  const inner=hashingEmbedder({dimensions:8});const embed=vi.fn(inner.embed.bind(inner));const embedder=ragEmbedder({...inner,embed},{costMicros:0});
  const store=inMemoryVectorStore({dimensions:8,maxVectors:1000});const catalog=aggregateRagCatalog(journal);
  const access:RagAccess={scope,permissions:{allow:['rag:index','rag:read','rag:reconcile']},allowedSensitivities:['internal'],...(authorization?{authorization}:{})};
  const definition=defineRagIngestion({...access,id:'rag.ingest',version:'1',store,catalog,journal,embedder,chunking,maxCostMicros:0,timeoutMs:1000});
  const runtime=createWorkflowRuntime({store:journal,scope,permissions:{allow:['rag:index','effect:write','tool:rag.ingest.stage','tool:rag.ingest.publish']},policyVersion:'1',maxCostMicros:0});resources.push(runtime);
  const ingest=async(text:string,key:string,expectedRevision:string|null=null)=>{
    const submission=await runtime.submit(definition,{input:{document:loadText(text,{id:'guide',reference:'guide.md',sensitivity:'internal'}),expectedRevision},idempotencyKey:key});
    return await runtime.runUntilSettled(definition,submission.id);
  };
  const retrieve=(overrides:Partial<RetrieverOptions>={})=>createRetriever({...access,store,catalog,embedder,space:ragIndexSpace(embedder,chunking),limit:5,candidateLimit:20,maxQueries:1,maxCostMicros:0,timeoutMs:1000,maxConcurrent:2,...overrides});
  return {journal,catalog,store,embedder,embed,definition,runtime,ingest,retrieve,access};
}
describe('durable RAG ingestion and retrieval',()=>{
  it('publishes after staging, reuses confirmed chunk embeddings across changed documents and no-op runs',async()=>{
    const f=await fixture();const original='apples '.repeat(9)+'!';expect(original.length).toBe(64);
    const first=await f.ingest(original+'pears','first');expect(first.status).toBe('succeeded');expect(f.embed).toHaveBeenCalledTimes(1);
    const active=await f.catalog.read(scope,'guide',signal());expect(active).toBeDefined();
    const second=await f.ingest(original+'oranges','second',active!.revision);expect(second.status).toBe('succeeded');
    expect(f.embed).toHaveBeenCalledTimes(2);expect(f.embed.mock.calls[1]?.[0]).toEqual(['oranges']);
    const latest=await f.catalog.read(scope,'guide',signal());expect((await f.ingest(original+'oranges','third',latest!.revision)).status).toBe('succeeded');expect(f.embed).toHaveBeenCalledTimes(2);
    const result=await f.retrieve().retrieve('apples');expect(result.hits.length).toBeGreaterThan(0);expect(result.hits.every(hit=>hit.chunk.revision===latest!.revision)).toBe(true);
  });
  it('keeps failed/uncertain stages invisible and does not replay paid work under another submission key',async()=>{
    const f=await fixture();f.embed.mockRejectedValueOnce(new Error('private provider exception'));
    expect((await f.ingest('apples guide','failure')).status).not.toBe('succeeded');
    expect(await f.catalog.read(scope,'guide',signal())).toBeUndefined();
    expect((await f.ingest('apples guide','retry')).status).not.toBe('succeeded');expect(f.embed).toHaveBeenCalledTimes(1);
    expect((await f.retrieve().retrieve('apples')).hits).toEqual([]);
  });
  it('requires external proof for claim recovery and never re-embeds while verifying',async()=>{
    const f=await fixture();f.embed.mockRejectedValueOnce(new Error('uncertain'));await f.ingest('apples guide','uncertain');
    const verify=vi.fn(async()=>undefined);const space=ragIndexSpace(f.embedder,chunking);const claimId=sha256Hex(JSON.stringify(['apples guide','internal']));
    await expect(reconcileRagClaim({...f.access,journal:f.journal,space,claimId,kind:'embedding',documentId:'guide',dimensions:8,signal:signal(),verify})).rejects.toMatchObject({code:'CONFLICT'});
    expect(verify).toHaveBeenCalledTimes(1);expect(f.embed).toHaveBeenCalledTimes(1);
    await expect(reconcileRagClaim({...f.access,permissions:{allow:[]},journal:f.journal,space,claimId,kind:'embedding',documentId:'guide',dimensions:8,signal:signal(),verify})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it('refuses stale revisions and revokes deleted evidence before physical cleanup',async()=>{
    const f=await fixture();await f.ingest('apples guide','first');const active=await f.catalog.read(scope,'guide',signal());
    expect((await f.ingest('new guide','stale')).status).not.toBe('succeeded');expect(f.embed).toHaveBeenCalledTimes(1);
    await deleteRagDocument({...f.access,catalog:f.catalog,documentId:'guide',expectedRevision:active!.revision,signal:signal()});
    expect((await f.retrieve().retrieve('apples')).hits).toEqual([]);
  });
  it('enforces static admission and per-document authorization before disclosing to rerankers',async()=>{
    let denied=false;const authorization=createAuthorizer({permissions:{allow:['authz:evaluate']},policy:{version:'1',authorize(request){return denied&&request.resource.id==='guide'&&request.action==='read'?{effect:'deny',reason:'explicit_deny',policyVersion:'1',ruleId:null}:{effect:'allow',reason:'allowed',policyVersion:'1',ruleId:null};}}});resources.push(authorization);
    const f=await fixture(authorization);await f.ingest('private apples','first');denied=true;
    const rank=vi.fn(async()=>[]);const result=await f.retrieve({permissions:{allow:['rag:read','rag:rerank:test']},reranker:{id:'test',location:'local',costMicros:0,rank}}).retrieve('apples');
    expect(result.hits).toEqual([]);expect(result.metrics.candidates).toBe(0);expect(rank).not.toHaveBeenCalled();
    await expect(f.retrieve({permissions:{allow:[]}}).retrieve('apples')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('blocks cross-scope retrieval tools and exposes exact citations through the permitted tool path',async()=>{
    const f=await fixture();await f.ingest('apples source','first');const tool=defineRetrievalTool({id:'docs.search',version:'1',retriever:f.retrieve(),timeoutMs:1000});
    const context={runId:'run',callId:'call',scope,permissions:{allow:['tool:docs.search','effect:read','rag:read']},budget:new Budget(0,5),signal:signal()};
    const result=await invokeTool(tool,{query:'apples'},context);expect(result.status).toBe('succeeded');if(result.status==='succeeded')expect(JSON.stringify(result.output)).toContain('guide.md');
    const refused=await invokeTool(tool,{query:'apples'},{...context,callId:'other',scope:{...scope,principalId:'bob'}});expect(refused.status).not.toBe('succeeded');
  });
  it('admits hybrid search, returns validated parents, and never treats a HyDE answer as evidence',async()=>{
    const f=await fixture();const text='apple guide '.repeat(12);const parentChunks=chunkDocument(loadText(text,{id:'parent',reference:'parent.md',sensitivity:'internal'}),'c'.repeat(64),{...chunking,parentChars:128});
    expect(parentChunks[0]?.parent?.text).toContain(parentChunks[0]!.text);
    await f.ingest('apple guide','first');const transform={id:'hyde',mode:'hyde' as const,costMicros:0,transform:vi.fn(async()=>['hypothetical apple answer'])};
    const result=await f.retrieve({mode:'hybrid',transform,permissions:{allow:['rag:read','rag:transform:hyde']}}).retrieve('apple');
    expect(result.hits.every(hit=>hit.chunk.text==='apple guide')).toBe(true);expect(transform.transform).toHaveBeenCalledTimes(1);
  });
  it('retains a timed-out admission until an abort-ignoring embedder settles',async()=>{
    const f=await fixture();let release:((values:readonly(readonly number[])[])=>void)|undefined;
    const embedder={...f.embedder,embed:vi.fn(()=>new Promise<readonly(readonly number[])[]>(resolve=>{release=resolve;}))};
    const retriever=f.retrieve({embedder,maxConcurrent:1,timeoutMs:5});await expect(retriever.retrieve('apples')).rejects.toBeDefined();
    await expect(retriever.retrieve('apples')).rejects.toMatchObject({code:'BUDGET_EXCEEDED'});release!([[1,0,0,0,0,0,0,0]]);await Promise.resolve();
  });
});
describe('loaders, chunking and evaluation',()=>{
  it('normalizes source text, preserves exact offsets and rejects chunk truncation',()=>{
    const doc=loadMarkdown('heading\r\n'+'apple '.repeat(40),{id:'guide',reference:'guide.md',sensitivity:'internal'});
    const chunks=chunkDocument(doc,'a'.repeat(64),{maxChars:64,overlapChars:8,maxChunks:20,mode:'markdown'});
    for(const chunk of chunks)expect(chunk.text).toBe(doc.text.slice(chunk.start,chunk.end));
    expect(()=>chunkDocument(doc,'a'.repeat(64),{maxChars:64,overlapChars:8,maxChunks:1})).toThrow();
    expect(loadJson('{"title":"Allowed","secret":"HIDDEN"}',['/title'],{id:'json',reference:'data.json',sensitivity:'internal'}).text).toBe('Allowed');
  });
  it('computes bounded ranking and citation membership metrics',()=>{
    expect(retrievalQuality(['wrong','good'],['good'],2)).toMatchObject({precisionAtK:0.5,recallAtK:1,reciprocalRank:0.5});
    expect(citationCoverage(['chunk'],['chunk'])).toMatchObject({complete:true,coverage:1});expect(citationCoverage(['chunk'],['forged'])).toMatchObject({complete:false,unknownCitations:1});
  });
});
