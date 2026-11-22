import {describe,it,expect} from 'vitest';
import {inMemoryVectorStore,loadText,chunkDocument} from '../src/index.js';
const scope={principalId:'reader',projectId:'project'};const signal=new AbortController().signal;
const chunks=(id:string,text:string,overlapChars=0)=>chunkDocument(loadText(text,{id,reference:id,sensitivity:'public'}),'a'.repeat(64),{maxChars:64,overlapChars,maxChunks:128,mode:'fixed'});
const rows=(cs:ReturnType<typeof chunks>)=>cs.map(chunk=>({chunk,values:[1,0]}));
const make=()=>inMemoryVectorStore({dimensions:2,maxVectors:512,lexicalScoring:'bm25',lexicalUnit:'document'});
const q={scope,space:'space',text:'BRCA1 response',limit:10,filter:{},signal};
describe('document BM25 lexical witnesses',()=>{
  it('combines separated terms while returning an unchanged real passage and counting overlaps once',async()=>{
    const text='BRCA1 '+ 'padding '.repeat(14)+'response';const a=chunks('a',text);const b=chunks('b',text,16);
    const store=make();await store.upsert(scope,'space',rows([...a,...b]),signal);
    const hits=await store.lexical!(q);expect(hits).toHaveLength(2);expect(hits[0]!.score).toBeCloseTo(hits[1]!.score,12);
    for(const h of hits){expect([...a,...b]).toContainEqual(h.chunk);expect(h.chunk.text).toBe(text.slice(h.chunk.start,h.chunk.end));}
    await store.upsert({...scope,projectId:'other'},'space',rows(chunks('foreign','BRCA1 BRCA1 response')),signal);
    expect(await store.lexical!(q)).toEqual(hits);expect(await store.lexical!({...q,filter:{absent:'yes'}})).toEqual([]);
  });
  it('rejects conflicting intervals or mixed sensitivity atomically and keeps updates/deletion coherent',async()=>{
    const a=chunks('a','BRCA1 '+ 'padding '.repeat(14)+'response',16);const store=make();await store.upsert(scope,'space',rows(a),signal);const before=await store.lexical!(q);
    const conflicting={...a[1]!,text:'x'.repeat(a[1]!.text.length)};
    await expect(store.upsert(scope,'space',rows([conflicting]),signal)).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(store.upsert(scope,'space',rows([{...a[1]!,sensitivity:'restricted'}]),signal)).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(await store.lexical!(q)).toEqual(before);
    const cancelled=new AbortController();cancelled.abort();await expect(store.delete(scope,'space',[a[0]!.id],cancelled.signal)).rejects.toMatchObject({code:'CANCELLED'});
    expect(await store.lexical!(q)).toEqual(before);
    await store.delete(scope,'space',[a[0]!.id],signal);expect((await store.lexical!({...q,text:'BRCA1'}))).toEqual([]);
    await store.delete(scope,'space',a.slice(1).map(c=>c.id),signal);expect(await store.lexical!(q)).toEqual([]);
    await store.upsert(scope,'space',rows(chunks('a','OTHER response')),signal);expect(await store.lexical!({...q,text:'BRCA1'})).toEqual([]);
    expect(()=>inMemoryVectorStore({dimensions:2,maxVectors:8,lexicalUnit:'document'})).toThrow();
  });
  it('bounds chunks per document across batches without partially inserting an excess chunk',async()=>{
    const store=make();const base=chunks('bounded','BRCA1')[0]!;
    const admitted=Array.from({length:128},(_,i)=>({...base,id:`bounded-${i}`}));await store.upsert(scope,'space',rows(admitted),signal);
    await expect(store.upsert(scope,'space',rows([{...base,id:'excess'}]),signal)).rejects.toMatchObject({code:'BUDGET_EXCEEDED'});
    await store.delete(scope,'space',admitted.map(c=>c.id),signal);expect(await store.lexical!(q)).toEqual([]);
    expect(await store.query({...q,vector:[1,0]})).toEqual([]);
  });
});
