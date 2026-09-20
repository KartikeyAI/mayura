import { createSqliteStore } from '@mayura/storage-sqlite';
import { scheduledBounds } from './scheduled-bounds-conformance.js';

scheduledBounds('SQLite',async () => ({store:createSqliteStore({filename:':memory:'}),cleanup:async () => {}}));
