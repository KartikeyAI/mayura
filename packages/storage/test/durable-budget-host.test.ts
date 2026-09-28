import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as host from '@mayura/storage-sql/host';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { StorageError, type DurableBudgetSnapshot } from '@mayura/storage-contracts';
import { DurableBudgetDatabase, durableBudgetFacade, type SchedulerBackend, type SchedulerSession } from '@mayura/storage-sql/host';

const key = {scope:'durable-budget-host',id:'shared-root',policyHash:'a'.repeat(64)};
const creation = {...key,maxCostMicros:20,maxCalls:10};
const bundle = {...key,accountId:'root',bundleId:'first',operations:[{id:'one',maxCostMicros:10}]};
function initial(): DurableBudgetSnapshot {
  return {format:1,mode:'shared-ceiling-v1',owner:'host-v1',...key,version:1,eventSequence:1,blocked:false,
    accounts:[{id:'root',parentId:null,maxCostMicros:20,maxCalls:10,closed:false,spentMicros:0,reservedMicros:0,calls:0,heldCalls:0}],
    bundles:[],reservations:[]};
}

/** Actual SQLite plus finite transaction fault injection; no synthetic stored rows. */
function fixture() {
  const database = new Database(':memory:'); database.pragma('foreign_keys = ON');
  const queries: {transaction:number;sql:string;parameters:readonly unknown[]}[] = [];
  let transactions = 0; let rejectCommit = false;
  const session: SchedulerSession = { async query<T>(sql: string,parameters: readonly unknown[] = []): Promise<readonly T[]> {
    queries.push({transaction:transactions,sql,parameters});
    const statement = database.prepare(sql);
    if (statement.reader) return statement.all(...parameters) as T[];
    statement.run(...parameters); return [];
  } };
  const backend: SchedulerBackend = {dialect:'sqlite',prefix:'',async transaction(body) {
    transactions++; database.exec('BEGIN IMMEDIATE');
    try {
      const result = await body(session);
      if (rejectCommit) { rejectCommit = false; throw new Error('Injected precommit rollback'); }
      database.exec('COMMIT'); return result;
    } catch (error) { if (database.inTransaction) database.exec('ROLLBACK'); throw error; }
  } };
  const engine = new DurableBudgetDatabase(backend);
  return {database,queries,engine,backend,facade:durableBudgetFacade((method,command) => engine.execute(method,command)),
    rejectNextCommit() { rejectCommit = true; },transactions:() => transactions};
}

describe('durable budget trusted storage capability', () => {
  it('exports the shared reducer wrapper and transport facade', () => {
    expect(Object.hasOwn(host,'DurableBudgetDatabase')).toBe(true);
    expect(Object.hasOwn(host,'durableBudgetFacade')).toBe(true);
  });

  it('selects durable budgets without removing the existing SQLite capabilities', async () => {
    const store = createSqliteStore({filename:':memory:'});
    try {
      expect(Object.hasOwn(store,'durableBudgets')).toBe(true);
      expect(store).toHaveProperty('workflowGraphs');
      expect(store).toHaveProperty('workflowGraphDiscovery');
    } finally { await store.close(); }
  });
});

describe('durable budget transport ownership', () => {
  it('owns admitted commands and decoded replies across asynchronous transport', async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn<Parameters<typeof durableBudgetFacade>[0]>(async () => new Promise(accept => { resolve = accept; }));
    const facade = durableBudgetFacade(request); const command = {...creation}; const response = initial();
    const pending = facade.create(command); command.id = 'changed'; command.maxCostMicros = 1;
    expect(request.mock.calls[0]![1]).toEqual(creation); expect(Object.isFrozen(request.mock.calls[0]![1])).toBe(true);
    resolve({snapshot:response,created:true}); const value = await pending;
    expect(value.snapshot).toEqual(initial()); expect(value.snapshot).not.toBe(response);
    expect(Object.isFrozen(value.snapshot.accounts[0])).toBe(true);
  });

  it('rejects malformed commands before transport and sanitizes malformed replies without getters', async () => {
    const request = vi.fn<Parameters<typeof durableBudgetFacade>[0]>(async () => undefined);
    const facade = durableBudgetFacade(request);
    await expect(facade.reserveBundle({...bundle,operations:[]})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({private:'PRIVATE'}); await expect(facade.initialize()).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    const getter = vi.fn(() => 'PRIVATE');
    request.mockResolvedValueOnce(Object.defineProperty({},'snapshot',{enumerable:true,get:getter}));
    const failure: unknown = await facade.create(creation).catch((error: unknown) => error);
    expect(failure).toMatchObject({code:'STORAGE_UNAVAILABLE'}); expect(String(failure)).not.toContain('PRIVATE'); expect(getter).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({...initial(),id:'different'});
    await expect(facade.inspect(key)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    request.mockResolvedValueOnce({...initial(),accounts:[{...initial().accounts[0]!,reservedMicros:10}]});
    await expect(facade.inspect(key)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    request.mockRejectedValueOnce(new StorageError('STORE_CLOSED','Closed'));
    await expect(facade.inspect(key)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE',storageCode:'STORE_CLOSED'});
  });
});

describe('durable budget actual SQLite transaction boundary', () => {
  let current: ReturnType<typeof fixture> | undefined;
  afterEach(() => { current?.database.close(); current = undefined; });

  it('does not cache initialization before commit and retains bounded explicit setup', async () => {
    current = fixture(); current.rejectNextCommit();
    await expect(current.facade.initialize()).rejects.toThrow('Injected precommit rollback');
    await expect(current.facade.inspect(key)).rejects.toMatchObject({code:'INVALID_CONFIG',storageCode:'STORE_NOT_INITIALIZED'});
    expect(current.database.prepare("SELECT name FROM sqlite_schema WHERE name = 'mayura_durable_budgets'").all()).toEqual([]);
    await current.facade.initialize(); const count = current.transactions(); await current.facade.initialize();
    expect(current.transactions()).toBe(count); expect(await current.facade.inspect(key)).toBeUndefined();
  });

  it('uses the caller session atomically and never creates a nested transaction', async () => {
    current = fixture(); await current.facade.initialize(); const before = await current.facade.create(creation);
    const count = current.transactions();
    await expect(current.backend.transaction(async tx => {
      await current!.engine.inSession(tx).execute('reserveBundle',bundle);
      throw new Error('Rollback whole integration');
    })).rejects.toThrow('Rollback whole integration');
    expect(current.transactions()).toBe(count + 1);
    expect(await current.facade.inspect(key)).toEqual(before.snapshot);
    expect(await current.facade.events(key)).toHaveLength(1);
    const committed = await current.backend.transaction(tx => current!.engine.inSession(tx).execute('reserveBundle',bundle));
    expect(committed).toMatchObject({version:2,eventSequence:2,reservations:[{id:'one',status:'held'}]});
  });

  it('commits root state and events together and does not write on exact retries or inspection', async () => {
    current = fixture(); await current.facade.initialize(); await current.facade.create(creation);
    current.rejectNextCommit(); await expect(current.facade.reserveBundle(bundle)).rejects.toThrow('Injected precommit rollback');
    expect((await current.facade.inspect(key))!.reservations).toHaveLength(0); expect(await current.facade.events(key)).toHaveLength(1);
    const reserved = await current.facade.reserveBundle(bundle); current.queries.length = 0;
    expect(await current.facade.reserveBundle(bundle)).toEqual(reserved);
    expect((await current.facade.create(creation)).created).toBe(false);
    await current.facade.inspect(key); await current.facade.events(key);
    expect(current.queries.every(query => !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(query.sql))).toBe(true);
    const events = await current.facade.events({...key,after:1}); expect(events.map(event => event.sequence)).toEqual([2]);
    expect(events[0]!.type).toBe('budget.reserved'); expect(Object.isFrozen(events[0]!.data)).toBe(true);
  });

  it('commits overrun truth and blocks fresh admission while accepting late settlement', async () => {
    current = fixture(); await current.facade.initialize(); await current.facade.create(creation);
    await current.facade.reserveBundle({...bundle,operations:[{id:'one',maxCostMicros:1},{id:'two',maxCostMicros:1}]});
    for (const reservationId of ['one','two']) await current.facade.start({...key,accountId:'root',reservationId});
    const overrun = await current.facade.settle({...key,accountId:'root',reservationId:'one',actualMicros:Number.MAX_SAFE_INTEGER});
    expect(overrun.overrun).toBe(true); expect(overrun.snapshot.blocked).toBe(true);
    await expect(current.facade.reserveBundle({...bundle,bundleId:'blocked',operations:[{id:'three',maxCostMicros:0}]})).rejects.toMatchObject({code:'CONFLICT'});
    const late = await current.facade.settle({...key,accountId:'root',reservationId:'two',actualMicros:Number.MAX_SAFE_INTEGER});
    expect(late.snapshot.accounts[0]!.spentMicros).toBe('18014398509481982');
    expect((await current.facade.inspect(key))!.accounts[0]!.spentMicros).toBe('18014398509481982');
  });

  it('rejects altered state projections and gapped event history', async () => {
    current = fixture(); await current.facade.initialize(); await current.facade.create(creation);
    await current.facade.fork({...key,parentId:'root',accountId:'child',maxCostMicros:10,maxCalls:5});
    await current.facade.reserveBundle(bundle);
    current.database.prepare('UPDATE mayura_durable_budgets SET policy_hash = ? WHERE scope = ? AND id = ?').run('b'.repeat(64),key.scope,key.id);
    await expect(current.facade.inspect(key)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    current.database.prepare('UPDATE mayura_durable_budgets SET policy_hash = ? WHERE scope = ? AND id = ?').run(key.policyHash,key.scope,key.id);
    current.database.prepare('DELETE FROM mayura_durable_budget_events WHERE scope = ? AND budget_id = ? AND sequence = 2').run(key.scope,key.id);
    await expect(current.facade.inspect(key)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  });

  it('validates selected historical payloads without promising full history replay on each command', async () => {
    current = fixture(); await current.facade.initialize(); await current.facade.create(creation); await current.facade.reserveBundle(bundle);
    current.database.prepare('UPDATE mayura_durable_budget_events SET data = ? WHERE scope = ? AND budget_id = ? AND sequence = 1').run('{"private":"PRIVATE"}',key.scope,key.id);
    expect((await current.facade.inspect(key))!.version).toBe(2);
    await expect(current.facade.events(key)).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
  });
});
