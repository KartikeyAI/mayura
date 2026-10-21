import {createSqliteStore} from '@mayura/storage-sqlite';
import {inMemoryVectorStore,nativeMemoryVectorStore} from '../src/index.js';
import {vectorConformance} from './conformance.js';
vectorConformance('in-memory',async()=>({store:inMemoryVectorStore({dimensions:2,maxVectors:100}),close:async()=>undefined}));
vectorConformance('native-memory',async()=>{const database=createSqliteStore({filename:':memory:'});await database.initialize();await database.memory.initialize();return {store:nativeMemoryVectorStore({memory:database.memory,dimensions:2,maxScan:100,location:'local',costMicros:0}),close:()=>database.close()};});
