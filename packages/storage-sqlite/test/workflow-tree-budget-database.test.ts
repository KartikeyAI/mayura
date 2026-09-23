import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DurableBudgetDatabase, WorkflowTreeBudgetDatabase, type SchedulerBackend, type SchedulerSession } from '@mayura/storage-sql/host';

function backend(database: Database.Database): SchedulerBackend {
  const session: SchedulerSession = {
    query: async <T>(sql: string, parameters: readonly unknown[] = []) => {
      const statement = database.prepare(sql);
      if (statement.reader) return statement.all(...parameters) as T[];
      statement.run(...parameters);
      return [];
    },
  };
  return {
    dialect: 'sqlite', prefix: '', transaction: async body => {
      database.exec('BEGIN IMMEDIATE');
      try { const value = await body(session); database.exec('COMMIT'); return value; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

describe('workflow-tree budget persistence boundary', () => {
  it('keeps host and scheduler ledgers in separate fixed-owner tables', async () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    const selected = backend(database);
    const host = new DurableBudgetDatabase(selected);
    const tree = new WorkflowTreeBudgetDatabase(selected);
    const command = { scope: 'scope', id: 'same-id', policyHash: 'a'.repeat(64), maxCostMicros: 10, maxCalls: 2 };
    await host.execute('initialize',{});
    await tree.execute('initialize',{});
    const hostCreated = await host.execute('create',command) as { snapshot: { owner: string } };
    const treeCreated = await tree.execute('create',command) as { snapshot: { owner: string } };
    expect(hostCreated.snapshot.owner).toBe('host-v1');
    expect(treeCreated.snapshot.owner).toBe('workflow-tree-v1');
    expect(database.prepare('SELECT owner FROM mayura_durable_budgets').pluck().get()).toBe('host-v1');
    expect(database.prepare('SELECT owner FROM mayura_workflow_tree_budgets').pluck().get()).toBe('workflow-tree-v1');
    await expect(host.execute('fork',{...command,parentId:'root',accountId:'host-child',maxCostMicros:1,maxCalls:1})).resolves.toBeDefined();
    const treeState = await tree.execute('inspect',{ scope: command.scope, id: command.id, policyHash: command.policyHash }) as { accounts: readonly unknown[] };
    expect(treeState.accounts).toHaveLength(1);
    database.close();
  });
});
