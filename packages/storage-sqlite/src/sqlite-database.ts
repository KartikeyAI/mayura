import Database from 'better-sqlite3';
import { StorageError, type StoredEvent, type StoredRecord, type CreateRecord, type UpdateRecord, type MigrateRecord, type ExecutionWaitMethod, type WorkflowGraphStore, type WorkflowGraphDiscoveryStore, type DurableBudgetMethod, type WorkflowTreeMethod, type WorkflowTreeDiscoveryStore, type MemoryIndexMethod } from '@mayura/storage-contracts';
import {
  createCommand, updateCommand, migrateCommand, submissionDigest, nextCounter, storedObject, EVENT_PAGE_SIZE,
  SchedulerDatabase, type SchedulerSession, type SchedulerBackend, type SchedulerMethod,
  ScheduledWorkflowDatabase, type ScheduledMethod, writerRequired, ExecutionWaitDatabase, DurableBudgetDatabase, WorkflowTreeDatabase, MemoryIndexDatabase,
} from '@mayura/storage-sql/host';

interface Row {
  scope: string; id: string; idempotency_key: string; definition_hash: string;
  submission_digest: string; version: number; event_sequence: number; state: string;
}

function record(row: Row): StoredRecord {
  return {
    scope: row.scope, id: row.id, idempotencyKey: row.idempotency_key,
    definitionHash: row.definition_hash, version: row.version, state: storedObject(JSON.parse(row.state)),
  };
}

/** Internal synchronous database: instantiated only inside the dedicated storage worker. */
export class SqliteDatabase {
  private readonly db: Database.Database;
  private readonly scheduler: SchedulerDatabase;
  private readonly workflows: ScheduledWorkflowDatabase;
  private readonly executionWaits: ExecutionWaitDatabase;
  private readonly durableBudgets: DurableBudgetDatabase;
  private readonly workflowTrees: WorkflowTreeDatabase;
  private readonly memory: MemoryIndexDatabase;
  constructor(private readonly filename: string) {
    this.db = new Database(filename, { timeout: 5_000 });
    const session: SchedulerSession = { query: async <T>(sql: string, parameters: readonly unknown[] = []) => {
      const statement = this.db.prepare(sql);
      if (statement.reader) return statement.all(...parameters) as T[];
      statement.run(...parameters); return [];
    } };
    const backend: SchedulerBackend = { dialect: 'sqlite', prefix: '', transaction: async body => {
      // The owning worker serializes complete requests, including these awaited pure SQL steps.
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = await body(session); this.db.exec('COMMIT'); return result; }
      catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } throw error; }
    } };
    this.scheduler = new SchedulerDatabase(backend);
    this.workflows = new ScheduledWorkflowDatabase(backend,this.scheduler);
    this.executionWaits = new ExecutionWaitDatabase(backend,this.workflows);
    this.durableBudgets = new DurableBudgetDatabase(backend);
    this.workflowTrees = new WorkflowTreeDatabase(backend,this.scheduler);
    this.memory = new MemoryIndexDatabase(backend);
  }

  schedulerCommand(method: SchedulerMethod, input: unknown): Promise<unknown> { return this.scheduler.execute(method, input); }
  workflowsCommand(method: ScheduledMethod, input: unknown): Promise<unknown> { return this.workflows.execute(method,input); }
  workflowGraphsCommand(method: keyof WorkflowGraphStore, input: unknown): Promise<unknown> { return this.workflows.execute(method,input,2); }
  workflowGraphDiscoveryCommand(method: keyof WorkflowGraphDiscoveryStore, input: unknown): Promise<unknown> { return this.workflows.discover(method,input); }
  executionWaitsCommand(method: ExecutionWaitMethod, input: unknown): Promise<unknown> { return this.executionWaits.execute(method,input); }
  durableBudgetsCommand(method: DurableBudgetMethod, input: unknown): Promise<unknown> { return this.durableBudgets.execute(method,input); }
  workflowTreesCommand(method: WorkflowTreeMethod, input: unknown): Promise<unknown> { return this.workflowTrees.execute(method,input); }
  memoryCommand(method: MemoryIndexMethod, input: unknown): Promise<unknown> { return this.memory.execute(method,input); }
  workflowTreeDiscoveryCommand(method:keyof WorkflowTreeDiscoveryStore,input:unknown):Promise<unknown>{return this.workflowTrees.discover(method,input);}

  initialize(): void {
    const journal = this.db.pragma('journal_mode = WAL', { simple: true });
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    if ((this.filename !== ':memory:' && journal !== 'wal') || this.db.pragma('synchronous', { simple: true }) !== 2 || this.db.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new StorageError('STORAGE_UNAVAILABLE', 'SQLite durability settings could not be enabled.');
    }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mayura_storage_meta (version INTEGER PRIMARY KEY CHECK(version = 1));
        INSERT OR IGNORE INTO mayura_storage_meta (version) VALUES (1);
        CREATE TABLE IF NOT EXISTS mayura_aggregates (
          scope TEXT NOT NULL, id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          definition_hash TEXT NOT NULL, submission_digest TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0), event_sequence INTEGER NOT NULL CHECK(event_sequence >= 0),
          state TEXT NOT NULL, PRIMARY KEY(scope, id), UNIQUE(scope, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS mayura_events (
          scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
          type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(scope, aggregate_id, sequence),
          FOREIGN KEY(scope, aggregate_id) REFERENCES mayura_aggregates(scope, id)
        );
        CREATE TABLE IF NOT EXISTS mayura_workflow_owners (
          scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, profile INTEGER NOT NULL CHECK(profile > 0),
          aggregate_version BIGINT NOT NULL CHECK(aggregate_version > 0), definition_hash TEXT NOT NULL,
          policy_hash TEXT NOT NULL, resource_hash TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(scope, aggregate_id), FOREIGN KEY(scope, aggregate_id) REFERENCES mayura_aggregates(scope, id)
        );
      `);
      const versions = this.db.prepare('SELECT version FROM mayura_storage_meta').all() as { version: number }[];
      if (versions.length !== 1 || versions[0]?.version !== 1) throw new StorageError('STORAGE_UNAVAILABLE', 'Unsupported storage schema version.');
    }).immediate();
  }

  private row(scope: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?').get(scope, id) as Row | undefined;
  }

  read(scope: string, id: string): StoredRecord | undefined {
    const row = this.row(scope, id);
    return row ? record(row) : undefined;
  }

  create(raw: CreateRecord): { record: StoredRecord; created: boolean } {
    const input = createCommand(raw);
    const digest = submissionDigest(input);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM mayura_aggregates WHERE scope = ? AND idempotency_key = ?')
        .get(input.scope, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.submission_digest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
        return { record: record(existing), created: false };
      }
      if (this.row(input.scope, input.id)) throw new StorageError('CONFLICT', 'A record with this ID already exists in this scope under another idempotency key; use a different ID.');
      this.db.prepare(`INSERT INTO mayura_aggregates
        (scope, id, idempotency_key, definition_hash, submission_digest, version, event_sequence, state)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(input.scope, input.id, input.idempotencyKey, input.definitionHash, digest, input.events.length, JSON.stringify(input.state));
      this.append(input.scope, input.id, 0, input.events);
      const inserted = this.row(input.scope, input.id);
      if (!inserted) throw new StorageError('STORAGE_UNAVAILABLE', 'Created record is unavailable.');
      return { record: record(inserted), created: true };
    }).immediate();
  }

  update(raw: UpdateRecord): StoredRecord {
    const input = updateCommand(raw);
    return this.db.transaction(() => {
      const current = this.row(input.scope, input.id);
      if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
      if (this.db.prepare('SELECT aggregate_id FROM mayura_workflow_owners WHERE scope = ? AND aggregate_id = ?').get(input.scope,input.id)) writerRequired();
      if (current.version !== input.expectedVersion) throw new StorageError('CONFLICT', 'The record changed after it was read (another writer updated it); read it again and retry.');
      this.db.prepare('UPDATE mayura_aggregates SET state = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ?')
        .run(JSON.stringify(input.state), nextCounter(current.version, 1), nextCounter(current.event_sequence, input.events.length), input.scope, input.id);
      this.append(input.scope, input.id, current.event_sequence, input.events);
      const updated = this.row(input.scope, input.id);
      if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Updated record is unavailable.');
      return record(updated);
    }).immediate();
  }

  migrate(raw: MigrateRecord): StoredRecord {
    const input = migrateCommand(raw);
    return this.db.transaction(() => {
      const current = this.row(input.scope, input.id);
      if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
      if (this.db.prepare('SELECT aggregate_id FROM mayura_workflow_owners WHERE scope = ? AND aggregate_id = ?').get(input.scope,input.id)) writerRequired();
      if (current.version !== input.expectedVersion || current.definition_hash !== input.expectedDefinitionHash) throw new StorageError('CONFLICT', 'The record or its pinned definition changed after it was read; read it again and retry.');
      this.db.prepare('UPDATE mayura_aggregates SET state = ?, definition_hash = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ?')
        .run(JSON.stringify(input.state), input.definitionHash, nextCounter(current.version, 1), nextCounter(current.event_sequence, input.events.length), input.scope, input.id);
      this.append(input.scope, input.id, current.event_sequence, input.events);
      const updated = this.row(input.scope, input.id);
      if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Migrated record is unavailable.');
      return record(updated);
    }).immediate();
  }

  private append(scope: string, id: string, sequence: number, events: CreateRecord['events']): void {
    const insert = this.db.prepare('INSERT INTO mayura_events (scope, aggregate_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const timestamp = new Date().toISOString();
    for (const [index, event] of events.entries()) insert.run(scope, id, nextCounter(sequence, index + 1), event.type, JSON.stringify(event.data), timestamp);
  }

  events(scope: string, id: string, after: number): StoredEvent[] {
    const rows = this.db.prepare('SELECT sequence, type, data, created_at FROM mayura_events WHERE scope = ? AND aggregate_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(scope, id, after, EVENT_PAGE_SIZE) as { sequence: number; type: string; data: string; created_at: string }[];
    return rows.map((row) => ({ sequence: row.sequence, type: row.type, data: storedObject(JSON.parse(row.data)), createdAt: row.created_at }));
  }

  close(): void { this.db.close(); }
}
