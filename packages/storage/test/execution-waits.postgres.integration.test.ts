import { describe } from 'vitest';
import { executionWaitConformance } from './execution-waits-conformance.js';
import { executionWaitPostgresFixture } from './execution-waits-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL execution waits fixture', () => {
  executionWaitConformance('PostgreSQL', () => executionWaitPostgresFixture(connectionString!));
});
