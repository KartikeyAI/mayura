import { describe } from 'vitest';
import { nativeMemoryConformance } from './native-conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
if (connectionString) nativeMemoryConformance('PostgreSQL', () => postgresFixture(connectionString));
else describe.skip('native memory on PostgreSQL', () => {});
