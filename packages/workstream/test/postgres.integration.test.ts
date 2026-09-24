import { describe } from 'vitest';
import { workstreamConformance } from './conformance.js';
import { humanWorkStreamConformance } from './human-conformance.js';
import { timerWorkStreamConformance } from './timer-conformance.js';
import { webhookConformance } from './webhook-conformance.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL WorkStream integration', () => {
  workstreamConformance('PostgreSQL', () => postgresFixture(connectionString!));
  humanWorkStreamConformance('PostgreSQL', () => postgresFixture(connectionString!));
  timerWorkStreamConformance('PostgreSQL', () => postgresFixture(connectionString!));
  webhookConformance('PostgreSQL', () => postgresFixture(connectionString!));
});
