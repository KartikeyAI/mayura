import {pineconeVectorStore} from '../src/index.js';
import {vectorConformance} from '../../../packages/rag/test/conformance.js';
import {fakeVectorFetch} from '../../../packages/rag/test/fake-services.js';
vectorConformance('pinecone',async()=>({store:pineconeVectorStore({endpoint:'https://vectors.test',collection:'Chunks',dimensions:2,costMicros:0,permissions:{allow:['rag:transport:pinecone']},timeoutMs:1000,maxConcurrent:2,fetch:fakeVectorFetch('pinecone')}),close:async()=>undefined}));
