import { describe } from 'vitest';
import { memoryConformance } from './conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL memory integration', () => {
  memoryConformance('PostgreSQL', () => postgresFixture(connectionString!));
});
