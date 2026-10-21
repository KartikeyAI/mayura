import {libsqlVectorStore} from '../src/index.js';
import {vectorConformance} from '../../../packages/rag/test/conformance.js';
import {fakeSql} from '../../../packages/rag/test/fake-services.js';
vectorConformance('libsql',async()=>{const store=libsqlVectorStore({location:'local',table:'rag_chunks',dimensions:2,costMicros:0,permissions:{allow:['rag:transport:libsql','rag:admin']},execute:fakeSql('libsql')});await store.initialize(new AbortController().signal);return {store,close:async()=>undefined};});
