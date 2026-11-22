import {describe,it,expect} from 'vitest';
import {inMemoryVectorStore,loadText,chunkDocument} from '../src/index.js';
const scope={principalId:'reader',projectId:'project'};const signal=new AbortController().signal;
const entry=(id:string,text:string,metadata:Record<string,string>={})=>({chunk:chunkDocument(loadText(text,{id,reference:id,sensitivity:'public',metadata}),'a'.repeat(64),{maxChars:512,overlapChars:0,maxChunks:1,mode:'fixed'})[0]!,values:[1,0]});
describe('optional scope-local BM25 reference scoring',()=>{
  it('uses inverse document frequency and length normalization while preserving the default scorer',async()=>{
    const rare=entry('rare','BRCA1 padding padding padding padding');const common=entry('common','common common');const filler=entry('filler','common common');
    const a=inMemoryVectorStore({dimensions:2,maxVectors:8,lexicalScoring:'bm25'});const b=inMemoryVectorStore({dimensions:2,maxVectors:8});
    await a.upsert(scope,'space',[rare,common,filler],signal);await b.upsert(scope,'space',[rare,common,filler],signal);
    const q={scope,space:'space',text:'BRCA1 common',limit:3,filter:{},signal};
    expect((await a.lexical!(q))[0]!.chunk.documentId).toBe('rare');expect((await b.lexical!(q))[0]!.chunk.documentId).not.toBe('rare');
  });
  it('updates and deletes postings atomically with rows and isolates scope/space statistics',async()=>{
    const store=inMemoryVectorStore({dimensions:2,maxVectors:8,lexicalScoring:'bm25'});const a=entry('a','BRCA1 response',{kind:'yes'});const b=entry('b','BRCA1 response',{kind:'no'});
    await store.upsert(scope,'space',[a,b],signal);const q={scope,space:'space',text:'BRCA1',limit:8,filter:{kind:'yes'},signal};
    const first=await store.lexical!(q);expect(first.map(h=>h.chunk.documentId)).toEqual(['a']);
    await store.upsert({...scope,principalId:'other'},'space',[entry('foreign','BRCA1 BRCA1 BRCA1')],signal);
    await store.upsert(scope,'other-space',[entry('foreign','BRCA1 BRCA1')],signal);
    expect(await store.lexical!(q)).toEqual(first);
    await store.upsert(scope,'space',[{...a,chunk:{...a.chunk,text:'OTHER response'}}],signal);expect(await store.lexical!(q)).toEqual([]);
    await store.delete(scope,'space',[a.chunk.id,b.chunk.id],signal);expect(await store.lexical!({...q,filter:{}})).toEqual([]);
    const cancelled=new AbortController();cancelled.abort();await expect(store.lexical!({...q,signal:cancelled.signal})).rejects.toMatchObject({code:'CANCELLED'});
    expect(()=>inMemoryVectorStore({dimensions:2,maxVectors:8,lexicalScoring:'unknown' as never})).toThrow();
  });
});
