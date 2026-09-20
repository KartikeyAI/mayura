import { describe } from 'vitest';
import { executionWaitPostgresFixture } from './execution-waits-fixtures.js';
import { selectedAdapterCompatibility } from './selected-adapters-conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL selected adapter compatibility fixture', () => {
  selectedAdapterCompatibility('PostgreSQL', () => executionWaitPostgresFixture(connectionString!));
});
