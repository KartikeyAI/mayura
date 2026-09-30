import {
  executionWaitCommand, executionWaitHashMaterial, executionWaitSnapshot,
  type ExecutionCompletion, type ExecutionRef, type ExecutionWaitMethod, type ExecutionWaitSnapshot,
  type ExecutionWaitStreamKey,
} from '@mayura/storage-contracts';
import { StorageError, type StoredEvent } from './contracts.js';
import { storedInteger } from './aggregate-session.js';
import { completionJson, completionOf } from './execution-completions.js';
import { identifier } from './validation.js';
import type { ScheduledWorkflowDatabase } from './scheduled-database.js';
import type { SchedulerBackend } from './scheduler-database.js';
import { sha256Hex, utf8ByteLength } from '@mayura/core/host';
import { sqlExecutionWaitPersistence, type ExecutionStreamRow, type ExecutionWaitPersistence, type ExecutionWaitRow, type ExecutionWaitTransaction } from './execution-wait-persistence.js';

type Session = ExecutionWaitTransaction;
interface Stream { key: ExecutionWaitStreamKey; row: ExecutionStreamRow; events: StoredEvent[] }
function failed(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored execution wait failed integrity validation.'); }
function conflict(): never { throw new StorageError('CONFLICT', 'Execution wait identity or policy does not match.'); }
function digest(key: ExecutionWaitStreamKey, id: string, targets: readonly ExecutionRef[]): string {
  return sha256Hex(executionWaitHashMaterial(key, id, targets));
}
/** The store's time, never earlier than `floor`. */
async function storageClock(tx: Session, floor = 0): Promise<number> { return Math.max(floor, storedInteger(await tx.clock())); }

/** Finite metadata reducer. No workflow locks are acquired while a stream row is held. */
export class ExecutionWaitDatabase {
  private initialized = false;
  private readonly persistence: ExecutionWaitPersistence;
  constructor(backend: SchedulerBackend | ExecutionWaitPersistence, private readonly workflows: ScheduledWorkflowDatabase) {
    this.persistence = 'dialect' in backend ? sqlExecutionWaitPersistence(backend) : backend;
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.workflows.execute('initialize', {});
    await this.persistence.initialize();
    this.initialized = true;
  }
  /** The bounded journal independently checks stream counters and registration/terminal transitions. */
  private async stream(tx: Session, key: ExecutionWaitStreamKey): Promise<Stream> {
    const row = await tx.stream(key.scope, key.streamId);
    if (!row) throw new StorageError('NOT_FOUND', 'Execution stream was not found in this scope.');
    if (row.policy_hash !== key.policyHash) conflict();
    try {
      const count = storedInteger(row.wait_count); const head = storedInteger(row.event_sequence);
      if (row.scope !== key.scope || row.stream_id !== key.streamId || row.format !== 1 || count > 128 || head < 1 || head > 257) failed();
      const waits = await tx.waits(key.scope, key.streamId);
      if (waits.length !== count) failed();
      const rows = await tx.events(key.scope, key.streamId);
      if (rows.length !== head) failed();
      const events: StoredEvent[] = []; const registered = new Set<string>(); const terminal = new Set<string>();
      for (const [index, event] of rows.entries()) {
        if (storedInteger(event.sequence) !== index + 1 || typeof event.data !== 'string' || utf8ByteLength(event.data) > 1024
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
  private async append(tx: Session, stream: Stream, type: string, id?: string): Promise<void> {
    const sequence = storedInteger(stream.row.event_sequence) + 1; if (sequence > 257) failed();
    const floor = stream.events.length ? Date.parse(stream.events[stream.events.length - 1]!.createdAt) : 0;
    const createdAt = new Date(await storageClock(tx, floor)).toISOString();
    const data = id === undefined ? {} : { waitId: id };
    await tx.appendEvent(stream.key.scope, stream.key.streamId, { sequence, type, data: completionJson(data), created_at: createdAt });
    await tx.setEventSequence(stream.key.scope, stream.key.streamId, sequence);
    stream.row.event_sequence = sequence; stream.events.push({ sequence, type, data, createdAt });
  }
  private async facts(tx: Session, key: ExecutionWaitStreamKey, targets: readonly ExecutionRef[]): Promise<ExecutionCompletion[] | undefined> {
    const observations: ExecutionCompletion[] = []; let ready = true;
    for (const target of targets) {
      const fact = await completionOf(tx, key.scope, target);
      if (fact) observations.push(fact); else ready = false;
    }
    return ready ? observations : undefined;
  }
  /** Validate bounded canonical snapshots independently of their target index and terminal journal. */
  private decodeWait(row: ExecutionWaitRow, key: ExecutionWaitStreamKey): ExecutionWaitSnapshot {
    try {
      if (typeof row.data !== 'string' || utf8ByteLength(row.data) > 65_536) failed();
      const value = executionWaitSnapshot(JSON.parse(row.data));
      if (row.scope !== key.scope || row.stream_id !== key.streamId || row.wait_id !== value.id
        || value.version !== storedInteger(row.version) || value.status !== row.status || value.definitionHash !== row.definition_hash
        || value.definitionHash !== digest(key, value.id, value.targets) || row.data !== completionJson(value)
        || value.targets.some(target => target.policyHash !== key.policyHash)) failed();
      return value;
    } catch { return failed(); }
  }
  private async wait(tx: Session, stream: Stream, id: string): Promise<ExecutionWaitSnapshot | undefined> {
    const row = await tx.wait(stream.key.scope, stream.key.streamId, id);
    const registered = stream.events.find(event => event.type === 'wait.registered' && event.data['waitId'] === id);
    if (!row) { if (registered) failed(); return undefined; }
    try {
      const value = this.decodeWait(row, stream.key);
      if (value.id !== id || registered?.sequence !== storedInteger(row.registration_sequence)) failed();
      const terminal = stream.events.find(event => event.type !== 'wait.registered' && event.data['waitId'] === id);
      if ((value.status === 'waiting' && terminal) || (value.status !== 'waiting' && terminal?.type !== `wait.${value.status}`)) failed();
      const targets = await tx.targets(stream.key.scope, stream.key.streamId, id);
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
  private async transition(tx: Session, stream: Stream, current: ExecutionWaitSnapshot, status: 'resolved' | 'cancelled', observations: readonly ExecutionCompletion[] = []): Promise<ExecutionWaitSnapshot> {
    const next = executionWaitSnapshot({ ...current, version: 2, status, observations });
    await tx.updateWait(stream.key.scope, stream.key.streamId, next.id, next.version, next.status, completionJson(next));
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
    return this.persistence.transaction(async tx => {
      if (method === 'open') {
        await tx.lockStreamIdentity(scope, key.streamId);
        if (await tx.streamExists(scope, key.streamId)) { await this.stream(tx, key); return; }
        const row: ExecutionStreamRow = { scope, stream_id: key.streamId, policy_hash: key.policyHash, format: 1, wait_count: 0, event_sequence: 0 };
        await tx.insertStream(row);
        await this.append(tx, { key, row, events: [] }, 'stream.created'); return;
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
        await tx.insertWait({ scope, stream_id: key.streamId, wait_id: id, version: 1, status: snapshot.status, registration_sequence: storedInteger(stream.row.event_sequence) + 1,
          definition_hash: definitionHash, data: completionJson(snapshot) });
        for (const [ordinal, target] of targets.entries()) await tx.insertTarget({ scope, stream_id: key.streamId, wait_id: id, ordinal, run_id: target.runId,
          definition_hash: target.definitionHash, policy_hash: target.policyHash });
        await tx.setWaitCount(scope, key.streamId, count + 1);
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
        const ready = await tx.readyWaits(scope, key.streamId, input['limit'] as number);
        const results: ExecutionWaitSnapshot[] = [];
        for (const waitId of ready) {
          const current = await this.wait(tx, stream, waitId); if (!current || current.status !== 'waiting') failed();
          const observations = await this.facts(tx, key, current.targets); if (!observations) failed();
          results.push(await this.transition(tx, stream, current, 'resolved', observations));
        }
        return results;
      }
      throw new StorageError('INVALID_INPUT', 'Unknown execution wait command.');
    });
  }
}
