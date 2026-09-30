import type { ClientSession, Collection, Db, Document } from 'mongodb';
import type { BudgetEventRow, BudgetLedger, BudgetRootRow, DurableBudgetPersistence, DurableBudgetTransaction } from 'mayura/storage-sql/host';
import type { Transaction } from './memory.js';
import { serverClockOffset, touch } from './scheduler.js';

interface RootDocument { scope: string; id: string; policyHash: string; format: number; mode: string; owner: string; version: number; eventSequence: number; state: string }
interface EventDocument { scope: string; budgetId: string; sequence: number; type: string; data: string; createdAt: string }

const noId = { projection: { _id: 0, mayuraLocks: 0 } } as const;
const collections = (db: Db, ledger: BudgetLedger) => ({
  roots: db.collection(`mayura_${ledger}s`) as Collection<RootDocument>,
  events: db.collection(`mayura_${ledger}_events`) as Collection<EventDocument>,
});
function root(document: RootDocument): BudgetRootRow {
  return { scope: document.scope, id: document.id, policy_hash: document.policyHash, format: document.format, mode: document.mode, owner: document.owner,
    version: document.version, event_sequence: document.eventSequence, state: document.state };
}
function event(document: EventDocument): BudgetEventRow {
  return { sequence: document.sequence, type: document.type, data: document.data, created_at: document.createdAt };
}

/** Durable budget ledgers in MongoDB: each budget's root document and its journal. Documents name fields in camelCase. */
export function mongoBudgetPersistence(db: Db, transaction: Transaction): DurableBudgetPersistence {
  return {
    initialize: async ledger => {
      const { roots, events } = collections(db, ledger);
      await roots.createIndexes([{ key: { scope: 1, id: 1 }, name: `mayura_${ledger}s_id`, unique: true }]);
      await events.createIndexes([{ key: { scope: 1, budgetId: 1, sequence: 1 }, name: `mayura_${ledger}_events_sequence`, unique: true }]);
    },
    transaction: async body => { const skew = await serverClockOffset(db); return transaction(session => body(mongoBudgetRows(db, session, skew))); },
  };
}

export function mongoBudgetRows(db: Db, session: ClientSession, skew: number): DurableBudgetTransaction {
  const locks: Collection<{ _id: string; writes: number }> = db.collection('mayura_locks');
  return {
    clock: async () => Date.now() + skew,
    lockBudgetIdentity: async (_ledger, owner, scope, id) => {
      await locks.updateOne({ _id: JSON.stringify(['mayura:durable-budget-root:v1', owner, scope, id]) }, { $inc: { writes: 1 } }, { upsert: true, session });
    },
    budgetRoots: async (ledger, scope, id) => {
      const { roots } = collections(db, ledger);
      if (!await touch(roots as unknown as Collection<Document>, { scope, id }, session)) return [];
      return (await roots.find({ scope, id }, { ...noId, session }).limit(2).toArray()).map(root);
    },
    insertBudgetRoot: async (ledger, row) => {
      await collections(db, ledger).roots.insertOne({ scope: row.scope, id: row.id, policyHash: row.policy_hash, format: Number(row.format), mode: row.mode, owner: row.owner,
        version: Number(row.version), eventSequence: Number(row.event_sequence), state: row.state }, { session });
    },
    updateBudgetRoot: async (ledger, scope, id, state, version, eventSequence) => {
      const updated = await collections(db, ledger).roots.findOneAndUpdate({ scope, id }, { $set: { state, version, eventSequence } }, { ...noId, returnDocument: 'after', session });
      return updated ? [root(updated)] : [];
    },
    budgetHasEvents: async (ledger, scope, id) => (await collections(db, ledger).events.findOne({ scope, budgetId: id }, { projection: { _id: 1 }, session })) !== null,
    budgetJournal: async (ledger, scope, id) => {
      const [head] = await collections(db, ledger).events.aggregate<{ count: number; first: number; last: number }>([{ $match: { scope, budgetId: id } },
        { $group: { _id: null, count: { $sum: 1 }, first: { $min: '$sequence' }, last: { $max: '$sequence' } } }], { session }).toArray();
      return head ? { count: head.count, first: head.first, last: head.last } : { count: 0, first: null, last: null };
    },
    budgetLastEvent: async (ledger, scope, id) => {
      const last = await collections(db, ledger).events.find({ scope, budgetId: id }, { ...noId, session }).sort({ sequence: -1 }).limit(1).next();
      return last ? event(last) : undefined;
    },
    budgetEvents: async (ledger, scope, id, after) => (await collections(db, ledger).events.find({ scope, budgetId: id, sequence: { $gt: after } }, { ...noId, session })
      .sort({ sequence: 1 }).limit(1_000).toArray()).map(event),
    insertBudgetEvent: async (ledger, scope, id, row) => {
      await collections(db, ledger).events.insertOne({ scope, budgetId: id, sequence: Number(row.sequence), type: row.type, data: row.data, createdAt: row.created_at }, { session });
    },
  };
}
