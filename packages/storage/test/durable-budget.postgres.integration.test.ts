import { describe } from 'vitest';
import { durableBudgetConformance } from './durable-budget-conformance.js';
import { durableBudgetPostgresFixture } from './durable-budget-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL durable-budget integration', () => {
  durableBudgetConformance('PostgreSQL', () => durableBudgetPostgresFixture(connectionString!));
});
