import {describe,expect,it,vi} from 'vitest';
import {titanEmbeddings} from '../src/index.js';
const config={region:'us-east-1',credentials:{accessKeyId:'FAKE_OFFLINE_KEY',secretAccessKey:'fake-offline-secret'},dimensions:256 as const,costMicros:7,permissions:{allow:['rag:transport:bedrock-embeddings']},timeoutMs:1000};
describe('Titan Text Embeddings V2',()=>{
  it('sends one signed InvokeModel request with no SDK retries',async()=>{const values=new Array<number>(256).fill(0);values[0]=1;const fetch=vi.fn(async()=>new Response(JSON.stringify({embedding:values}),{headers:{'content-type':'application/json'}}));const model=titanEmbeddings({...config,fetch});try{expect(await model.embed(['text'],new AbortController().signal)).toEqual([values]);expect(fetch).toHaveBeenCalledTimes(1);}finally{model.close();}});
  it('denies missing permission, closed adapters and pre-aborted calls without paid work',async()=>{const fetch=vi.fn(async()=>new Response('{}'));const model=titanEmbeddings({...config,permissions:{allow:[]},fetch});try{await expect(model.embed(['text'],new AbortController().signal)).rejects.toBeDefined();expect(fetch).not.toHaveBeenCalled();}finally{model.close();}const admitted=titanEmbeddings({...config,fetch});admitted.close();await expect(admitted.embed(['text'],new AbortController().signal)).rejects.toBeDefined();expect(fetch).not.toHaveBeenCalled();});
});
