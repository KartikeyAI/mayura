import { durableBudgetFacade } from '../durable-budget-validation.js';
import { executionWaitFacade } from '../execution-wait-validation.js';
import { scheduledFacade, workflowGraphFacade } from '../scheduled-validation.js';
import { schedulerFacade } from '../scheduler-validation.js';
import { workflowGraphDiscoveryFacade } from '../workflow-graph-discovery-validation.js';
import { workflowTreeDiscoveryFacade } from '../workflow-tree-discovery-validation.js';
import { workflowTreeFacade } from '../workflow-tree-validation.js';
import {
  StorageError, storageError,
  type CreateRecord, type DurableBudgetAggregateStore, type MemoryIndexAggregateStore, type MigrateRecord, type StoredEvent, type StoredRecord, type UpdateRecord,
  type WorkflowGraphDiscoveryAggregateStore, type WorkflowTreeDiscoveryAggregateStore,
} from '@mayura/storage-contracts';
import { aggregateRecord, type AggregateRow } from '../aggregate-session.js';
import { DurableBudgetDatabase } from '../durable-budget-database.js';
import { ExecutionWaitDatabase } from '../execution-wait-database.js';
import { ScheduledWorkflowDatabase } from '../scheduled-database.js';
import { SchedulerDatabase } from '../scheduler-database.js';
import { createCommand, cursor, EVENT_PAGE_SIZE, identifier, migrateCommand, storedObject, updateCommand } from '../validation.js';
import { writerRequired } from '../aggregate-session.js';
import { WorkflowTreeDatabase } from '../workflow-tree-database.js';
import { documentBudgetRows } from './budget-rows.js';
import { documentExecutionWaitRows } from './execution-wait-rows.js';
import { at, json, sort } from './layout.js';
import { documentMemory } from './memory.js';
import { createRecord, documentScheduledRows, recordEvents, writeRecord } from './scheduled-rows.js';
import { documentSchedulerRows } from './scheduler-rows.js';
import { documentTransactions, type DocumentBackend, type DocumentTransactionOptions } from './session.js';
import { documentTreeRows } from './tree-rows.js';
import type { DurableBudgetPersistence, DurableBudgetTransaction } from '../durable-budget-persistence.js';
import type { ExecutionWaitPersistence, ExecutionWaitTransaction } from '../execution-wait-persistence.js';
import type { ScheduledPersistence, ScheduledTransaction } from '../scheduled-persistence.js';
import type { SchedulerPersistence, SchedulerTransaction } from '../scheduler-persistence.js';
import type { WorkflowTreePersistence, WorkflowTreeTransaction } from '../workflow-tree-persistence.js';

/** Everything the SQL stores keep: records, memory, durable budgets, the scheduler, and durable workflows with graphs, trees, waits and discovery. */
export type DocumentStore = MemoryIndexAggregateStore & DurableBudgetAggregateStore & WorkflowGraphDiscoveryAggregateStore & WorkflowTreeDiscoveryAggregateStore;
export interface DocumentStoreOptions extends DocumentTransactionOptions {
  /** Called once when the store closes, to release what the adapter opened. */
  readonly close?: () => Promise<void>;
  /** Turns a database driver's failure into a storage error without the driver's text. */
  readonly failure?: (error: unknown) => StorageError;
}

/**
 * The Mayura store on any database that offers a {@link DocumentBackend}: the SQL stores' own state machines, run as
 * optimistic transactions over documents. A transaction reads, holds its writes, and commits them atomically only if
 * everything it locked or wrote is unchanged; otherwise it runs again with fresh reads.
 */
export function createDocumentStore(backend: DocumentBackend, options: DocumentStoreOptions = {}): DocumentStore {
  const transaction = documentTransactions(backend, options);
  const failure = options.failure ?? ((error: unknown) => error instanceof StorageError ? error : storageError(error));
  let initialized = false; let closed = false;
  let initializePromise: Promise<void> | undefined; let closePromise: Promise<void> | undefined;
  const available = (requireInitialization = true): void => {
    if (closed) throw new StorageError('STORE_CLOSED', 'Storage has been closed; open a new store to continue.');
    if (requireInitialization && !initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Storage is not initialized: call `await store.initialize()` before using it.');
  };
  /** Every capability call: only after initialization, and a driver failure reported without the driver's text. */
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => { available(); try { return await run(); } catch (error) { throw failure(error); } };
  // Documents need no schema: each capability's initialization only marks it ready.
  const nothing = async () => {};
  const scheduler: SchedulerPersistence = { initialize: nothing, transaction: <T>(body: (tx: SchedulerTransaction) => Promise<T>) => transaction(session => body(documentSchedulerRows(session))) };
  const scheduled: ScheduledPersistence = { initialize: nothing, initializeDiscovery: nothing,
    transaction: <T>(body: (tx: ScheduledTransaction) => Promise<T>) => transaction(session => body(documentScheduledRows(session))) };
  const waits: ExecutionWaitPersistence = { initialize: nothing, transaction: <T>(body: (tx: ExecutionWaitTransaction) => Promise<T>) => transaction(session => body(documentExecutionWaitRows(session))) };
  const budgets: DurableBudgetPersistence = { initialize: nothing, transaction: <T>(body: (tx: DurableBudgetTransaction) => Promise<T>) => transaction(session => body(documentBudgetRows(session))) };
  const trees: WorkflowTreePersistence = { initialize: nothing, initializeDiscovery: nothing,
    transaction: <T>(body: (tx: WorkflowTreeTransaction) => Promise<T>) => transaction(session => body(documentTreeRows(session))) };
  const schedulerDatabase = new SchedulerDatabase(scheduler);
  const workflowsDatabase = new ScheduledWorkflowDatabase(scheduled, schedulerDatabase);
  const executionWaitDatabase = new ExecutionWaitDatabase(waits, workflowsDatabase);
  const durableBudgetDatabase = new DurableBudgetDatabase(budgets);
  const workflowTreeDatabase = new WorkflowTreeDatabase(trees, schedulerDatabase, budgets);
  const record = (row: AggregateRow): StoredRecord => aggregateRecord(row);
  const current = async (scope: string, id: string): Promise<AggregateRow | undefined> => transaction(async session => json<AggregateRow>(await session.get(at.run(scope, id), sort.record)));

  return {
    memory: documentMemory(transaction, () => available()),
    durableBudgets: durableBudgetFacade((method, input) => guarded(() => durableBudgetDatabase.execute(method, input))),
    scheduler: schedulerFacade((method, input) => guarded(() => schedulerDatabase.execute(method, input))),
    workflows: scheduledFacade((method, input) => guarded(() => workflowsDatabase.execute(method, input))),
    workflowGraphs: workflowGraphFacade((method, input) => guarded(() => workflowsDatabase.execute(method, input, 2))),
    workflowGraphDiscovery: workflowGraphDiscoveryFacade((method, input) => guarded(() => workflowsDatabase.discover(method, input))),
    executionWaits: executionWaitFacade((method, input) => guarded(() => executionWaitDatabase.execute(method, input))),
    workflowTrees: workflowTreeFacade((method, input) => guarded(() => workflowTreeDatabase.execute(method, input))),
    workflowTreeDiscovery: workflowTreeDiscoveryFacade((method, input) => guarded(() => workflowTreeDatabase.discover(method, input))),
    initialize: async () => {
      available(false);
      initializePromise ??= backend.initialize().catch((error: unknown) => { initializePromise = undefined; throw failure(error); });
      await initializePromise; initialized = true;
    },
    create: (raw: CreateRecord) => guarded(async () => {
      const input = createCommand(raw);
      return transaction(async session => {
        const created = await createRecord(session, input, await session.clock());
        return { record: record(created.row), created: created.created };
      });
    }),
    read: (scope, id) => guarded(async () => { identifier(scope, 'Scope'); identifier(id, 'Record ID'); const row = await current(scope, id); return row ? record(row) : undefined; }),
    update: (raw: UpdateRecord) => guarded(async () => {
      const input = updateCommand(raw);
      return transaction(async session => {
        const found = json<AggregateRow>(await session.get(at.run(input.scope, input.id), sort.record, true));
        if (!found) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await session.get(at.run(input.scope, input.id), sort.owner) !== undefined) writerRequired();
        if (Number(found.version) !== input.expectedVersion) throw new StorageError('CONFLICT', 'The record changed after it was read (another writer updated it); read it again and retry.');
        return record(await writeRecord(session, found, input.state, input.events, await session.clock()));
      });
    }),
    migrate: (raw: MigrateRecord) => guarded(async () => {
      const input = migrateCommand(raw);
      return transaction(async session => {
        const found = json<AggregateRow>(await session.get(at.run(input.scope, input.id), sort.record, true));
        if (!found) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await session.get(at.run(input.scope, input.id), sort.owner) !== undefined) writerRequired();
        if (Number(found.version) !== input.expectedVersion || found.definition_hash !== input.expectedDefinitionHash) throw new StorageError('CONFLICT', 'The record or its pinned definition changed after it was read; read it again and retry.');
        return record(await writeRecord(session, { ...found, definition_hash: input.definitionHash }, input.state, input.events, await session.clock())
          .then(async row => { const next = { ...row, definition_hash: input.definitionHash }; await session.put(at.run(input.scope, input.id), sort.record, JSON.stringify(next)); return next; }));
      });
    }),
    events: (scope, id, afterSequence = 0) => guarded(async () => {
      identifier(scope, 'Scope'); identifier(id, 'Record ID'); cursor(afterSequence);
      return transaction(async session => (await recordEvents(session, scope, id, afterSequence, EVENT_PAGE_SIZE))
        .map(event => ({ sequence: event.sequence, type: event.type, data: storedObject(JSON.parse(event.data)), createdAt: event.created_at }) satisfies StoredEvent));
    }),
    close: () => {
      if (!closePromise) { closed = true; closePromise = (options.close?.() ?? Promise.resolve()).catch((error: unknown) => { throw failure(error); }); }
      return closePromise;
    },
  };
}
