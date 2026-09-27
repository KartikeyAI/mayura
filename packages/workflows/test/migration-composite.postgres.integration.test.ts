import { describe } from 'vitest';
import { compositeMigrationConformance } from './migration-composite-conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
if (connectionString) compositeMigrationConformance('PostgreSQL', () => postgresFixture(connectionString));
else describe.skip('aggregate, saga and loop in-place migration on PostgreSQL', () => {});
