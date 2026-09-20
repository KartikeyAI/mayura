import { describe } from 'vitest';
import { scheduledWorkflowConformance } from './scheduled-conformance.js';
import { scheduledPostgresFixture } from './scheduled-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL scheduled workflow integration', () => {
  scheduledWorkflowConformance('PostgreSQL', () => scheduledPostgresFixture(connectionString!));
});
