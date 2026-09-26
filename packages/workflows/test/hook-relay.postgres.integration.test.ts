import { describe } from 'vitest';
import { hookRelayConformance } from './hook-relay-conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
if (connectionString) hookRelayConformance('PostgreSQL', () => postgresFixture(connectionString));
else describe.skip('durable workflow hook relay on PostgreSQL', () => {});
