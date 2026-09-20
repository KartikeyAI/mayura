import { describe } from 'vitest';
import { graphWorkflowConformance } from './graph-conformance.js';
import { graphPostgresFixture } from './graph-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL durable workflow graph integration', () => {
  graphWorkflowConformance('PostgreSQL', () => graphPostgresFixture(connectionString!));
});
