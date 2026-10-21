import {describe,expect,it,vi} from 'vitest';
import {cohereReranker} from '../src/index.js';
const signal=()=>new AbortController().signal;
const config={apiKey:'fake-offline-key',model:'fixture-model',costMicros:7,permissions:{allow:['rag:transport:cohere']},timeoutMs:100,maxConcurrent:1};
describe('cohere indexed reranking',()=>{
  it('preserves provider ordering through original-document indexes',async()=>{const fetch=vi.fn(async()=>new Response(JSON.stringify({results:[{index:1,relevance_score:0.9},{index:0,relevance_score:0.2}]})));const ranker=cohereReranker({...config,fetch});expect(await ranker.rank('query',['first','second'],signal())).toEqual([{index:1,score:0.9},{index:0,score:0.2}]);expect(fetch).toHaveBeenCalledTimes(1);});
  it('denies missing permission before transport and rejects cancellation/failure/forged indexes',async()=>{const fetch=vi.fn(async()=>new Response(JSON.stringify({results:[{index:9,relevance_score:1}]})));const denied=cohereReranker({...config,permissions:{allow:[]},fetch});await expect(denied.rank('q',['one'],signal())).rejects.toBeDefined();expect(fetch).not.toHaveBeenCalled();const ranker=cohereReranker({...config,fetch});await expect(ranker.rank('q',['one'],signal())).rejects.toBeDefined();const abort=new AbortController();abort.abort();await expect(ranker.rank('q',['one'],abort.signal)).rejects.toBeDefined();const failed=cohereReranker({...config,fetch:async()=>{throw new Error('SECRET');}});await expect(failed.rank('q',['one'],signal())).rejects.not.toThrow('SECRET');});
});
