import { MongoClient, MongoError, type ClientSession, type Collection, type Db } from 'mongodb';
import { StorageError, storageError, type AggregateStore, type DurableBudgetAggregateStore, type MemoryIndexAggregateStore, type CreateRecord, type MigrateRecord, type StoredEvent, type StoredRecord, type UpdateRecord } from 'mayura/storage-contracts';
import { mongoBudgets } from './budgets.js';
import { mongoMemory } from './memory.js';
import { createCommand, cursor, EVENT_PAGE_SIZE, identifier, migrateCommand, nextCounter, storedObject, submissionDigest, updateCommand } from 'mayura/storage-sql/host';

/** The Mayura store on MongoDB: aggregates (records, their versions and events), native memory and durable budgets. */
export type MongoStore = AggregateStore & MemoryIndexAggregateStore & DurableBudgetAggregateStore;

export interface MongoStoreOptions {
  /**
   * A `mongodb://` or `mongodb+srv://` URL of a replica set or sharded cluster (transactions need one; a single-node
   * replica set is enough). Keep it in your secret configuration. Give this or `client`.
   */
  readonly uri?: string;
  /** The database that holds Mayura's collections (a name of letters, digits, `_` and `-`). */
  readonly database: string;
  /** A MongoClient you create and own, instead of `uri`. Mayura never closes it. */
  readonly client?: MongoClient;
}

interface AggregateDocument {
  scope: string; id: string; idempotencyKey: string; definitionHash: string; submissionDigest: string;
  version: number; eventSequence: number; state: string;
}
interface EventDocument { scope: string; aggregateId: string; sequence: number; type: string; data: string; createdAt: string }

function record(document: AggregateDocument): StoredRecord {
  if (typeof document.state !== 'string' || !Number.isSafeInteger(document.version) || document.version < 1) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored aggregate failed integrity validation.');
  return { scope: document.scope, id: document.id, idempotencyKey: document.idempotencyKey, definitionHash: document.definitionHash, version: document.version, state: storedObject(JSON.parse(document.state)) };
}
/** A driver failure as a storage error, without the driver's text. A duplicate key is a conflict. */
function safeFailure(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof MongoError && error.code === 11000) return new StorageError('CONFLICT', 'A record with this ID or idempotency key already exists in this scope with different content; use a new ID or key.');
  return storageError(error);
}

/**
 * Mayura storage on MongoDB, through the official `mongodb` driver. Every write is one multi-document transaction
 * (majority write concern, snapshot reads), so a record and its events change together or not at all; the driver
 * retries a transaction that lost a write conflict. State and event data are stored as the exact JSON text given.
 *
 * ```ts
 * const store = createMongoStore({ uri: process.env.MONGODB_URL!, database: 'mayura' });
 * await store.initialize();
 * ```
 */
export function createMongoStore(options: MongoStoreOptions): MongoStore {
  if (options === null || typeof options !== 'object' || Object.keys(options).some(key => !['uri', 'database', 'client'].includes(key))) {
    throw new StorageError('INVALID_INPUT', 'MongoDB store options are uri, database and client.');
  }
  if ((options.uri === undefined) === (options.client === undefined)) throw new StorageError('INVALID_INPUT', 'MongoDB store needs either a uri or a client.');
  if (typeof options.database !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(options.database)) throw new StorageError('INVALID_INPUT', 'MongoDB database must be a name of letters, digits, _ and -, at most 63 characters.');
  let client: MongoClient;
  if (options.client !== undefined) {
    if (!(options.client instanceof MongoClient)) throw new StorageError('INVALID_INPUT', 'MongoDB client must be a MongoClient.');
    client = options.client;
  } else {
    if (typeof options.uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//.test(options.uri)) throw new StorageError('INVALID_INPUT', 'MongoDB uri must be a mongodb:// or mongodb+srv:// URL.');
    // One attempt per operation at the driver level would lose the transient-error retries transactions rely on; the
    // driver's retryable writes stay on. Timeouts bound every wait for a server.
    client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000, maxPoolSize: 8, appName: 'mayura' });
  }
  const owned = options.client === undefined;
  const db: Db = client.db(options.database);
  const aggregates: Collection<AggregateDocument> = db.collection('mayura_aggregates');
  const events: Collection<EventDocument> = db.collection('mayura_events');

  let initialized = false; let closed = false;
  let initializePromise: Promise<void> | undefined; let closePromise: Promise<void> | undefined;
  const available = (requireInitialization = true): void => {
    if (closed) throw new StorageError('STORE_CLOSED', 'Storage has been closed; open a new store to continue.');
    if (requireInitialization && !initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Storage is not initialized: call `await store.initialize()` before using it.');
  };
  /** One transaction; the driver runs it again after a transient failure such as a write conflict. */
  const transaction = async <T>(body: (session: ClientSession) => Promise<T>): Promise<T> => {
    const session = client.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => { result = await body(session); },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10_000 });
      return result as T;
    } catch (error) { throw safeFailure(error); } finally { await session.endSession(); }
  };
  const append = async (session: ClientSession, scope: string, id: string, sequence: number, input: CreateRecord['events']): Promise<void> => {
    if (input.length === 0) return;
    const createdAt = new Date().toISOString();
    await events.insertMany(input.map((event, index) => ({ scope, aggregateId: id, sequence: nextCounter(sequence, index + 1), type: event.type, data: JSON.stringify(event.data), createdAt })),
      { session, ordered: true });
  };
  const current = (session: ClientSession, scope: string, id: string) => aggregates.findOne({ scope, id }, { session, projection: { _id: 0 } });

  return {
    memory: mongoMemory(db, transaction, () => available()),
    durableBudgets: mongoBudgets(db, transaction, () => available()),
    initialize: async () => {
      available(false);
      if (!initializePromise) {
        initializePromise = (async () => {
          try {
            await client.connect();
            // Index creation is idempotent: the same definition twice is no change, a different one is refused.
            await aggregates.createIndexes([
              { key: { scope: 1, id: 1 }, name: 'mayura_aggregates_id', unique: true },
              { key: { scope: 1, idempotencyKey: 1 }, name: 'mayura_aggregates_idempotency', unique: true },
            ]);
            await events.createIndexes([{ key: { scope: 1, aggregateId: 1, sequence: 1 }, name: 'mayura_events_sequence', unique: true }]);
          } catch (error) { throw safeFailure(error); }
        })().then(() => { initialized = true; }).catch((error: unknown) => { initializePromise = undefined; throw error; });
      }
      await initializePromise;
    },
    create: async (raw: CreateRecord) => {
      available();
      const input = createCommand(raw);
      const digest = submissionDigest(input);
      return transaction(async session => {
        const existing = await aggregates.findOne({ scope: input.scope, idempotencyKey: input.idempotencyKey }, { session, projection: { _id: 0 } });
        if (existing) {
          if (existing.submissionDigest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
          return { record: record(existing), created: false };
        }
        if (await current(session, input.scope, input.id)) throw new StorageError('CONFLICT', 'A record with this ID already exists in this scope under another idempotency key; use a different ID.');
        const document: AggregateDocument = { scope: input.scope, id: input.id, idempotencyKey: input.idempotencyKey, definitionHash: input.definitionHash,
          submissionDigest: digest, version: 1, eventSequence: input.events.length, state: JSON.stringify(input.state) };
        await aggregates.insertOne({ ...document }, { session });
        await append(session, input.scope, input.id, 0, input.events);
        return { record: record(document), created: true };
      });
    },
    read: async (scope, id) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID');
      try {
        const found = await aggregates.findOne({ scope, id }, { projection: { _id: 0 }, readConcern: { level: 'majority' } } as never);
        return found ? record(found) : undefined;
      } catch (error) { throw safeFailure(error); }
    },
    update: async (raw: UpdateRecord) => {
      available();
      const input = updateCommand(raw);
      return transaction(async session => {
        const found = await current(session, input.scope, input.id);
        if (!found) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (found.version !== input.expectedVersion) throw new StorageError('CONFLICT', 'The record changed after it was read (another writer updated it); read it again and retry.');
        const next: AggregateDocument = { ...found, state: JSON.stringify(input.state), version: nextCounter(found.version, 1), eventSequence: nextCounter(found.eventSequence, input.events.length) };
        // The version in the filter makes the write fail as a conflict if another transaction got there first.
        const updated = await aggregates.updateOne({ scope: input.scope, id: input.id, version: found.version },
          { $set: { state: next.state, version: next.version, eventSequence: next.eventSequence } }, { session });
        if (updated.matchedCount !== 1) throw new StorageError('CONFLICT', 'The record changed after it was read (another writer updated it); read it again and retry.');
        await append(session, input.scope, input.id, found.eventSequence, input.events);
        return record(next);
      });
    },
    migrate: async (raw: MigrateRecord) => {
      available();
      const input = migrateCommand(raw);
      return transaction(async session => {
        const found = await current(session, input.scope, input.id);
        if (!found) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (found.version !== input.expectedVersion || found.definitionHash !== input.expectedDefinitionHash) throw new StorageError('CONFLICT', 'The record or its pinned definition changed after it was read; read it again and retry.');
        const next: AggregateDocument = { ...found, definitionHash: input.definitionHash, state: JSON.stringify(input.state), version: nextCounter(found.version, 1),
          eventSequence: nextCounter(found.eventSequence, input.events.length) };
        const updated = await aggregates.updateOne({ scope: input.scope, id: input.id, version: found.version, definitionHash: found.definitionHash },
          { $set: { definitionHash: next.definitionHash, state: next.state, version: next.version, eventSequence: next.eventSequence } }, { session });
        if (updated.matchedCount !== 1) throw new StorageError('CONFLICT', 'The record or its pinned definition changed after it was read; read it again and retry.');
        await append(session, input.scope, input.id, found.eventSequence, input.events);
        return record(next);
      });
    },
    events: async (scope, id, after = 0) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID'); cursor(after);
      try {
        const found = await events.find({ scope, aggregateId: id, sequence: { $gt: after } }, { projection: { _id: 0 } }).sort({ sequence: 1 }).limit(EVENT_PAGE_SIZE).toArray();
        return found.map((event): StoredEvent => ({ sequence: event.sequence, type: event.type, data: storedObject(JSON.parse(event.data)), createdAt: event.createdAt }));
      } catch (error) { throw safeFailure(error); }
    },
    close: () => {
      if (!closePromise) { closed = true; closePromise = (owned ? client.close() : Promise.resolve()).catch((error: unknown) => { throw safeFailure(error); }); }
      return closePromise;
    },
  };
}
