import { scheduledMigrationConformance } from './migration-scheduled-conformance.js';
import { graphSqliteFixture } from './graph-fixtures.js';

scheduledMigrationConformance('SQLite', graphSqliteFixture);
