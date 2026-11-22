import {describe,it,expect,vi} from 'vitest';
import {loadText,chunkDocument,createRetriever} from '../src/index.js';
import type {RagReranker} from '../src/contracts.js';
import {surroundingEvidence} from '../src/evidence-window.js';

const revision='a'.repeat(64),source='Earlier context and a required rule. '.repeat(30);
const rows=chunkDocument(loadText(source,{id:'guide',reference:'guide.md',sensitivity:'internal'}),revision,
  {maxChars:64,overlapChars:16,maxChunks:128,mode:'fixed',parentChars:256}).map(chunk=>({chunk,score:1}));
const anchor=rows[5]!,neighbor=rows[4]!,scope={principalId:'reader',projectId:'docs'};
function retriever(reranker:RagReranker,options:{parentDocuments?:boolean;removeBeforeRerank?:boolean;allow?:string[];controller?:AbortController}={}){
  let reads=0;
  return createRetriever({scope,permissions:{allow:options.allow??['rag:read','rag:rerank:local']},allowedSensitivities:['internal'],space:'test',
    embedder:{id:'local',location:'local',dimensions:2,maxBatch:1,costMicros:0,embed:async()=>[[1,0]]},
    store:{id:'fake',location:'local',dimensions:2,costMicros:0,query:async()=>[anchor,neighbor],upsert:async()=>{},delete:async()=>{}},
    catalog:{read:async()=>{reads++;if(reads===2)options.controller?.abort();return{revision,space:'test',contentHash:revision,deleted:false,
      chunkIds:options.removeBeforeRerank&&reads>1?[anchor.chunk.id]:[anchor.chunk.id,neighbor.chunk.id]};},publish:async()=>{}},
    limit:1,candidateLimit:2,maxQueries:1,maxCostMicros:0,maxConcurrent:1,timeoutMs:1000,
    ...(options.parentDocuments === undefined ? {} : {parentDocuments: options.parentDocuments}),reranker});
}
const ranker=(rank:RagReranker['rank']):RagReranker=>({id:'local',location:'local',costMicros:0,rank});

describe('parent-aware reranker boundary',()=>{
  it('shows the same bounded authorized surrounding context that can be released',async()=>{
    const rank=vi.fn<RagReranker['rank']>(async()=>[{index:0,score:1}]);
    const result=await retriever(ranker(rank),{parentDocuments:true}).retrieve('rule');
    const expected=surroundingEvidence(anchor,[anchor,neighbor])!.parent;
    expect(rank.mock.calls[0]![1][0]).toBe(expected.text);
    expect(result.hits[0]!.parent).toEqual(expected);
    expect(expected.text.length).toBeLessThanOrEqual(256);
    expect(expected.start).toBeLessThan(anchor.chunk.start);
  });
  it('preserves child-only inputs when parent context is not opted in',async()=>{
    const rank=vi.fn<RagReranker['rank']>(async()=>[{index:0,score:1}]);
    await retriever(ranker(rank)).retrieve('rule');
    expect(rank.mock.calls[0]![1][0]).toBe(anchor.chunk.text);
  });
  it('does not expose unpublished contributing context to the reranker',async()=>{
    const rank=vi.fn<RagReranker['rank']>(async()=>[{index:0,score:1}]);
    const result=await retriever(ranker(rank),{parentDocuments:true,removeBeforeRerank:true}).retrieve('rule');
    expect(rank).not.toHaveBeenCalled();expect(result.hits).toEqual([]);
  });
  it('denied permission and cancellation before context release cannot reach the callback',async()=>{
    const rank=vi.fn<RagReranker['rank']>(async()=>[{index:0,score:1}]);
    await expect(retriever(ranker(rank),{parentDocuments:true,allow:['rag:read']}).retrieve('rule')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    const controller=new AbortController();
    await expect(retriever(ranker(rank),{parentDocuments:true,controller}).retrieve('rule',{signal:controller.signal})).rejects.toMatchObject({code:'CANCELLED'});
    expect(rank).not.toHaveBeenCalled();
  });
  it('callback failure releases no partial evidence',async()=>{
    await expect(retriever(ranker(async()=>{throw Error('unavailable');}),{parentDocuments:true}).retrieve('rule')).rejects.toMatchObject({code:'MODEL_FAILED'});
  });
});
