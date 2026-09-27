import { lifecycleMigrationConformance } from './migration-lifecycle-conformance.js';
import { sqliteFixture } from './fixtures.js';

lifecycleMigrationConformance('SQLite', sqliteFixture);
