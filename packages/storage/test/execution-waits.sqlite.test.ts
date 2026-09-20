import { executionWaitConformance } from './execution-waits-conformance.js';
import { executionWaitSqliteFixture } from './execution-waits-fixtures.js';

executionWaitConformance('SQLite', executionWaitSqliteFixture);
