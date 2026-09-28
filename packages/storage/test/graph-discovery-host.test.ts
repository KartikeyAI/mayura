import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError, type WorkflowGraphDiscoveryScan, type WorkflowGraphStoreSnapshot, type WorkflowPolicyManifest } from '@mayura/storage-contracts';
import {
  SchedulerDatabase, ScheduledWorkflowDatabase, workflowGraphDiscoveryFacade, workflowGraphFacade,
  type SchedulerBackend, type SchedulerSession,
} from '@mayura/storage-sql/host';

const scope = 'a'.repeat(64); const policyHash = 'b'.repeat(64);
const command = (): WorkflowGraphDiscoveryScan => ({ scope,policyHash,cursor:null,limit:2 });
const empty = () => ({ candidates:[],examined:0,nextCursor:null });

describe('graph discovery host transport boundary', () => {
  it('captures immutable commands before awaiting and owns the returned page', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(complete => { resolve = complete; });
    const request = vi.fn<Parameters<typeof workflowGraphDiscoveryFacade>[0]>(async () => pending);
    const facade = workflowGraphDiscoveryFacade(request);
    const raw = { ...command(),cursor:{format:1 as const,scope,policyHash,afterId:'c'.repeat(64)} };
    const operation = facade.scan(raw);
    const sent = request.mock.calls[0]![1];
    raw.cursor.afterId = 'd'.repeat(64); raw.limit = 32;
    expect(sent).toMatchObject({limit:2,cursor:{afterId:'c'.repeat(64)}});
    expect(Object.isFrozen(sent)).toBe(true); expect(Object.isFrozen(sent!['cursor'])).toBe(true);
    const response = empty(); resolve(response);
    const page = await operation;
    expect(page).not.toBe(response); expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.candidates)).toBe(true);
  });

  it('sanitizes malformed initialization and page replies without executing accessors', async () => {
    const request = vi.fn(async () => ({private:'secret'}));
    const facade = workflowGraphDiscoveryFacade(request);
    await expect(facade.initialize()).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    const getter = vi.fn(() => { throw new Error('PRIVATE backend detail'); });
    const response = Object.defineProperty({},'candidates',{enumerable:true,get:getter});
    request.mockResolvedValue(response as never);
    const error: unknown = await facade.scan(command()).catch((value: unknown) => value);
    expect(error).toMatchObject({code:'STORAGE_UNAVAILABLE'});
    expect(String(error)).not.toContain('PRIVATE'); expect(getter).not.toHaveBeenCalled();
  });

  it('rejects invalid caller input before request admission and preserves storage failures', async () => {
    const request = vi.fn(async () => { throw new StorageError('STORE_CLOSED','Storage is closed.'); });
    const facade = workflowGraphDiscoveryFacade(request);
    await expect(facade.scan({...command(),limit:33})).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(request).not.toHaveBeenCalled();
    await expect(facade.scan(command())).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE',storageCode:'STORE_CLOSED'});
  });
});

/** Real SQLite with query/transaction instrumentation; no fake rows or clock substitution. */
function fixture() {
  const database = new Database(':memory:'); database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE mayura_aggregates (
    scope TEXT NOT NULL,id TEXT NOT NULL,idempotency_key TEXT NOT NULL,definition_hash TEXT NOT NULL,
    submission_digest TEXT NOT NULL,version INTEGER NOT NULL,event_sequence INTEGER NOT NULL,state TEXT NOT NULL,
    PRIMARY KEY(scope,id),UNIQUE(scope,idempotency_key));
    CREATE TABLE mayura_events (scope TEXT NOT NULL,aggregate_id TEXT NOT NULL,sequence INTEGER NOT NULL,
      type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope,aggregate_id,sequence),
      FOREIGN KEY(scope,aggregate_id) REFERENCES mayura_aggregates(scope,id));`);
  const queries: { transaction: number; sql: string; parameters: readonly unknown[] }[] = [];
  let transaction = 0;
  let selected = false;
  let afterSelection: (() => void) | undefined;
  const session: SchedulerSession = { async query<T>(sql: string, parameters: readonly unknown[] = []): Promise<readonly T[]> {
    queries.push({transaction,sql,parameters});
    if (sql.startsWith('SELECT aggregate_id FROM mayura_workflow_owners')) selected = true;
    const statement = database.prepare(sql);
    if (statement.reader) return statement.all(...parameters) as T[];
    statement.run(...parameters); return [];
  } };
  const backend: SchedulerBackend = { dialect:'sqlite',prefix:'',async transaction(body) {
    transaction++; selected = false; database.exec('BEGIN IMMEDIATE');
    try {
      const result = await body(session); database.exec('COMMIT');
      if (selected && afterSelection) { const action = afterSelection; afterSelection = undefined; action(); }
      return result;
    }
    catch (error) { if (database.inTransaction) database.exec('ROLLBACK'); throw error; }
  } };
  const coordinator = new ScheduledWorkflowDatabase(backend,new SchedulerDatabase(backend));
  return {database,queries,coordinator,afterSelection(action: () => void) { afterSelection = action; },
    graphs:workflowGraphFacade((method,input) => coordinator.execute(method,input,2)),
    discovery:workflowGraphDiscoveryFacade((method,input) => coordinator.discover(method,input)),
  };
}

describe('graph discovery indexed finite SQL boundary', () => {
  let current: ReturnType<typeof fixture> | undefined;
  afterEach(() => { current?.database.close(); current = undefined; });
  const policy: WorkflowPolicyManifest = {scope:{principalId:'discovery-host',projectId:'bounded'},permissions:[],policyVersion:'1',
    maxCostMicros:0,maxOutputBytes:65_536,approvalTtlMs:60_000};
  const access = (snapshot: WorkflowGraphStoreSnapshot) => ({scope:snapshot.record.scope,id:snapshot.record.id,policyHash:snapshot.policyHash});

  it.each([
    ['wrong columns','ON mayura_workflow_owners (scope)'],
    ['wrong table','ON mayura_aggregates (scope,id)'],
    ['partial','ON mayura_workflow_owners (scope,policy_hash,profile,aggregate_id COLLATE BINARY) WHERE profile = 2'],
    ['descending','ON mayura_workflow_owners (scope,policy_hash,profile,aggregate_id COLLATE BINARY DESC)'],
    ['wrong collation','ON mayura_workflow_owners (scope,policy_hash,profile,aggregate_id COLLATE NOCASE)'],
    ['expression','ON mayura_workflow_owners (scope,policy_hash,profile,lower(aggregate_id))'],
  ])('rejects a %s discovery index without changing or replacing it', async (_name,definition) => {
    current = fixture(); await current.graphs.initialize();
    current.database.exec(`CREATE INDEX mayura_workflow_owners_discovery ${definition}`);
    const before = current.database.prepare("SELECT * FROM sqlite_schema WHERE name = 'mayura_workflow_owners_discovery'").all();
    await expect(current.discovery.initialize()).rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    await expect(current.discovery.scan(command())).rejects.toMatchObject({code:'INVALID_CONFIG',storageCode:'STORE_NOT_INITIALIZED'});
    expect(current.database.prepare("SELECT * FROM sqlite_schema WHERE name = 'mayura_workflow_owners_discovery'").all()).toEqual(before);
  });

  it('examines terminal owners up to the requested cap, with separate parent transactions and no writes', async () => {
    current = fixture(); await current.graphs.initialize();
    const terminal: WorkflowGraphStoreSnapshot[] = [];
    for (const key of ['first','second','third']) {
      const submitted = (await current.graphs.submit({manifest:{format:3,id:'discovery',version:'1',graph:[{kind:'join',id:'done',dependsOn:[]}],
        result:{kind:'literal',value:null}},policy,resources:{},input:null,idempotencyKey:key})).snapshot;
      terminal.push(await current.graphs.cancel({...access(submitted),expectedVersion:submitted.record.version,commandId:`cancel-${key}`}));
    }
    await expect(current.discovery.scan({...command(),scope:terminal[0]!.record.scope,policyHash:terminal[0]!.policyHash}))
      .rejects.toMatchObject({code:'INVALID_CONFIG',storageCode:'STORE_NOT_INITIALIZED'});
    current.queries.length = 0;
    await current.discovery.initialize(); await current.discovery.initialize();
    expect(current.queries.filter(query => query.sql.startsWith('CREATE INDEX IF NOT EXISTS mayura_workflow_owners_discovery'))).toHaveLength(1);
    const tables = ['mayura_aggregates','mayura_events','mayura_workflow_owners','mayura_scheduler_jobs','mayura_execution_completions'];
    const before = tables.map(table => current!.database.prepare(`SELECT * FROM ${table}`).all());
    const scan = {...command(),scope:terminal[0]!.record.scope,policyHash:terminal[0]!.policyHash};
    current.queries.length = 0;
    const page = await current.discovery.scan(scan);
    expect(page).toMatchObject({candidates:[],examined:2});
    expect(page.nextCursor?.afterId).toBe(terminal.map(value => value.record.id).sort()[1]);
    const selection = current.queries.filter(query => query.sql.startsWith('SELECT aggregate_id FROM mayura_workflow_owners'));
    expect(selection).toHaveLength(1);
    expect(selection[0]!.sql).toContain('COLLATE BINARY');
    expect(selection[0]!.sql).toMatch(/ORDER BY aggregate_id COLLATE BINARY LIMIT \?/);
    expect(selection[0]!.parameters).toEqual([scan.scope,scan.policyHash,'',2]);
    const parents = current.queries.filter(query => query.sql.startsWith('SELECT * FROM mayura_aggregates'));
    expect(parents).toHaveLength(2);
    expect(new Set(parents.map(query => query.transaction)).size).toBe(2);
    expect(parents.every(query => query.transaction > selection[0]!.transaction)).toBe(true);
    expect(current.queries.every(query => !/^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(query.sql))).toBe(true);
    expect(tables.map(table => current!.database.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    const last = await current.discovery.scan({...scan,cursor:page.nextCursor});
    expect(last).toEqual({candidates:[],examined:1,nextCursor:null});
  });

  it('fails the whole page when a selected owner disappears after selection commits', async () => {
    current = fixture(); await current.discovery.initialize();
    const snapshots: WorkflowGraphStoreSnapshot[] = [];
    for (const key of ['retained','disappearing']) snapshots.push((await current.graphs.submit({
      manifest:{format:3,id:'disappearance',version:'1',graph:[{kind:'join',id:'done',dependsOn:[]}],result:{kind:'literal',value:null}},
      policy,resources:{},input:null,idempotencyKey:key,
    })).snapshot);
    const sorted = snapshots.sort((left,right) => left.record.id < right.record.id ? -1 : 1);
    const removed = sorted[1]!;
    // Privileged out-of-band deletion is deliberate corruption. The first valid
    // candidate must not leak as a partial page when the second selection is gone.
    current.afterSelection(() => {
      expect(current!.database.inTransaction).toBe(false);
      expect(current!.database.prepare('DELETE FROM mayura_workflow_owners WHERE scope = ? AND aggregate_id = ?')
        .run(removed.record.scope,removed.record.id).changes).toBe(1);
    });
    const aggregates = current.database.prepare('SELECT * FROM mayura_aggregates ORDER BY id').all();
    const events = current.database.prepare('SELECT * FROM mayura_events ORDER BY aggregate_id,sequence').all();
    current.queries.length = 0;
    await expect(current.discovery.scan({...command(),scope:removed.record.scope,policyHash:removed.policyHash}))
      .rejects.toMatchObject({code:'STORAGE_UNAVAILABLE'});
    const parentReads = current.queries.filter(query => query.sql.startsWith('SELECT * FROM mayura_aggregates'));
    expect(parentReads.map(query => query.parameters[1])).toEqual(sorted.map(snapshot => snapshot.record.id));
    expect(new Set(parentReads.map(query => query.transaction)).size).toBe(2);
    expect(current.database.prepare('SELECT * FROM mayura_aggregates ORDER BY id').all()).toEqual(aggregates);
    expect(current.database.prepare('SELECT * FROM mayura_events ORDER BY aggregate_id,sequence').all()).toEqual(events);
  });
});
