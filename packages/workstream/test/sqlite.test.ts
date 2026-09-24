import { workstreamConformance } from './conformance.js';
import { humanWorkStreamConformance } from './human-conformance.js';
import { timerWorkStreamConformance } from './timer-conformance.js';
import { sqliteFixture } from './fixtures.js';

workstreamConformance('SQLite', sqliteFixture);
humanWorkStreamConformance('SQLite', sqliteFixture);
timerWorkStreamConformance('SQLite', sqliteFixture);
