import type { BudgetEventRow, BudgetRootRow, DurableBudgetTransaction } from '../durable-budget-persistence.js';
import { key } from './keys.js';
import { at, json, sort } from './layout.js';
import type { DocumentSession } from './session.js';

/** A budget of one ledger: `r` the root, `e`+sequence its journal. */
const budget = (ledger: string, scope: string, id: string) => key('budget', ledger, scope, id);
const place = { root: key('r'), event: (sequence: number) => key('e', sequence) };
const events = key('e');

/** Durable budget rows as documents in one optimistic transaction. */
export function documentBudgetRows(session: DocumentSession): DurableBudgetTransaction {
  const journal = (ledger: string, scope: string, id: string, reverse: boolean) => session.query(budget(ledger, scope, id), { prefix: events, reverse, limit: 1 });
  return {
    clock: () => session.clock(),
    lockBudgetIdentity: async (ledger, owner, scope, id) => { await session.hold(at.lock('budget', ledger, owner, scope, id), sort.lock); },
    budgetRoots: async (ledger, scope, id) => { const root = json<BudgetRootRow>(await session.get(budget(ledger, scope, id), place.root, true)); return root ? [root] : []; },
    insertBudgetRoot: async (ledger, row) => { session.insert(budget(ledger, row.scope, row.id), place.root, JSON.stringify(row)); },
    updateBudgetRoot: async (ledger, scope, id, state, version, eventSequence) => {
      const root = json<BudgetRootRow>(await session.get(budget(ledger, scope, id), place.root)); if (!root) return [];
      const next: BudgetRootRow = { ...root, state, version, event_sequence: eventSequence };
      await session.put(budget(ledger, scope, id), place.root, JSON.stringify(next)); return [next];
    },
    budgetHasEvents: async (ledger, scope, id) => (await journal(ledger, scope, id, false)).length > 0,
    budgetJournal: async (ledger, scope, id) => {
      const count = await session.count(budget(ledger, scope, id), { prefix: events });
      const first = json<BudgetEventRow>((await journal(ledger, scope, id, false))[0]?.body); const last = json<BudgetEventRow>((await journal(ledger, scope, id, true))[0]?.body);
      return { count, first: first?.sequence ?? null, last: last?.sequence ?? null };
    },
    budgetLastEvent: async (ledger, scope, id) => json<BudgetEventRow>((await journal(ledger, scope, id, true))[0]?.body),
    budgetEvents: async (ledger, scope, id, after) => (await session.query(budget(ledger, scope, id), { prefix: events, after: place.event(after), limit: 1_000 }))
      .map(item => json<BudgetEventRow>(item.body)!),
    insertBudgetEvent: async (ledger, scope, id, event) => { session.insert(budget(ledger, scope, id), place.event(Number(event.sequence)), JSON.stringify(event)); },
  };
}
