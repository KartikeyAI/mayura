import { describe } from 'vitest';
import { graphDiscoveryConformance } from './graph-discovery-conformance.js';
import { graphPostgresFixture } from './graph-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL graph discovery integration', () => {
  graphDiscoveryConformance('PostgreSQL', () => graphPostgresFixture(connectionString!));
});
