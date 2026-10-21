import { describe,expect,it } from 'vitest';
import type { RagChunk,VectorStore } from '../src/index.js';
export const alice={principalId:'alice',projectId:'docs'};export const bob={principalId:'bob',projectId:'docs'};export const otherProject={principalId:'alice',projectId:'other'};
export const space='index-one';export const signal=()=>new AbortController().signal;
export const sample=(id='one',topic='A'):RagChunk=>({id,documentId:'guide',revision:'a'.repeat(64),text:'hello',reference:'guide.md',metadata:{topic},sensitivity:'internal',start:0,end:5});
/** The same behavioral contract is applied to all eight adapters; all transports are offline fakes or local SQLite. */
export function vectorConformance(name:string,create:()=>Promise<{store:VectorStore;close():Promise<void>}>) {
  describe(`${name} vector contract`,()=>{
    it('isolates principal/project/index, filters before top-k, replaces IDs and deletes within scope',async()=>{
      const f=await create();try{
        await f.store.upsert(alice,space,[{chunk:sample('one'),values:[1,0]},{chunk:sample('two','B'),values:[0,1]}],signal());
        await f.store.upsert(bob,space,[{chunk:{...sample('one'),text:'other',reference:'private.md'},values:[1,0]}],signal());
        const q={scope:alice,space,vector:[1,0],filter:{},limit:10,signal:signal()};
        expect((await f.store.query(q)).map(row=>row.chunk.id)).toEqual(['one','two']);
        expect((await f.store.query({...q,filter:{topic:'B'},limit:1})).map(row=>row.chunk.id)).toEqual(['two']);
        expect(await f.store.query({...q,scope:otherProject})).toEqual([]);expect(await f.store.query({...q,space:'other-index'})).toEqual([]);
        await f.store.upsert(alice,space,[{chunk:sample('one'),values:[1,0]}],signal());expect(await f.store.query(q)).toHaveLength(2);
        await f.store.delete(alice,space,['one'],signal());expect((await f.store.query(q)).map(row=>row.chunk.id)).toEqual(['two']);
        expect((await f.store.query({...q,scope:bob}))[0]?.chunk.reference).toBe('private.md');
      }finally{await f.close();}
    });
    it('rejects invalid dimensions and pre-cancelled reads/writes/deletes',async()=>{
      const f=await create();try{
        await expect(f.store.upsert(alice,space,[{chunk:sample(),values:[1]}],signal())).rejects.toBeDefined();
        const controller=new AbortController();controller.abort();
        await expect(f.store.upsert(alice,space,[{chunk:sample(),values:[1,0]}],controller.signal)).rejects.toBeDefined();
        await expect(f.store.query({scope:alice,space,vector:[1,0],filter:{},limit:1,signal:controller.signal})).rejects.toBeDefined();
        await expect(f.store.delete(alice,space,['one'],controller.signal)).rejects.toBeDefined();
      }finally{await f.close();}
    });
  });
}
