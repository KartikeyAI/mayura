import {
  StorageError, durableBudgetCommand, durableBudgetResult, durableBudgetSnapshot, workflowHashMaterial,
  type DurableBudgetKey, type DurableBudgetMethod, type DurableBudgetSnapshot, type StoredEvent, type StoredEventInput,
} from '@mayura/storage-contracts';
import { lockSql, storageClock, storedInteger } from './aggregate-session.js';
import { initialDurableBudgetState, reduceDurableBudgetState } from './durable-budget-state.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

interface RootRow {
  scope: string; id: string; policy_hash: string; format: number | string; mode: string; owner: string;
  version: number | string; event_sequence: number | string; state: string;
}
interface EventRow { sequence: number | string; type: string; data: string; created_at: string }
interface LockedBudget { snapshot: DurableBudgetSnapshot; clockFloor: number }
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
  constructor(private readonly backend: SchedulerBackend) {}

  /**
   * Internal trusted-host seam for later atomic execution integration. The caller
   * owns commit/rollback and must enter this root-first path before business locks.
   * Existing scheduled profiles do not use or gain protection from this seam.
   */
  inSession(tx: SchedulerSession): DurableBudgetDatabase {
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize durable budget storage before integrated use.');
    const scoped = new DurableBudgetDatabase({...this.backend,transaction:body => body(tx)});
    scoped.initialized = true; return scoped;
  }
  private table(events = false): string { return `${this.backend.prefix}mayura_durable_budget${events ? '_events' : 's'}`; }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.backend.transaction(async tx => {
      if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))',[`mayura:durable-budget-schema:${this.backend.prefix}`]);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table()} (
        scope TEXT NOT NULL,id TEXT NOT NULL,policy_hash TEXT NOT NULL,
        format INTEGER NOT NULL CHECK(format = 1),mode TEXT NOT NULL CHECK(mode = 'shared-ceiling-v1'),
        owner TEXT NOT NULL CHECK(owner = 'host-v1'),version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2048),
        event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 1 AND 2048),state TEXT NOT NULL,
        PRIMARY KEY(scope,id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table(true)} (
        scope TEXT NOT NULL,budget_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2048),
        type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(scope,budget_id,sequence),FOREIGN KEY(scope,budget_id) REFERENCES ${this.table()}(scope,id))`);
    });
    this.initialized = true;
  }
  private async lockIdentity(tx: SchedulerSession, key: DurableBudgetKey): Promise<void> {
    if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))',[
      JSON.stringify(['mayura:durable-budget-root:v1',this.backend.prefix,key.scope,key.id]),
    ]);
  }
  private event(row: EventRow, key: DurableBudgetKey): StoredEvent {
    try {
      const sequence = storedInteger(row.sequence);
      if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > 1_024) failed();
      const value = {sequence,type:row.type,data:JSON.parse(row.data) as unknown,createdAt:row.created_at};
      const checked = durableBudgetResult('events',[value],{scope:key.scope,id:key.id,policyHash:key.policyHash,after:sequence - 1}) as readonly StoredEvent[];
      if (checked.length !== 1 || canonical(checked[0]!.data) !== row.data) failed();
      return checked[0]!;
    } catch { return failed(); }
  }
  private async load(tx: SchedulerSession, key: DurableBudgetKey): Promise<LockedBudget | undefined> {
    const rows = await tx.query<RootRow>(`SELECT * FROM ${this.table()} WHERE scope = ? AND id = ?${lockSql(this.backend)}`,[key.scope,key.id]);
    const row = rows[0];
    if (!row) {
      if ((await tx.query(`SELECT sequence FROM ${this.table(true)} WHERE scope = ? AND budget_id = ? LIMIT 1`,[key.scope,key.id])).length) failed();
      return undefined;
    }
    if (rows.length !== 1) failed();
    let snapshot: DurableBudgetSnapshot;
    try {
      if (typeof row.state !== 'string' || Buffer.byteLength(row.state) > 1_048_576) failed();
      snapshot = durableBudgetSnapshot(JSON.parse(row.state));
      if (row.scope !== key.scope || row.id !== key.id || snapshot.scope !== row.scope || snapshot.id !== row.id
        || snapshot.policyHash !== row.policy_hash || snapshot.format !== storedInteger(row.format)
        || snapshot.mode !== row.mode || snapshot.owner !== row.owner || snapshot.version !== storedInteger(row.version)
        || snapshot.eventSequence !== storedInteger(row.event_sequence) || canonical(snapshot) !== row.state) failed();
    } catch { return failed(); }
    if (snapshot.policyHash !== key.policyHash) conflict();
    // Unique sequence keys plus count/min/max establish a contiguous bounded
    // journal. Decode only its tail here; events() validates each returned page.
    const [head] = await tx.query<{ count: number | string; first: number | string | null; last: number | string | null }>(
      `SELECT COUNT(*) AS count,MIN(sequence) AS first,MAX(sequence) AS last FROM ${this.table(true)} WHERE scope = ? AND budget_id = ?`,[key.scope,key.id]);
    if (!head || storedInteger(head.count) !== snapshot.eventSequence || head.first === null || storedInteger(head.first) !== 1
      || head.last === null || storedInteger(head.last) !== snapshot.eventSequence) failed();
    const tail = (await tx.query<EventRow>(`SELECT sequence,type,data,created_at FROM ${this.table(true)} WHERE scope = ? AND budget_id = ? ORDER BY sequence DESC LIMIT 1`,[key.scope,key.id]))[0];
    if (!tail) failed();
    const event = this.event(tail,key);
    if (event.sequence !== snapshot.eventSequence) failed();
    return {snapshot,clockFloor:Date.parse(event.createdAt)};
  }
  private async append(tx: SchedulerSession, snapshot: DurableBudgetSnapshot, event: StoredEventInput, floor: number): Promise<void> {
    if (snapshot.eventSequence > MAX_EVENTS) failed();
    const createdAt = new Date(await storageClock(tx,this.backend,floor)).toISOString();
    const row: EventRow = {sequence:snapshot.eventSequence,type:event.type,data:canonical(event.data),created_at:createdAt};
    this.event(row,snapshot);
    await tx.query(`INSERT INTO ${this.table(true)} (scope,budget_id,sequence,type,data,created_at) VALUES (?,?,?,?,?,?)`,
      [snapshot.scope,snapshot.id,row.sequence,row.type,row.data,row.created_at]);
  }
  async execute(method: DurableBudgetMethod, value: unknown): Promise<unknown> {
    const command = durableBudgetCommand(method,value);
    if (method === 'initialize') return this.initialize();
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED','Initialize durable budget storage first.');
    const key: DurableBudgetKey = {scope:command['scope'] as string,id:command['id'] as string,policyHash:command['policyHash'] as string};
    return this.backend.transaction(async tx => {
      await this.lockIdentity(tx,key);
      const current = await this.load(tx,key);
      if (method === 'create') {
        if (current) {
          const root = current.snapshot.accounts.find(account => account.id === 'root');
          if (!root || root.maxCostMicros !== command['maxCostMicros'] || root.maxCalls !== command['maxCalls']) conflict();
          return {snapshot:current.snapshot,created:false};
        }
        const snapshot = initialDurableBudgetState(command);
        await tx.query(`INSERT INTO ${this.table()} (scope,id,policy_hash,format,mode,owner,version,event_sequence,state) VALUES (?,?,?,?,?,?,?,?,?)`,
          [key.scope,key.id,key.policyHash,snapshot.format,snapshot.mode,snapshot.owner,snapshot.version,snapshot.eventSequence,canonical(snapshot)]);
        await this.append(tx,snapshot,{type:'budget.created',data:{}},0);
        return {snapshot,created:true};
      }
      if (method === 'inspect') return current?.snapshot;
      if (!current) missing();
      if (method === 'events') {
        const after = command['after'] as number;
        const rows = await tx.query<EventRow>(`SELECT sequence,type,data,created_at FROM ${this.table(true)} WHERE scope = ? AND budget_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000`,[key.scope,key.id,after]);
        const events = rows.map(row => this.event(row,key));
        if (events.length !== Math.min(1_000,Math.max(0,current.snapshot.eventSequence - after))) failed();
        return durableBudgetResult('events',events,command);
      }
      const result = reduceDurableBudgetState(current.snapshot,method,command);
      if (result.changed) {
        if (!result.event || result.snapshot.version !== current.snapshot.version + 1 || result.snapshot.eventSequence !== current.snapshot.eventSequence + 1) failed();
        const rows = await tx.query<RootRow>(`UPDATE ${this.table()} SET state = ?,version = ?,event_sequence = ? WHERE scope = ? AND id = ? RETURNING *`,
          [canonical(result.snapshot),result.snapshot.version,result.snapshot.eventSequence,key.scope,key.id]);
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
