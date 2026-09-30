import type { ClientSession, Collection, Db } from 'mongodb';
import {
  StorageError, storageError, durableBudgetResult, durableBudgetSnapshot, workflowHashMaterial,
  type DurableBudgetKey, type DurableBudgetMethod, type DurableBudgetSnapshot, type DurableBudgetStore, type StoredEvent, type StoredEventInput,
} from 'mayura/storage-contracts';
import { durableBudgetFacade, initialDurableBudgetState, reduceDurableBudgetState, type DurableBudgetMutation } from 'mayura/storage-sql/host';
import type { Transaction } from './memory.js';

interface RootDocument { scope: string; id: string; policyHash: string; format: number; mode: string; owner: string; version: number; eventSequence: number; state: string }
interface EventDocument { scope: string; budgetId: string; sequence: number; type: string; data: string; createdAt: string }

const MAX_EVENTS = 2_048;
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored durable budget failed integrity validation.'); }
function conflict(): never { throw new StorageError('CONFLICT', 'The durable budget identity or configuration does not match.'); }
function missing(): never { throw new StorageError('NOT_FOUND', 'Durable budget was not found in this scope.'); }
/** The state's canonical JSON text: the same bytes the SQL stores keep, so integrity checks compare exactly. */
function canonical(value: unknown): string {
  const material = workflowHashMaterial('mayura:durable-budget-state:v1', value);
  return material.slice(material.indexOf('\n') + 1);
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
const noId = { projection: { _id: 0 } } as const;

/**
 * Durable budgets on MongoDB, with the SQL stores' arithmetic (`reduceDurableBudgetState`) and integrity rules: the
 * root holds the canonical state, and a contiguous journal of at most 2,048 events is checked on every load. Writers to
 * one budget conflict on its root document, and the loser's transaction runs again.
 */
export function mongoBudgets(db: Db, transaction: Transaction, available: () => void): DurableBudgetStore {
  const roots: Collection<RootDocument> = db.collection('mayura_durable_budgets');
  const events: Collection<EventDocument> = db.collection('mayura_durable_budget_events');
  let initialized = false;

  const event = (row: EventDocument, key: DurableBudgetKey): StoredEvent => {
    try {
      if (typeof row.data !== 'string' || bytes(row.data) > 1_024) failed();
      const value = { sequence: row.sequence, type: row.type, data: JSON.parse(row.data) as unknown, createdAt: row.createdAt };
      const checked = durableBudgetResult('events', [value], { scope: key.scope, id: key.id, policyHash: key.policyHash, after: row.sequence - 1 }) as readonly StoredEvent[];
      if (checked.length !== 1 || canonical(checked[0]!.data) !== row.data) failed();
      return checked[0]!;
    } catch { return failed(); }
  };
  const load = async (session: ClientSession, key: DurableBudgetKey): Promise<{ snapshot: DurableBudgetSnapshot; clockFloor: number } | undefined> => {
    const row = await roots.findOne({ scope: key.scope, id: key.id }, { ...noId, session });
    if (!row) {
      if (await events.findOne({ scope: key.scope, budgetId: key.id }, { ...noId, session })) failed();
      return undefined;
    }
    let snapshot: DurableBudgetSnapshot;
    try {
      if (typeof row.state !== 'string' || bytes(row.state) > 1_048_576) failed();
      snapshot = durableBudgetSnapshot(JSON.parse(row.state) as Record<string, unknown>);
      if (snapshot.scope !== row.scope || snapshot.id !== row.id || snapshot.policyHash !== row.policyHash || snapshot.format !== row.format || snapshot.mode !== row.mode
        || snapshot.owner !== row.owner || snapshot.version !== row.version || snapshot.eventSequence !== row.eventSequence || canonical(snapshot) !== row.state) failed();
    } catch { return failed(); }
    if (snapshot.policyHash !== key.policyHash) conflict();
    // Unique sequences plus count, first and last make the journal contiguous; only its tail is decoded here.
    const [head] = await events.aggregate<{ count: number; first: number; last: number }>([{ $match: { scope: key.scope, budgetId: key.id } },
      { $group: { _id: null, count: { $sum: 1 }, first: { $min: '$sequence' }, last: { $max: '$sequence' } } }], { session }).toArray();
    if (!head || head.count !== snapshot.eventSequence || head.first !== 1 || head.last !== snapshot.eventSequence) failed();
    const tail = await events.find({ scope: key.scope, budgetId: key.id }, { ...noId, session }).sort({ sequence: -1 }).limit(1).next();
    if (!tail) failed();
    const last = event(tail, key);
    if (last.sequence !== snapshot.eventSequence) failed();
    return { snapshot, clockFloor: Date.parse(last.createdAt) };
  };
  /** Event times never go backwards, even if this host's clock does. */
  const append = async (session: ClientSession, snapshot: DurableBudgetSnapshot, input: StoredEventInput, floor: number): Promise<void> => {
    if (snapshot.eventSequence > MAX_EVENTS) failed();
    const row: EventDocument = { scope: snapshot.scope, budgetId: snapshot.id, sequence: snapshot.eventSequence, type: input.type, data: canonical(input.data),
      createdAt: new Date(Math.max(floor, Date.now())).toISOString() };
    event(row, snapshot);
    await events.insertOne({ ...row }, { session });
  };

  const execute = async (method: DurableBudgetMethod, command: Record<string, unknown>): Promise<unknown> => {
    const key: DurableBudgetKey = { scope: command['scope'] as string, id: command['id'] as string, policyHash: command['policyHash'] as string };
    return transaction(async session => {
      const current = await load(session, key);
      if (method === 'create') {
        if (current) {
          const root = current.snapshot.accounts.find(account => account.id === 'root');
          if (!root || root.maxCostMicros !== command['maxCostMicros'] || root.maxCalls !== command['maxCalls']) conflict();
          return { snapshot: current.snapshot, created: false };
        }
        const snapshot = initialDurableBudgetState(command);
        await roots.insertOne({ scope: key.scope, id: key.id, policyHash: key.policyHash, format: snapshot.format, mode: snapshot.mode, owner: snapshot.owner,
          version: snapshot.version, eventSequence: snapshot.eventSequence, state: canonical(snapshot) }, { session });
        await append(session, snapshot, { type: 'budget.created', data: {} }, 0);
        return { snapshot, created: true };
      }
      if (method === 'inspect') return current?.snapshot;
      if (!current) missing();
      if (method === 'events') {
        const after = command['after'] as number;
        const rows = await events.find({ scope: key.scope, budgetId: key.id, sequence: { $gt: after } }, { ...noId, session }).sort({ sequence: 1 }).limit(1_000).toArray();
        const found = rows.map(row => event(row, key));
        if (found.length !== Math.min(1_000, Math.max(0, current.snapshot.eventSequence - after))) failed();
        return durableBudgetResult('events', found, command);
      }
      const result = reduceDurableBudgetState(current.snapshot, method as DurableBudgetMutation, command);
      if (result.changed) {
        if (!result.event || result.snapshot.version !== current.snapshot.version + 1 || result.snapshot.eventSequence !== current.snapshot.eventSequence + 1) failed();
        const updated = await roots.updateOne({ scope: key.scope, id: key.id, version: current.snapshot.version },
          { $set: { state: canonical(result.snapshot), version: result.snapshot.version, eventSequence: result.snapshot.eventSequence } }, { session });
        if (updated.matchedCount !== 1) failed();
        await append(session, result.snapshot, result.event, current.clockFloor);
      }
      if (method === 'start') return { snapshot: result.snapshot, status: result.startStatus };
      // An overrun is committed evidence, never an exception that rolls back charges.
      if (method === 'settle') return { snapshot: result.snapshot, overrun: result.overrun };
      return result.snapshot;
    });
  };

  return durableBudgetFacade(async (method, input) => {
    available();
    try {
      if (method === 'initialize') {
        if (!initialized) {
          await roots.createIndexes([{ key: { scope: 1, id: 1 }, name: 'mayura_durable_budgets_id', unique: true }]);
          await events.createIndexes([{ key: { scope: 1, budgetId: 1, sequence: 1 }, name: 'mayura_durable_budget_events_sequence', unique: true }]);
          initialized = true;
        }
        return undefined;
      }
      if (!initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize durable budget storage first.');
      return await execute(method, input as Record<string, unknown>);
    } catch (error) { throw error instanceof StorageError ? error : storageError(error); }
  });
}
