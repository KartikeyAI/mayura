import { createSqliteStore } from '@mayura/storage';
import { treeMigrationConformance } from './migration-tree-conformance.js';

treeMigrationConformance('SQLite', async () => createSqliteStore({ filename: ':memory:' }));
