import { compositeMigrationConformance } from './migration-composite-conformance.js';
import { sqliteFixture } from './fixtures.js';

compositeMigrationConformance('SQLite', sqliteFixture);
