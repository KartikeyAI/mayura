import {describe,it,expect} from 'vitest';
import {inMemoryVectorStore,loadText,chunkDocument} from '../src/index.js';
const scope={principalId:'reader',projectId:'project'};const signal=new AbortController().signal;
const rows=(id:string,text:string,values:number[],kind='public')=>chunkDocument(loadText(text,{id,reference:id,sensitivity:'public',metadata:{kind}}),'a'.repeat(64),{maxChars:64,overlapChars:0,maxChunks:8,mode:'fixed'}).map(chunk=>({chunk,values}));
describe('document-diverse exact semantic candidates',()=>{
  it('optionally averages source-consistent chunk scores while preserving a real best passage witness',async()=>{
    const a=rows('a','a'.repeat(128),[1,0]);a[1]={...a[1]!,values:[-1,0]};const entries=[...a,...rows('b','second',[.6,.8])];
    const max=inMemoryVectorStore({dimensions:2,maxVectors:8,semanticUnit:'document'});const mean=inMemoryVectorStore({dimensions:2,maxVectors:8,semanticUnit:'document',documentScore:'mean'});
    for(const store of [max,mean])await store.upsert(scope,'space',entries,signal);
    const q={scope,space:'space',vector:[1,0],limit:2,filter:{},signal};
    expect((await max.query(q))[0]!.chunk.documentId).toBe('a');const result=await mean.query(q);
    expect(result.map(h=>h.chunk.documentId)).toEqual(['b','a']);expect(result[1]!.chunk).toEqual(a[0]!.chunk);expect(result[1]!.score).toBe(0);
    expect(()=>inMemoryVectorStore({dimensions:2,maxVectors:8,documentScore:'mean'})).toThrow();
    // A different revision or sensitivity cannot dilute or boost the released group's score.
    for(const changed of [{revision:'b'.repeat(64)},{sensitivity:'restricted' as const},{reference:'other'},{metadata:{kind:'other'}}]){
      const separate=inMemoryVectorStore({dimensions:2,maxVectors:8,semanticUnit:'document',documentScore:'mean'});
      await separate.upsert(scope,'space',[a[0]!,{...a[1]!,chunk:{...a[1]!.chunk,...changed}}],signal);
      expect((await separate.query(q))[0]!.score).toBe(1);
    }
  });
  it('fills a fixed limit with distinct documents and keeps actual highest-scoring witnesses',async()=>{
    const entries=[...rows('a','a '.repeat(100),[1,0]),...rows('b','second document',[0,1]),...rows('c','third document',[-1,0])];
    const chunkStore=inMemoryVectorStore({dimensions:2,maxVectors:20});const docStore=inMemoryVectorStore({dimensions:2,maxVectors:20,semanticUnit:'document'});
    for(const s of [chunkStore,docStore])await s.upsert(scope,'space',entries,signal);
    const q={scope,space:'space',vector:[1,0],limit:2,filter:{},signal};
    expect((await chunkStore.query(q)).map(h=>h.chunk.documentId)).toEqual(['a','a']);
    const result=await docStore.query(q);expect(result.map(h=>h.chunk.documentId)).toEqual(['a','b']);
    for(const h of result)expect(entries.map(e=>e.chunk)).toContainEqual(h.chunk);
    const oldWitness=result[0]!.chunk.id;await docStore.delete(scope,'space',[oldWitness],signal);
    const updated=await docStore.query(q);expect(updated[0]!.chunk.id).not.toBe(oldWitness);expect(updated[0]!.chunk.documentId).toBe('a');
  });
  it('isolates scopes, applies metadata before diversity and honors cancellation/caps',async()=>{
    const store=inMemoryVectorStore({dimensions:2,maxVectors:8,semanticUnit:'document'});
    await store.upsert(scope,'space',rows('allowed','allowed',[0,1],'yes'),signal);
    await store.upsert(scope,'space',rows('filtered','filtered',[1,0],'no'),signal);
    await store.upsert({...scope,projectId:'foreign'},'space',rows('foreign','foreign',[1,0],'yes'),signal);
    const q={scope,space:'space',vector:[1,0],limit:1,filter:{kind:'yes'},signal};
    expect((await store.query(q)).map(h=>h.chunk.documentId)).toEqual(['allowed']);
    const abort=new AbortController();abort.abort();await expect(store.query({...q,signal:abort.signal})).rejects.toMatchObject({code:'CANCELLED'});
    await expect(store.query({...q,limit:101})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(()=>inMemoryVectorStore({dimensions:2,maxVectors:8,semanticUnit:'invalid' as never})).toThrow();
  });
});
