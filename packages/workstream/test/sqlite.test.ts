import { workstreamConformance } from './conformance.js';
import { humanWorkStreamConformance } from './human-conformance.js';
import { sqliteFixture } from './fixtures.js';

workstreamConformance('SQLite', sqliteFixture);
humanWorkStreamConformance('SQLite', sqliteFixture);
