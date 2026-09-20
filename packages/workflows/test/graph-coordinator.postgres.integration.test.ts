import { describe } from 'vitest';
import { graphCoordinatorConformance } from './graph-coordinator-conformance.js';
import { graphPostgresFixture } from './graph-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL coordinator integration', () => {
  graphCoordinatorConformance('PostgreSQL', () => graphPostgresFixture(connectionString!));
});
