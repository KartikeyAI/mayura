import { durableBudgetConformance } from './durable-budget-conformance.js';
import { durableBudgetSqliteFixture } from './durable-budget-fixtures.js';

durableBudgetConformance('SQLite', durableBudgetSqliteFixture);
