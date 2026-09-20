import { createSqliteStore } from '../dist/index.js';
import { scheduledBounds } from './scheduled-bounds-conformance.js';

scheduledBounds('SQLite',async () => ({store:createSqliteStore({filename:':memory:'}),cleanup:async () => {}}));
