import { nativeMemoryConformance } from './native-conformance.js';
import { sqliteFixture } from './fixtures.js';

nativeMemoryConformance('SQLite', sqliteFixture);
