import {describe,it,expect,vi} from 'vitest';
import {createAuthorizer} from '@mayura/core';
import {createRetriever,loadText,chunkDocument} from '../src/index.js';
import type {RagHit,RagCatalog,VectorStore,RagEmbedder,RagReranker} from '../src/index.js';
const revision='a'.repeat(64);const scope={principalId:'reader',projectId:'project'};
function hit(documentId:string,body:string,offset=0):RagHit {
  const [chunk]=chunkDocument(loadText(body,{id:documentId,reference:documentId,sensitivity:'public'}),revision,{maxChars:64,overlapChars:0,maxChunks:8,mode:'fixed'});
  return {chunk:{...chunk!,id:`${documentId}-${offset}`},score:1};
}
function setup() {
  const rows=[hit('a','first source',0),hit('a','another passage',1),hit('b','second source',0),hit('denied','secret source',0),hit('stale','old source',0)];
  const embed=vi.fn(async()=>[[1,0]]);
  const embedder:RagEmbedder={id:'test',dimensions:2,maxBatch:1,costMicros:0,location:'local',embed};
  const store:VectorStore={id:'test',dimensions:2,location:'local',costMicros:0,upsert:async()=>{},delete:async()=>{},query:async()=>rows};
  const catalog:RagCatalog={publish:async()=>{},read:async(_scope,id)=>({revision:id==='stale'?'b'.repeat(64):revision,space:'space',chunkIds:rows.filter(r=>r.chunk.documentId===id).map(r=>r.chunk.id),contentHash:'0'.repeat(64),deleted:false})};
  const authorization=createAuthorizer({permissions:{allow:['authz:evaluate']},policy:{version:'1',authorize:request=>request.resource.id==='denied'
    ?{effect:'deny',reason:'explicit_deny',policyVersion:'1',ruleId:null}:{effect:'allow',reason:'allowed',policyVersion:'1',ruleId:null}}});
  const base={scope,permissions:{allow:['rag:read','rag:rerank:test.local']},allowedSensitivities:['public'] as const,authorization,
    store,catalog,embedder,space:'space',limit:2,candidateLimit:10,maxQueries:1,maxCostMicros:0,timeoutMs:1000,maxConcurrent:1};
  return {base,rows,embed,authorization};
}
describe('authorized document diversity',()=>{
  it('allows bounded rank smoothing without changing default fusion or candidate/result limits',async()=>{
    const f=setup();try{
      const a=hit('a','dense leader'),c=hit('c','lexical leader'),b=hit('b','tail agreement');
      const dense=[a,hit('d','dense second'),hit('e','dense third'),b];const lexical=[c,hit('f','lexical second'),hit('g','lexical third'),b];const rows=[...dense,...lexical];
      const catalog={...f.base.catalog,read:async(_s:unknown,id:string)=>({revision,space:'space',chunkIds:rows.filter(h=>h.chunk.documentId===id).map(h=>h.chunk.id),contentHash:'0'.repeat(64),deleted:false})};
      const options={...f.base,catalog,store:{...f.base.store,query:async()=>dense,lexical:async()=>lexical},distinctDocuments:true,fusionLevel:'document' as const,mode:'hybrid' as const,limit:1};
      expect((await createRetriever(options).retrieve('query')).hits[0]!.chunk.documentId).toBe('b');
      expect((await createRetriever({...options,fusionRankConstant:1}).retrieve('query')).hits[0]!.chunk.documentId).not.toBe('b');
      for(const value of [0,101,NaN,1.5])expect(()=>createRetriever({...options,fusionRankConstant:value})).toThrow();
    }finally{f.authorization.close();}
  });
  it('fuses agreement on different passages of one document without repeated document votes',async()=>{
    const f=setup();try{
      const a=hit('a','dense first');const b1=hit('b','dense supporting passage',0);const b2=hit('b','lexical supporting passage',1);const c=hit('c','lexical first');
      const rows=[a,b1,b2,c];const store={...f.base.store,query:async()=>[a,b1],lexical:async()=>[c,b2]};
      const catalog={...f.base.catalog,read:async(_s:unknown,id:string)=>({revision,space:'space',chunkIds:rows.filter(r=>r.chunk.documentId===id).map(r=>r.chunk.id),contentHash:'0'.repeat(64),deleted:false})};
      const base={...f.base,store,catalog,mode:'hybrid' as const,distinctDocuments:true,limit:1};
      expect((await createRetriever(base).retrieve('query')).hits[0]!.chunk.documentId).not.toBe('b');
      const result=await createRetriever({...base,fusionLevel:'document'}).retrieve('query');expect(result.hits[0]!.chunk.documentId).toBe('b');
      // Duplicating source passages does not create extra document votes.
      const repeat={...store,query:async()=>[a,hit('a','extra first source',1),b1]};
      const repeatRows=[...rows,hit('a','extra first source',1)];
      const repeatCatalog={...catalog,read:async(_s:unknown,id:string)=>({revision,space:'space',chunkIds:repeatRows.filter(r=>r.chunk.documentId===id).map(r=>r.chunk.id),contentHash:'0'.repeat(64),deleted:false})};
      expect((await createRetriever({...base,store:repeat,catalog:repeatCatalog,fusionLevel:'document'}).retrieve('query')).hits[0]!.score).toBe(result.hits[0]!.score);
    }finally{f.authorization.close();}
  });
  it('document fusion reranks only real authorized witnesses and still fences deletion',async()=>{
    const f=setup();let deleted=false;try{
      const rank=vi.fn(async(_query:string,documents:readonly string[])=>{expect(documents).toEqual(['first source','second source']);deleted=true;return [{index:0,score:2},{index:1,score:1}];});
      const catalog={...f.base.catalog,read:async(...args:Parameters<RagCatalog['read']>)=>{const r=await f.base.catalog.read(...args);return r&&deleted&&args[1]==='a'?{...r,deleted:true}:r;}};
      const result=await createRetriever({...f.base,catalog,distinctDocuments:true,fusionLevel:'document',reranker:{id:'test.local',location:'local',costMicros:0,rank}}).retrieve('query');
      expect(result.hits.map(h=>h.chunk.documentId)).toEqual(['b']);expect(result.hits[0]!.chunk.text).toBe('second source');
      expect(()=>createRetriever({...f.base,fusionLevel:'document'})).toThrow();expect(()=>createRetriever({...f.base,fusionLevel:'wrong' as never})).toThrow();
    }finally{f.authorization.close();}
  });
  it('bounds catalog round trips by candidate documents and still rechecks every released document',async()=>{
    const f=setup();try{
      const read=vi.fn(f.base.catalog.read);const catalog={...f.base.catalog,read};
      const result=await createRetriever({...f.base,catalog,distinctDocuments:true}).retrieve('query');
      expect(result.hits.map(h=>h.chunk.documentId)).toEqual(['a','b']);
      expect(read.mock.calls.filter(call=>call[1]==='a')).toHaveLength(2);
      expect(read.mock.calls.filter(call=>call[1]==='b')).toHaveLength(2);
      expect(read.mock.calls.filter(call=>call[1]==='denied')).toHaveLength(1);
      expect(read.mock.calls.filter(call=>call[1]==='stale')).toHaveLength(1);
    }finally{f.authorization.close();}
  });
  it('does not release a document deleted during ranking',async()=>{
    const f=setup();let deleted=false;try{
      const catalog={...f.base.catalog,read:async(...args:Parameters<RagCatalog['read']>)=>{
        const current=await f.base.catalog.read(...args);return current&&deleted&&args[1]==='a'?{...current,deleted:true}:current;
      }};
      const reranker:RagReranker={id:'test.local',location:'local',costMicros:0,async rank(){deleted=true;return [{index:0,score:2},{index:2,score:1}];}};
      const first=await createRetriever({...f.base,catalog,distinctDocuments:true,reranker}).retrieve('query');
      expect(first.hits.map(h=>h.chunk.documentId)).toEqual(['b']);
      expect((await createRetriever({...f.base,catalog,distinctDocuments:true}).retrieve('query')).hits.every(h=>h.chunk.documentId!=='a')).toBe(true);
    }finally{f.authorization.close();}
  });
  it('reads a new candidate snapshot on every call to the same retriever',async()=>{
    const f=setup();let deleted=false;try{
      const catalog={...f.base.catalog,read:async(...args:Parameters<RagCatalog['read']>)=>{
        const current=await f.base.catalog.read(...args);return current&&deleted&&args[1]==='a'?{...current,deleted:true}:current;
      }};
      const retriever=createRetriever({...f.base,catalog,distinctDocuments:true});
      expect((await retriever.retrieve('query')).hits.map(h=>h.chunk.documentId)).toEqual(['a','b']);deleted=true;
      expect((await retriever.retrieve('query')).hits.map(h=>h.chunk.documentId)).toEqual(['b']);
    }finally{f.authorization.close();}
  });
  it('deduplicates before the limit while preserving default chunk ordering',async()=>{
    const f=setup();try{
      expect((await createRetriever(f.base).retrieve('query')).hits.map(h=>h.chunk.documentId)).toEqual(['a','a']);
      expect((await createRetriever({...f.base,distinctDocuments:true}).retrieve('query')).hits.map(h=>h.chunk.documentId)).toEqual(['a','b']);
    }finally{f.authorization.close();}
  });
  it('reranks only published authorized chunks and releases unmodified distinct evidence',async()=>{
    const f=setup();try{
      const rank=vi.fn(async(_query:string,_documents:readonly string[],_signal:AbortSignal)=>[{index:2,score:2},{index:1,score:1},{index:0,score:1}]);
      const reranker:RagReranker={id:'test.local',location:'local',costMicros:0,rank};
      const result=await createRetriever({...f.base,distinctDocuments:true,reranker}).retrieve('query');
      expect(result.hits.map(h=>h.chunk.documentId)).toEqual(['b','a']);expect(result.hits[1]!.chunk.id).toBe('a-0');
      expect(rank.mock.calls[0]![1]).toEqual(['first source','another passage','second source']);
      expect(result.hits.every(h=>f.rows.some(original=>original.chunk.id===h.chunk.id&&original.chunk.text===h.chunk.text))).toBe(true);
    }finally{f.authorization.close();}
  });
  it('refuses denied/cancelled work before callbacks and rejects invalid reranking',async()=>{
    const f=setup();try{
      const rank=vi.fn(async()=>[{index:0,score:1},{index:0,score:2}]);
      const r=createRetriever({...f.base,distinctDocuments:true,fusionLevel:'document',reranker:{id:'test.local',location:'local',costMicros:0,rank}});
      const c=new AbortController();c.abort();await expect(r.retrieve('query',{signal:c.signal})).rejects.toMatchObject({code:'CANCELLED'});
      expect(f.embed).not.toHaveBeenCalled();expect(rank).not.toHaveBeenCalled();
      await expect(createRetriever({...f.base,permissions:{allow:[]},distinctDocuments:true,fusionLevel:'document'}).retrieve('query')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
      await expect(r.retrieve('query')).rejects.toMatchObject({code:'MODEL_FAILED'});
      expect(()=>createRetriever({...f.base,distinctDocuments:'yes' as never})).toThrow();
    }finally{f.authorization.close();}
  });
});
