import { hookRelayConformance, hookRelayMappingTests } from './hook-relay-conformance.js';
import { sqliteFixture } from './fixtures.js';

hookRelayConformance('SQLite', sqliteFixture);
hookRelayMappingTests();
