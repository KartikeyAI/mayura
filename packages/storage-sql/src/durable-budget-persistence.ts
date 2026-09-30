import { lockSql } from './aggregate-session.js';
import { advisoryLock, clockSql, updateReturning } from './dialect.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

/** Which ledger: budgets the host owns, or those a workflow tree owns. Each keeps its own rows. */
export type BudgetLedger = 'durable_budget' | 'workflow_tree_budget';
export interface BudgetRootRow {
  scope: string; id: string; policy_hash: string; format: number | string; mode: string; owner: string;
  version: number | string; event_sequence: number | string; state: string;
}
export interface BudgetEventRow { sequence: number | string; type: string; data: string; created_at: string }

/** The reads and writes the durable budget reducer makes inside one transaction. */
export interface DurableBudgetTransaction {
  /** The store's current time in milliseconds. */
  clock(): Promise<number>;
  /** Serializes one budget identity, even before its root exists. */
  lockBudgetIdentity(ledger: BudgetLedger, owner: string, scope: string, id: string): Promise<void>;
  /** The budget's root rows (at most one), locked until the transaction ends. */
  budgetRoots(ledger: BudgetLedger, scope: string, id: string): Promise<BudgetRootRow[]>;
  insertBudgetRoot(ledger: BudgetLedger, row: BudgetRootRow): Promise<void>;
  /** Writes the root's next state; returns the rows written (one). */
  updateBudgetRoot(ledger: BudgetLedger, scope: string, id: string, state: string, version: number, eventSequence: number): Promise<BudgetRootRow[]>;
  /** Whether any journal event exists for the budget. */
  budgetHasEvents(ledger: BudgetLedger, scope: string, id: string): Promise<boolean>;
  /** The journal's event count and its lowest and highest sequence. */
  budgetJournal(ledger: BudgetLedger, scope: string, id: string): Promise<{ count: number | string; first: number | string | null; last: number | string | null } | undefined>;
  budgetLastEvent(ledger: BudgetLedger, scope: string, id: string): Promise<BudgetEventRow | undefined>;
  /** Up to 1,000 events after `after`, in sequence order. */
  budgetEvents(ledger: BudgetLedger, scope: string, id: string, after: number): Promise<BudgetEventRow[]>;
  insertBudgetEvent(ledger: BudgetLedger, scope: string, id: string, event: BudgetEventRow): Promise<void>;
}
export interface DurableBudgetPersistence {
  initialize(ledger: BudgetLedger, owner: string): Promise<void>;
  transaction<T>(body: (tx: DurableBudgetTransaction) => Promise<T>): Promise<T>;
}

/** The budget rows in the SQL layer's tables: the SQL every SQL adapter has always run for them. */
export function sqlDurableBudgetTransaction(backend: SchedulerBackend, tx: SchedulerSession): DurableBudgetTransaction {
  const table = (ledger: BudgetLedger, events = false) => `${backend.prefix}mayura_${ledger}${events ? '_events' : 's'}`;
  return {
    clock: async () => Number((await tx.query<{ now_ms: number | string }>(clockSql(backend)))[0]?.now_ms),
    lockBudgetIdentity: (_ledger, owner, scope, id) => advisoryLock(tx, backend, JSON.stringify(['mayura:durable-budget-root:v1',owner,backend.prefix,scope,id])),
    budgetRoots: async (ledger, scope, id) => [...await tx.query<BudgetRootRow>(`SELECT * FROM ${table(ledger)} WHERE scope = ? AND id = ?${lockSql(backend)}`,[scope,id])],
    insertBudgetRoot: async (ledger, row) => {
      await tx.query(`INSERT INTO ${table(ledger)} (scope,id,policy_hash,format,mode,owner,version,event_sequence,state) VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.scope,row.id,row.policy_hash,row.format,row.mode,row.owner,row.version,row.event_sequence,row.state]);
    },
    updateBudgetRoot: async (ledger, scope, id, state, version, eventSequence) => [...await updateReturning<BudgetRootRow>(tx,backend,`UPDATE ${table(ledger)} SET state = ?,version = ?,event_sequence = ? WHERE scope = ? AND id = ?`,
      [state,version,eventSequence,scope,id],'*',`SELECT * FROM ${table(ledger)} WHERE scope = ? AND id = ?`,[scope,id])],
    budgetHasEvents: async (ledger, scope, id) => (await tx.query(`SELECT sequence FROM ${table(ledger,true)} WHERE scope = ? AND budget_id = ? LIMIT 1`,[scope,id])).length > 0,
    budgetJournal: async (ledger, scope, id) => (await tx.query<{ count: number | string; first: number | string | null; last: number | string | null }>(
      `SELECT COUNT(*) AS count,MIN(sequence) AS first,MAX(sequence) AS last FROM ${table(ledger,true)} WHERE scope = ? AND budget_id = ?`,[scope,id]))[0],
    budgetLastEvent: async (ledger, scope, id) => (await tx.query<BudgetEventRow>(`SELECT sequence,type,data,created_at FROM ${table(ledger,true)} WHERE scope = ? AND budget_id = ? ORDER BY sequence DESC LIMIT 1`,[scope,id]))[0],
    budgetEvents: async (ledger, scope, id, after) => [...await tx.query<BudgetEventRow>(`SELECT sequence,type,data,created_at FROM ${table(ledger,true)} WHERE scope = ? AND budget_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000`,[scope,id,after])],
    insertBudgetEvent: async (ledger, scope, id, event) => {
      await tx.query(`INSERT INTO ${table(ledger,true)} (scope,budget_id,sequence,type,data,created_at) VALUES (?,?,?,?,?,?)`,
        [scope,id,event.sequence,event.type,event.data,event.created_at]);
    },
  };
}

/** The SQL layer's budget tables on a backend. */
export function sqlDurableBudgetPersistence(backend: SchedulerBackend): DurableBudgetPersistence {
  const table = (ledger: BudgetLedger, events = false) => `${backend.prefix}mayura_${ledger}${events ? '_events' : 's'}`;
  return {
    transaction: body => backend.transaction(tx => body(sqlDurableBudgetTransaction(backend, tx))),
    initialize: (ledger, owner) => backend.transaction(async tx => {
      await advisoryLock(tx,backend,`mayura:durable-budget-schema:${backend.prefix}`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table(ledger)} (
        scope TEXT NOT NULL,id TEXT NOT NULL,policy_hash TEXT NOT NULL,
        format INTEGER NOT NULL CHECK(format = 1),mode TEXT NOT NULL CHECK(mode = 'shared-ceiling-v1'),
        owner TEXT NOT NULL CHECK(owner = '${owner}'),version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2048),
        event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 1 AND 2048),state TEXT NOT NULL,
        PRIMARY KEY(scope,id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table(ledger,true)} (
        scope TEXT NOT NULL,budget_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2048),
        type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(scope,budget_id,sequence),FOREIGN KEY(scope,budget_id) REFERENCES ${table(ledger)}(scope,id))`);
    }),
  };
}
