import { createHash } from 'node:crypto';
import {
  executionWaitCommand, executionWaitHashMaterial, executionWaitSnapshot,
  type ExecutionCompletion, type ExecutionRef, type ExecutionWaitMethod, type ExecutionWaitSnapshot,
  type ExecutionWaitStreamKey,
} from '@mayura/storage-contracts';
import { StorageError, type StoredEvent } from './contracts.js';
import { lockSql, storageClock, storedInteger } from './aggregate-session.js';
import { completionJson, readCompletion } from './execution-completions.js';
import { identifier } from './validation.js';
import type { ScheduledWorkflowDatabase } from './scheduled-database.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

interface StreamRow { scope: string; stream_id: string; policy_hash: string; format: number; wait_count: number | string; event_sequence: number | string }
interface WaitRow { scope: string; stream_id: string; wait_id: string; version: number | string; status: string; registration_sequence: number | string; definition_hash: string; data: string }
interface TargetRow { scope: string; stream_id: string; wait_id: string; ordinal: number; run_id: string; definition_hash: string; policy_hash: string }
interface EventRow { sequence: number | string; type: string; data: string; created_at: string }
interface Stream { key: ExecutionWaitStreamKey; row: StreamRow; events: StoredEvent[] }
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored execution wait failed integrity validation.'); }
function conflict(): never { throw new StorageError('CONFLICT', 'Execution wait identity or policy does not match.'); }
function digest(key: ExecutionWaitStreamKey, id: string, targets: readonly ExecutionRef[]): string {
  return createHash('sha256').update(executionWaitHashMaterial(key, id, targets)).digest('hex');
}

/** Finite metadata reducer. No workflow locks are acquired while a stream row is held. */
export class ExecutionWaitDatabase {
  private initialized = false;
  constructor(private readonly backend: SchedulerBackend, private readonly workflows: ScheduledWorkflowDatabase) {}
  private table(name: 'streams' | 'waits' | 'wait_targets' | 'wait_events'): string { return `${this.backend.prefix}mayura_execution_${name}`; }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.workflows.execute('initialize', {});
    await this.backend.transaction(async tx => {
      if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`mayura:execution-wait-schema:${this.backend.prefix}`]);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table('streams')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, policy_hash TEXT NOT NULL, format INTEGER NOT NULL CHECK(format = 1),
        wait_count INTEGER NOT NULL CHECK(wait_count BETWEEN 0 AND 128), event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 0 AND 257),
        PRIMARY KEY(scope,stream_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table('waits')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, wait_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2),
        status TEXT NOT NULL, registration_sequence INTEGER NOT NULL CHECK(registration_sequence BETWEEN 2 AND 257), definition_hash TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(scope,stream_id,wait_id), UNIQUE(scope,stream_id,registration_sequence),
        FOREIGN KEY(scope,stream_id) REFERENCES ${this.table('streams')}(scope,stream_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table('wait_targets')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, wait_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
        run_id TEXT NOT NULL, definition_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
        PRIMARY KEY(scope,stream_id,wait_id,ordinal), UNIQUE(scope,stream_id,wait_id,run_id),
        FOREIGN KEY(scope,stream_id,wait_id) REFERENCES ${this.table('waits')}(scope,stream_id,wait_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${this.table('wait_events')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 257),
        type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,stream_id,sequence),
        FOREIGN KEY(scope,stream_id) REFERENCES ${this.table('streams')}(scope,stream_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_execution_waits_ready ON ${this.table('waits')}(scope,stream_id,status,registration_sequence)`);
    });
    this.initialized = true;
  }
  /** The bounded journal independently checks stream counters and registration/terminal transitions. */
  private async stream(tx: SchedulerSession, key: ExecutionWaitStreamKey): Promise<Stream> {
    const row = (await tx.query<StreamRow>(`SELECT * FROM ${this.table('streams')} WHERE scope = ? AND stream_id = ?${lockSql(this.backend)}`, [key.scope, key.streamId]))[0];
    if (!row) throw new StorageError('NOT_FOUND', 'Execution stream was not found in this scope.');
    if (row.policy_hash !== key.policyHash) conflict();
    try {
      const count = storedInteger(row.wait_count); const head = storedInteger(row.event_sequence);
      if (row.scope !== key.scope || row.stream_id !== key.streamId || row.format !== 1 || count > 128 || head < 1 || head > 257) failed();
      const waits = await tx.query<WaitRow>(`SELECT * FROM ${this.table('waits')} WHERE scope = ? AND stream_id = ? LIMIT 129`, [key.scope, key.streamId]);
      if (waits.length !== count) failed();
      const rows = await tx.query<EventRow>(`SELECT sequence,type,data,created_at FROM ${this.table('wait_events')} WHERE scope = ? AND stream_id = ? ORDER BY sequence LIMIT 258`, [key.scope, key.streamId]);
      if (rows.length !== head) failed();
      const events: StoredEvent[] = []; const registered = new Set<string>(); const terminal = new Set<string>();
      for (const [index, event] of rows.entries()) {
        if (storedInteger(event.sequence) !== index + 1 || typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1024
          || typeof event.created_at !== 'string' || new Date(event.created_at).toISOString() !== event.created_at
          || (index > 0 && event.created_at < rows[index - 1]!.created_at)) failed();
        const data: unknown = JSON.parse(event.data);
        if (event.data !== completionJson(data) || data === null || typeof data !== 'object' || Array.isArray(data)) failed();
        if (index === 0) {
          if (event.type !== 'stream.created' || Object.keys(data).length !== 0) failed();
        } else {
          if (Object.keys(data).length !== 1 || !Object.hasOwn(data, 'waitId')) failed();
          const id = identifier((data as { waitId: unknown }).waitId, 'Stored wait'); if (id.length > 128) failed();
          if (event.type === 'wait.registered') { if (registered.has(id)) failed(); registered.add(id); }
          else if (event.type === 'wait.resolved' || event.type === 'wait.cancelled') {
            if (!registered.has(id) || terminal.has(id)) failed(); terminal.add(id);
          } else failed();
        }
        events.push({ sequence: index + 1, type: event.type, data: data as StoredEvent['data'], createdAt: event.created_at });
      }
      if (registered.size !== count) failed();
      // Journal reads are public too: never disclose a terminal label contradicted by its snapshot.
      for (const wait of waits) {
        const snapshot = this.decodeWait(wait, key);
        const registration = events.find(event => event.type === 'wait.registered' && event.data['waitId'] === wait.wait_id);
        const terminalEvent = events.find(event => event.type !== 'wait.registered' && event.data['waitId'] === wait.wait_id);
        if (registration?.sequence !== storedInteger(wait.registration_sequence)
          || (snapshot.status === 'waiting' ? terminalEvent !== undefined : terminalEvent?.type !== `wait.${snapshot.status}`)) failed();
      }
      return { key, row, events };
    } catch { return failed(); }
  }
  private async append(tx: SchedulerSession, stream: Stream, type: string, id?: string): Promise<void> {
    const sequence = storedInteger(stream.row.event_sequence) + 1; if (sequence > 257) failed();
    const floor = stream.events.length ? Date.parse(stream.events[stream.events.length - 1]!.createdAt) : 0;
    const createdAt = new Date(await storageClock(tx, this.backend, floor)).toISOString();
    const data = id === undefined ? {} : { waitId: id };
    await tx.query(`INSERT INTO ${this.table('wait_events')} (scope,stream_id,sequence,type,data,created_at) VALUES (?,?,?,?,?,?)`,
      [stream.key.scope, stream.key.streamId, sequence, type, completionJson(data), createdAt]);
    await tx.query(`UPDATE ${this.table('streams')} SET event_sequence = ? WHERE scope = ? AND stream_id = ?`, [sequence, stream.key.scope, stream.key.streamId]);
    stream.row.event_sequence = sequence; stream.events.push({ sequence, type, data, createdAt });
  }
  private async facts(tx: SchedulerSession, key: ExecutionWaitStreamKey, targets: readonly ExecutionRef[]): Promise<ExecutionCompletion[] | undefined> {
    const observations: ExecutionCompletion[] = []; let ready = true;
    for (const target of targets) {
      const fact = await readCompletion(tx, this.backend, key.scope, target);
      if (fact) observations.push(fact); else ready = false;
    }
    return ready ? observations : undefined;
  }
  /** Validate bounded canonical snapshots independently of their target index and terminal journal. */
  private decodeWait(row: WaitRow, key: ExecutionWaitStreamKey): ExecutionWaitSnapshot {
    try {
      if (typeof row.data !== 'string' || Buffer.byteLength(row.data) > 65_536) failed();
      const value = executionWaitSnapshot(JSON.parse(row.data));
      if (row.scope !== key.scope || row.stream_id !== key.streamId || row.wait_id !== value.id
        || value.version !== storedInteger(row.version) || value.status !== row.status || value.definitionHash !== row.definition_hash
        || value.definitionHash !== digest(key, value.id, value.targets) || row.data !== completionJson(value)
        || value.targets.some(target => target.policyHash !== key.policyHash)) failed();
      return value;
    } catch { return failed(); }
  }
  private async wait(tx: SchedulerSession, stream: Stream, id: string): Promise<ExecutionWaitSnapshot | undefined> {
    const row = (await tx.query<WaitRow>(`SELECT * FROM ${this.table('waits')} WHERE scope = ? AND stream_id = ? AND wait_id = ?`, [stream.key.scope, stream.key.streamId, id]))[0];
    const registered = stream.events.find(event => event.type === 'wait.registered' && event.data['waitId'] === id);
    if (!row) { if (registered) failed(); return undefined; }
    try {
      const value = this.decodeWait(row, stream.key);
      if (value.id !== id || registered?.sequence !== storedInteger(row.registration_sequence)) failed();
      const terminal = stream.events.find(event => event.type !== 'wait.registered' && event.data['waitId'] === id);
      if ((value.status === 'waiting' && terminal) || (value.status !== 'waiting' && terminal?.type !== `wait.${value.status}`)) failed();
      const targets = await tx.query<TargetRow>(`SELECT * FROM ${this.table('wait_targets')} WHERE scope = ? AND stream_id = ? AND wait_id = ? ORDER BY ordinal LIMIT 33`, [stream.key.scope, stream.key.streamId, id]);
      if (targets.length !== value.targets.length || targets.some((target, index) => target.ordinal !== index || target.scope !== stream.key.scope
        || target.stream_id !== stream.key.streamId || target.wait_id !== id || target.run_id !== value.targets[index]!.runId
        || target.definition_hash !== value.targets[index]!.definitionHash || target.policy_hash !== value.targets[index]!.policyHash)) failed();
      if (value.status === 'resolved') {
        const observations = await this.facts(tx, stream.key, value.targets);
        if (!observations || completionJson(observations) !== completionJson(value.observations)) failed();
      }
      return value;
    } catch { return failed(); }
  }
  private async transition(tx: SchedulerSession, stream: Stream, current: ExecutionWaitSnapshot, status: 'resolved' | 'cancelled', observations: readonly ExecutionCompletion[] = []): Promise<ExecutionWaitSnapshot> {
    const next = executionWaitSnapshot({ ...current, version: 2, status, observations });
    await tx.query(`UPDATE ${this.table('waits')} SET version = ?, status = ?, data = ? WHERE scope = ? AND stream_id = ? AND wait_id = ?`,
      [next.version, next.status, completionJson(next), stream.key.scope, stream.key.streamId, next.id]);
    await this.append(tx, stream, `wait.${status}`, next.id); return next;
  }
  async execute(method: ExecutionWaitMethod, value: unknown): Promise<unknown> {
    const input = executionWaitCommand(method, value);
    if (method === 'initialize') return this.initialize();
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize execution wait storage first.');
    const scope = input['scope'] as string;
    if (method === 'materialize') return this.workflows.materializeCompletion(scope, input['reference'] as unknown as ExecutionRef);
    const key: ExecutionWaitStreamKey = { scope, streamId: input['streamId'] as string, policyHash: input['policyHash'] as string };
    const id = input['id'] as string; const targets = input['targets'] as unknown as readonly ExecutionRef[];
    if (method === 'register') {
      if (targets.some(target => target.policyHash !== key.policyHash)) conflict();
      // Validate every source first, in independent target-only transactions. Never nest workflow/stream locks.
      for (const target of targets) await this.workflows.materializeCompletion(scope, target);
    }
    return this.backend.transaction(async tx => {
      if (method === 'open') {
        if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [JSON.stringify(['mayura:execution-stream:v1', this.backend.prefix, scope, key.streamId])]);
        const found = await tx.query(`SELECT stream_id FROM ${this.table('streams')} WHERE scope = ? AND stream_id = ?`, [scope, key.streamId]);
        if (found.length) { await this.stream(tx, key); return; }
        await tx.query(`INSERT INTO ${this.table('streams')} (scope,stream_id,policy_hash,format,wait_count,event_sequence) VALUES (?,?,?,1,0,0)`, [scope, key.streamId, key.policyHash]);
        await this.append(tx, { key, row: { scope, stream_id: key.streamId, policy_hash: key.policyHash, format: 1, wait_count: 0, event_sequence: 0 }, events: [] }, 'stream.created'); return;
      }
      const stream = await this.stream(tx, key);
      if (method === 'events') return stream.events.filter(event => event.sequence > (input['after'] as number));
      if (method === 'register') {
        const existing = await this.wait(tx, stream, id); const definitionHash = digest(key, id, targets);
        if (existing) { if (existing.definitionHash !== definitionHash) conflict(); return existing; }
        const count = storedInteger(stream.row.wait_count);
        if (count >= 128) throw new StorageError('LIMIT_EXCEEDED', 'Execution stream lifetime wait capacity is exhausted.');
        const observations = await this.facts(tx, key, targets);
        const snapshot = executionWaitSnapshot({ id, version: 1, definitionHash, status: observations ? 'resolved' : 'waiting', targets, observations: observations ?? [] });
        await tx.query(`INSERT INTO ${this.table('waits')} (scope,stream_id,wait_id,version,status,registration_sequence,definition_hash,data) VALUES (?,?,?,1,?,?,?,?)`,
          [scope, key.streamId, id, snapshot.status, storedInteger(stream.row.event_sequence) + 1, definitionHash, completionJson(snapshot)]);
        for (const [ordinal, target] of targets.entries()) await tx.query(`INSERT INTO ${this.table('wait_targets')} (scope,stream_id,wait_id,ordinal,run_id,definition_hash,policy_hash) VALUES (?,?,?,?,?,?,?)`,
          [scope, key.streamId, id, ordinal, target.runId, target.definitionHash, target.policyHash]);
        await tx.query(`UPDATE ${this.table('streams')} SET wait_count = ? WHERE scope = ? AND stream_id = ?`, [count + 1, scope, key.streamId]);
        await this.append(tx, stream, 'wait.registered', id);
        if (observations) await this.append(tx, stream, 'wait.resolved', id);
        return snapshot;
      }
      if (method === 'inspect' || method === 'cancel') {
        const current = await this.wait(tx, stream, id);
        if (method === 'inspect') return current;
        if (!current) throw new StorageError('NOT_FOUND', 'Execution wait was not found in this stream.');
        return current.status === 'waiting' ? this.transition(tx, stream, current, 'cancelled') : current;
      }
      if (method === 'drainReady') {
        const ready = await tx.query<{ wait_id: string }>(`SELECT w.wait_id FROM ${this.table('waits')} w
          WHERE w.scope = ? AND w.stream_id = ? AND w.status = 'waiting'
          AND EXISTS (SELECT 1 FROM ${this.table('wait_targets')} t WHERE t.scope = w.scope AND t.stream_id = w.stream_id AND t.wait_id = w.wait_id)
          AND NOT EXISTS (SELECT 1 FROM ${this.table('wait_targets')} t WHERE t.scope = w.scope AND t.stream_id = w.stream_id AND t.wait_id = w.wait_id
            AND NOT EXISTS (SELECT 1 FROM ${this.backend.prefix}mayura_execution_completions c WHERE c.scope = t.scope AND c.run_id = t.run_id AND c.definition_hash = t.definition_hash AND c.policy_hash = t.policy_hash))
          ORDER BY w.registration_sequence LIMIT ?`, [scope, key.streamId, input['limit']]);
        const results: ExecutionWaitSnapshot[] = [];
        for (const item of ready) {
          const current = await this.wait(tx, stream, item.wait_id); if (!current || current.status !== 'waiting') failed();
          const observations = await this.facts(tx, key, current.targets); if (!observations) failed();
          results.push(await this.transition(tx, stream, current, 'resolved', observations));
        }
        return results;
      }
      throw new StorageError('INVALID_INPUT', 'Unknown execution wait command.');
    });
  }
}
