import {
  StorageError, durableBudgetCommand, durableBudgetResult, durableBudgetSnapshot, workflowHashMaterial,
  type DurableBudgetKey, type DurableBudgetMethod, type DurableBudgetSnapshot, type StoredEvent, type StoredEventInput, type WorkflowTreeBudgetSnapshot,
} from '@mayura/storage-contracts';
import { storedInteger } from './aggregate-session.js';
import {
  initialDurableBudgetState, initialWorkflowTreeBudgetState,
  reduceDurableBudgetState, reduceWorkflowTreeBudgetState,
} from './durable-budget-state.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';
import { utf8ByteLength } from '@mayura/core/host';
import { sqlDurableBudgetPersistence, sqlDurableBudgetTransaction, type BudgetEventRow, type BudgetLedger, type DurableBudgetPersistence, type DurableBudgetTransaction } from './durable-budget-persistence.js';

type BudgetOwner = 'host-v1' | 'workflow-tree-v1';
type BudgetSnapshot = DurableBudgetSnapshot | WorkflowTreeBudgetSnapshot;
interface BudgetProfile { readonly owner: BudgetOwner; readonly tables: BudgetLedger }
interface LockedBudget { snapshot: BudgetSnapshot; clockFloor: number }
const MAX_EVENTS = 2_048;
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE','Stored durable budget failed integrity validation.'); }
function conflict(): never { throw new StorageError('CONFLICT','The durable budget identity or configuration does not match.'); }
function missing(): never { throw new StorageError('NOT_FOUND','Durable budget was not found in this scope.'); }
function canonical(value: unknown): string {
  const material = workflowHashMaterial('mayura:durable-budget-state:v1',value);
  return material.slice(material.indexOf('\n') + 1);
}

/** Root-serialized financial reducer; no execution callback or nested transaction is admitted. */
export class DurableBudgetDatabase {
  private initialized = false;
  private readonly persistence: DurableBudgetPersistence;
  private readonly sql: SchedulerBackend | undefined;
  constructor(backend: SchedulerBackend | DurableBudgetPersistence) {
    this.sql = 'dialect' in backend ? backend : undefined;
    this.persistence = 'dialect' in backend ? sqlDurableBudgetPersistence(backend) : backend;
  }
  protected budgetProfile(): BudgetProfile { return HOST_PROFILE; }

  /**
   * Internal trusted-host seam for later atomic execution integration. The caller
   * owns commit/rollback and must enter this root-first path before business locks.
   * Existing scheduled profiles do not use or gain protection from this seam.
   */
  inSession(tx: SchedulerSession | DurableBudgetTransaction): DurableBudgetDatabase {
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize durable budget storage before integrated use.');
    let transaction: DurableBudgetTransaction;
    if ('query' in tx) { if (!this.sql) failed(); transaction = sqlDurableBudgetTransaction(this.sql, tx); } else transaction = tx;
    const within: DurableBudgetPersistence = { initialize: async () => {}, transaction: body => body(transaction) };
    const scoped = this.budgetProfile().owner === 'host-v1'
      ? new DurableBudgetDatabase(within)
      : new WorkflowTreeBudgetDatabase(within);
    scoped.initialized = true; return scoped;
  }
  private get ledger(): BudgetLedger { return this.budgetProfile().tables; }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.persistence.initialize(this.ledger, this.budgetProfile().owner);
    this.initialized = true;
  }
  private event(row: BudgetEventRow, key: DurableBudgetKey): StoredEvent {
    try {
      const sequence = storedInteger(row.sequence);
      if (typeof row.data !== 'string' || utf8ByteLength(row.data) > 1_024) failed();
      const value = {sequence,type:row.type,data:JSON.parse(row.data) as unknown,createdAt:row.created_at};
      const checked = durableBudgetResult('events',[value],{scope:key.scope,id:key.id,policyHash:key.policyHash,after:sequence - 1}) as readonly StoredEvent[];
      if (checked.length !== 1 || canonical(checked[0]!.data) !== row.data) failed();
      return checked[0]!;
    } catch { return failed(); }
  }
  private async load(tx: DurableBudgetTransaction, key: DurableBudgetKey): Promise<LockedBudget | undefined> {
    const rows = await tx.budgetRoots(this.ledger,key.scope,key.id);
    const row = rows[0];
    if (!row) {
      if (await tx.budgetHasEvents(this.ledger,key.scope,key.id)) failed();
      return undefined;
    }
    if (rows.length !== 1) failed();
    let snapshot: BudgetSnapshot;
    try {
      if (typeof row.state !== 'string' || utf8ByteLength(row.state) > 1_048_576) failed();
      const parsed = JSON.parse(row.state) as Record<string, unknown>;
      snapshot = this.budgetProfile().owner === 'host-v1' ? durableBudgetSnapshot(parsed) : workflowTreeBudgetSnapshot(parsed);
      if (row.scope !== key.scope || row.id !== key.id || snapshot.scope !== row.scope || snapshot.id !== row.id
        || snapshot.policyHash !== row.policy_hash || snapshot.format !== storedInteger(row.format)
        || snapshot.mode !== row.mode || snapshot.owner !== row.owner || snapshot.version !== storedInteger(row.version)
        || snapshot.eventSequence !== storedInteger(row.event_sequence) || canonical(snapshot) !== row.state) failed();
    } catch { return failed(); }
    if (snapshot.policyHash !== key.policyHash) conflict();
    // Unique sequence keys plus count/min/max establish a contiguous bounded
    // journal. Decode only its tail here; events() validates each returned page.
    const head = await tx.budgetJournal(this.ledger,key.scope,key.id);
    if (!head || storedInteger(head.count) !== snapshot.eventSequence || head.first === null || storedInteger(head.first) !== 1
      || head.last === null || storedInteger(head.last) !== snapshot.eventSequence) failed();
    const tail = await tx.budgetLastEvent(this.ledger,key.scope,key.id);
    if (!tail) failed();
    const event = this.event(tail,key);
    if (event.sequence !== snapshot.eventSequence) failed();
    return {snapshot,clockFloor:Date.parse(event.createdAt)};
  }
  private async append(tx: DurableBudgetTransaction, snapshot: BudgetSnapshot, event: StoredEventInput, floor: number): Promise<void> {
    if (snapshot.eventSequence > MAX_EVENTS) failed();
    const createdAt = new Date(Math.max(floor, storedInteger(await tx.clock()))).toISOString();
    const row: BudgetEventRow = {sequence:snapshot.eventSequence,type:event.type,data:canonical(event.data),created_at:createdAt};
    this.event(row,snapshot);
    await tx.insertBudgetEvent(this.ledger,snapshot.scope,snapshot.id,row);
  }
  async execute(method: DurableBudgetMethod, value: unknown): Promise<unknown> {
    const command = durableBudgetCommand(method,value);
    if (method === 'initialize') return this.initialize();
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize durable budget storage first.');
    const key: DurableBudgetKey = {scope:command['scope'] as string,id:command['id'] as string,policyHash:command['policyHash'] as string};
    return this.persistence.transaction(async tx => {
      await tx.lockBudgetIdentity(this.ledger,this.budgetProfile().owner,key.scope,key.id);
      const current = await this.load(tx,key);
      if (method === 'create') {
        if (current) {
          const root = current.snapshot.accounts.find(account => account.id === 'root');
          if (!root || root.maxCostMicros !== command['maxCostMicros'] || root.maxCalls !== command['maxCalls']) conflict();
          return {snapshot:current.snapshot,created:false};
        }
        const snapshot = this.budgetProfile().owner === 'host-v1' ? initialDurableBudgetState(command) : initialWorkflowTreeBudgetState(command);
        await tx.insertBudgetRoot(this.ledger,{scope:key.scope,id:key.id,policy_hash:key.policyHash,format:snapshot.format,mode:snapshot.mode,owner:snapshot.owner,
          version:snapshot.version,event_sequence:snapshot.eventSequence,state:canonical(snapshot)});
        await this.append(tx,snapshot,{type:'budget.created',data:{}},0);
        return {snapshot,created:true};
      }
      if (method === 'inspect') return current?.snapshot;
      if (!current) missing();
      if (method === 'events') {
        const after = command['after'] as number;
        const rows = await tx.budgetEvents(this.ledger,key.scope,key.id,after);
        const events = rows.map(row => this.event(row,key));
        if (events.length !== Math.min(1_000,Math.max(0,current.snapshot.eventSequence - after))) failed();
        return durableBudgetResult('events',events,command);
      }
      const result = this.budgetProfile().owner === 'host-v1'
        ? reduceDurableBudgetState(current.snapshot as DurableBudgetSnapshot,method,command)
        : reduceWorkflowTreeBudgetState(current.snapshot as WorkflowTreeBudgetSnapshot,method,command);
      if (result.changed) {
        if (!result.event || result.snapshot.version !== current.snapshot.version + 1 || result.snapshot.eventSequence !== current.snapshot.eventSequence + 1) failed();
        const rows = await tx.updateBudgetRoot(this.ledger,key.scope,key.id,canonical(result.snapshot),result.snapshot.version,result.snapshot.eventSequence);
        if (rows.length !== 1) failed();
        await this.append(tx,result.snapshot,result.event,current.clockFloor);
      }
      if (method === 'start') return {snapshot:result.snapshot,status:result.startStatus};
      // An overrun is committed evidence, never an exception that rolls back charges.
      if (method === 'settle') return {snapshot:result.snapshot,overrun:result.overrun};
      return result.snapshot;
    });
  }
}

const HOST_PROFILE: BudgetProfile = Object.freeze({ owner: 'host-v1', tables: 'durable_budget' });
const WORKFLOW_TREE_PROFILE: BudgetProfile = Object.freeze({ owner: 'workflow-tree-v1', tables: 'workflow_tree_budget' });

function workflowTreeBudgetSnapshot(raw: unknown): WorkflowTreeBudgetSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>)['owner'] !== 'workflow-tree-v1') failed();
  const host = durableBudgetSnapshot({ ...(raw as Record<string, unknown>), owner: 'host-v1' });
  return Object.freeze({ ...host, owner: 'workflow-tree-v1' });
}

/** Fixed scheduler-owned ledger; intentionally has no public storage facade. */
export class WorkflowTreeBudgetDatabase extends DurableBudgetDatabase {
  protected override budgetProfile(): BudgetProfile { return WORKFLOW_TREE_PROFILE; }
}
