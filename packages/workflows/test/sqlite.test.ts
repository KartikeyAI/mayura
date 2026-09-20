import { graphValidation, workflowConformance } from './conformance.js';
import { sqliteFixture } from './fixtures.js';

graphValidation();
workflowConformance('SQLite', sqliteFixture);
