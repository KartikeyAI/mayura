import {qdrantVectorStore} from '../src/index.js';
import {vectorConformance} from '../../../packages/rag/test/conformance.js';
import {fakeVectorFetch} from '../../../packages/rag/test/fake-services.js';
vectorConformance('qdrant',async()=>({store:qdrantVectorStore({endpoint:'https://vectors.test',collection:'Chunks',dimensions:2,costMicros:0,permissions:{allow:['rag:transport:qdrant']},timeoutMs:1000,maxConcurrent:2,fetch:fakeVectorFetch('qdrant')}),close:async()=>undefined}));
