import { describe } from 'vitest';
import { scheduledMigrationConformance } from './migration-scheduled-conformance.js';
import { graphPostgresFixture } from './graph-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
if (connectionString) scheduledMigrationConformance('PostgreSQL', () => graphPostgresFixture(connectionString));
else describe.skip('scheduled and graph in-place migration on PostgreSQL', () => {});
