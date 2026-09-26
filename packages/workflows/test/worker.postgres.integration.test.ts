import { describe, expect, it } from 'vitest';
import { createWorkflowLeadership } from '../src/index.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const suite = connectionString ? describe : describe.skip;
const scope = { principalId: 'ops', projectId: 'workers' };

suite('PostgreSQL durable leadership', () => {
  it('elects one leader across independent connections and fails over after release', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store, fixture.reopen()];
    try {
      await Promise.all(stores.map(store => store.initialize()));
      const contenders = Array.from({ length: 6 }, (_, index) =>
        createWorkflowLeadership({ store: stores[index % 2]!, scope, role: 'pg-host', holderId: `replica-${index}` }));
      const results = await Promise.all(contenders.map(contender => contender.acquire()));
      const winner = results.findIndex(result => result.leader);
      expect(results.filter(result => result.leader)).toHaveLength(1); expect(results[winner]).toMatchObject({ fence: 1 });
      await contenders[winner]!.release();
      const next = contenders[(winner + 1) % contenders.length]!;
      expect(await next.acquire()).toMatchObject({ leader: true, fence: 2 });
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });
});
