import {describe,it,expect} from 'vitest';
import {surroundingEvidence} from '../src/evidence-window.js';
import {loadText,chunkDocument,createRetriever} from '../src/index.js';
import type {RagHit} from '../src/contracts.js';
const revision='a'.repeat(64);
const hits=(text:string):RagHit[]=>chunkDocument(loadText(text,{id:'guide',reference:'guide.md',sensitivity:'internal'}),revision,
  {maxChars:64,overlapChars:16,maxChunks:128,mode:'fixed',parentChars:256}).map(chunk=>({chunk,score:1}));
describe('authorized surrounding parent evidence',()=>{
  it('recovers context before the selected chunk within the original parent budget and exact offsets',()=>{
    const text='before rule '.repeat(30)+'the matching phrase '+'after rule '.repeat(30),rows=hits(text),anchor=rows[6]!;
    const result=surroundingEvidence(anchor,rows)!;
    expect(result.parent.start).toBeLessThan(anchor.chunk.start);expect(result.parent.text.length).toBeLessThanOrEqual(256);
    expect(result.parent.text).toBe(text.slice(result.parent.start,result.parent.end));expect(result.parent.start).toBeLessThanOrEqual(anchor.chunk.start);expect(result.parent.end).toBeGreaterThanOrEqual(anchor.chunk.end);
    expect(result.contributorIds).toContain(anchor.chunk.id);
  });
  it('does not bridge gaps or mix a different revision, sensitivity or document',()=>{
    const rows=hits('source text '.repeat(70)),anchor=rows[8]!,earlier=rows[0]!;
    const separated=surroundingEvidence(anchor,[anchor,earlier])!;expect(separated.parent.start).toBe(anchor.chunk.start);
    for(const patch of [{revision:'b'.repeat(64)},{sensitivity:'public' as const},{documentId:'other'}]){
      const changed={...rows[7]!,chunk:{...rows[7]!.chunk,...patch}};
      expect(surroundingEvidence(anchor,[anchor,changed])!.contributorIds).toEqual([anchor.chunk.id]);
    }
  });
  it('rejects conflicting overlaps instead of manufacturing a quotation',()=>{
    const rows=hits('same text '.repeat(70)),anchor=rows[5]!,other=rows[4]!;
    const corrupted={...other,chunk:{...other.chunk,parent:{...other.chunk.parent!,text:'x'.repeat(other.chunk.parent!.text.length)}}};
    expect(surroundingEvidence(anchor,[anchor,corrupted])!.contributorIds).toEqual([anchor.chunk.id]);
  });
  it('requires explicit parent context and preserves Unicode boundaries',()=>{
    const rows=hits('a🙂b '.repeat(100)),anchor=rows[5]!,result=surroundingEvidence(anchor,rows)!;
    expect(new TextDecoder().decode(new TextEncoder().encode(result.parent.text))).toBe(result.parent.text);
    expect(result.parent.text).toBe(('a🙂b '.repeat(100)).slice(result.parent.start,result.parent.end));
    const {parent,...plain}=anchor.chunk;expect(surroundingEvidence({...anchor,chunk:plain},rows)).toBeUndefined();
  });
  it('fences every contributing chunk again before releasing expanded evidence',async()=>{
    const rows=hits('source text '.repeat(70)),anchor=rows[5]!,previous=rows[4]!,scope={principalId:'reader',projectId:'docs'};
    let reads=0;
    const retriever=createRetriever({scope,permissions:{allow:['rag:read']},allowedSensitivities:['internal'],space:'test',
      embedder:{id:'local',location:'local',dimensions:2,maxBatch:1,costMicros:0,embed:async()=>[[1,0]]},
      store:{id:'fake',location:'local',dimensions:2,costMicros:0,query:async()=>[anchor,previous],upsert:async()=>{},delete:async()=>{}},
      catalog:{read:async()=>({revision,space:'test',contentHash:revision,deleted:false,chunkIds:++reads===1?[anchor.chunk.id,previous.chunk.id]:[anchor.chunk.id]}),publish:async()=>{}},
      limit:1,candidateLimit:2,maxQueries:1,maxCostMicros:0,maxConcurrent:1,timeoutMs:1000,parentDocuments:true});
    expect((await retriever.retrieve('source')).hits).toEqual([]);expect(reads).toBe(2);
  });
});
