import { describe } from 'vitest';
import { lifecycleMigrationConformance } from './migration-lifecycle-conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
if (connectionString) lifecycleMigrationConformance('PostgreSQL', () => postgresFixture(connectionString));
else describe.skip('lifecycle in-place migration on PostgreSQL', () => {});
