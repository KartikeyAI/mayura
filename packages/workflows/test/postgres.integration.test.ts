import { describe } from 'vitest';
import { workflowConformance } from './conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL workflow integration', () => {
  workflowConformance('PostgreSQL', () => postgresFixture(connectionString!));
});
