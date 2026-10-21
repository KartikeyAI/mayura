import {pgvectorStore} from '../src/index.js';
import {vectorConformance} from '../../../packages/rag/test/conformance.js';
import {fakeSql} from '../../../packages/rag/test/fake-services.js';
vectorConformance('pgvector',async()=>{const store=pgvectorStore({location:'local',table:'rag_chunks',dimensions:2,costMicros:0,permissions:{allow:['rag:transport:pgvector','rag:admin']},execute:fakeSql('pgvector')});await store.initialize(new AbortController().signal);return {store,close:async()=>undefined};});
