import {chromaVectorStore} from '../src/index.js';
import {vectorConformance} from '../../../packages/rag/test/conformance.js';
import {fakeVectorFetch} from '../../../packages/rag/test/fake-services.js';
vectorConformance('chroma',async()=>({store:chromaVectorStore({endpoint:'https://vectors.test',collection:'Chunks',dimensions:2,costMicros:0,permissions:{allow:['rag:transport:chroma']},timeoutMs:1000,maxConcurrent:2,fetch:fakeVectorFetch('chroma'),tenant:'test',database:'test'}),close:async()=>undefined}));
