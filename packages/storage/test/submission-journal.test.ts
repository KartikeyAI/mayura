import { describe, expect, it } from 'vitest';
import { createAggregateSubmissionJournal } from '@mayura/storage';
import { durableBudgetPostgresFixture, durableBudgetSqliteFixture, type DurableBudgetFixture } from './durable-budget-fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const digest = (letter: string) => letter.repeat(64);

for (const [name, factory, enabled] of [['SQLite', durableBudgetSqliteFixture, true],
  ['PostgreSQL', () => durableBudgetPostgresFixture(connectionString!), connectionString !== undefined]] as const) {
  (enabled ? describe : describe.skip)(`${name} durable submission journal`, () => {
    it('claims a key exactly once, survives reopen and isolates owners', async () => {
      const fixture: DurableBudgetFixture = await factory(); const stores = [fixture.store];
      try {
        await fixture.store.initialize(); let journal = createAggregateSubmissionJournal(fixture.store);
        const owner = JSON.stringify({ principalId: 'user', projectId: 'project' });
        const results = await Promise.all(Array.from({ length: 8 }, () => journal.claim({ owner, key: 'request.1', digest: digest('a') })));
        expect(results.filter(result => result.status === 'claimed')).toHaveLength(1);
        expect(results.filter(result => result.status === 'existing')).toHaveLength(7);
        await fixture.store.close(); const reopened = fixture.reopen(); stores.push(reopened); await reopened.initialize();
        journal = createAggregateSubmissionJournal(reopened);
        expect(await journal.claim({ owner, key: 'request.1', digest: digest('b') })).toEqual({ status: 'existing', digest: digest('a') });
        expect(await journal.claim({ owner: JSON.stringify({ principalId: 'other', projectId: 'project' }), key: 'request.1', digest: digest('b') }))
          .toEqual({ status: 'claimed' });
        await expect(journal.claim({ owner, key: 'bad key', digest: digest('a') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
    });
  });
}
