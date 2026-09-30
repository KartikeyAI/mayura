import { lockSql } from './aggregate-session.js';
import { advisoryLock, clockSql } from './dialect.js';
import { sqlCompletions, type CompletionAccess } from './execution-completions.js';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

export interface ExecutionStreamRow { scope: string; stream_id: string; policy_hash: string; format: number; wait_count: number | string; event_sequence: number | string }
export interface ExecutionWaitRow { scope: string; stream_id: string; wait_id: string; version: number | string; status: string; registration_sequence: number | string; definition_hash: string; data: string }
export interface ExecutionWaitTargetRow { scope: string; stream_id: string; wait_id: string; ordinal: number; run_id: string; definition_hash: string; policy_hash: string }
export interface ExecutionWaitEventRow { sequence: number | string; type: string; data: string; created_at: string }

/** The reads and writes the execution wait state machine makes inside one transaction. */
export interface ExecutionWaitTransaction extends CompletionAccess {
  /** The store's current time in milliseconds. */
  clock(): Promise<number>;
  /** Serializes opening one stream, even before its row exists. */
  lockStreamIdentity(scope: string, streamId: string): Promise<void>;
  /** Whether the stream exists, without locking it. */
  streamExists(scope: string, streamId: string): Promise<boolean>;
  /** The stream, locked until the transaction ends. */
  stream(scope: string, streamId: string): Promise<ExecutionStreamRow | undefined>;
  insertStream(row: ExecutionStreamRow): Promise<void>;
  setWaitCount(scope: string, streamId: string, count: number): Promise<void>;
  setEventSequence(scope: string, streamId: string, sequence: number): Promise<void>;
  /** Up to 129 of the stream's waits. */
  waits(scope: string, streamId: string): Promise<ExecutionWaitRow[]>;
  /** Up to 258 of the stream's journal events, in sequence order. */
  events(scope: string, streamId: string): Promise<ExecutionWaitEventRow[]>;
  appendEvent(scope: string, streamId: string, event: ExecutionWaitEventRow): Promise<void>;
  wait(scope: string, streamId: string, waitId: string): Promise<ExecutionWaitRow | undefined>;
  insertWait(row: ExecutionWaitRow): Promise<void>;
  updateWait(scope: string, streamId: string, waitId: string, version: number, status: string, data: string): Promise<void>;
  /** Up to 33 of the wait's targets, in ordinal order. */
  targets(scope: string, streamId: string, waitId: string): Promise<ExecutionWaitTargetRow[]>;
  insertTarget(row: ExecutionWaitTargetRow): Promise<void>;
  /** Up to `limit` waiting waits with at least one target whose every target has a matching completion, in registration order. */
  readyWaits(scope: string, streamId: string, limit: number): Promise<string[]>;
}
export interface ExecutionWaitPersistence {
  initialize(): Promise<void>;
  transaction<T>(body: (tx: ExecutionWaitTransaction) => Promise<T>): Promise<T>;
}

/** The execution wait rows in the SQL layer's tables: the SQL every SQL adapter has always run for them. */
export function sqlExecutionWaitTransaction(backend: SchedulerBackend, tx: SchedulerSession): ExecutionWaitTransaction {
  const table = (name: 'streams' | 'waits' | 'wait_targets' | 'wait_events') => `${backend.prefix}mayura_execution_${name}`;
  return {
    ...sqlCompletions(tx, backend),
    clock: async () => Number((await tx.query<{ now_ms: number | string }>(clockSql(backend)))[0]?.now_ms),
    lockStreamIdentity: (scope, streamId) => advisoryLock(tx, backend, JSON.stringify(['mayura:execution-stream:v1', backend.prefix, scope, streamId])),
    streamExists: async (scope, streamId) => (await tx.query(`SELECT stream_id FROM ${table('streams')} WHERE scope = ? AND stream_id = ?`, [scope, streamId])).length > 0,
    stream: async (scope, streamId) => (await tx.query<ExecutionStreamRow>(`SELECT * FROM ${table('streams')} WHERE scope = ? AND stream_id = ?${lockSql(backend)}`, [scope, streamId]))[0],
    insertStream: async row => {
      await tx.query(`INSERT INTO ${table('streams')} (scope,stream_id,policy_hash,format,wait_count,event_sequence) VALUES (?,?,?,1,0,0)`, [row.scope, row.stream_id, row.policy_hash]);
    },
    setWaitCount: async (scope, streamId, count) => { await tx.query(`UPDATE ${table('streams')} SET wait_count = ? WHERE scope = ? AND stream_id = ?`, [count, scope, streamId]); },
    setEventSequence: async (scope, streamId, sequence) => { await tx.query(`UPDATE ${table('streams')} SET event_sequence = ? WHERE scope = ? AND stream_id = ?`, [sequence, scope, streamId]); },
    waits: async (scope, streamId) => [...await tx.query<ExecutionWaitRow>(`SELECT * FROM ${table('waits')} WHERE scope = ? AND stream_id = ? LIMIT 129`, [scope, streamId])],
    events: async (scope, streamId) => [...await tx.query<ExecutionWaitEventRow>(`SELECT sequence,type,data,created_at FROM ${table('wait_events')} WHERE scope = ? AND stream_id = ? ORDER BY sequence LIMIT 258`, [scope, streamId])],
    appendEvent: async (scope, streamId, event) => {
      await tx.query(`INSERT INTO ${table('wait_events')} (scope,stream_id,sequence,type,data,created_at) VALUES (?,?,?,?,?,?)`,
        [scope, streamId, event.sequence, event.type, event.data, event.created_at]);
    },
    wait: async (scope, streamId, waitId) => (await tx.query<ExecutionWaitRow>(`SELECT * FROM ${table('waits')} WHERE scope = ? AND stream_id = ? AND wait_id = ?`, [scope, streamId, waitId]))[0],
    insertWait: async row => {
      await tx.query(`INSERT INTO ${table('waits')} (scope,stream_id,wait_id,version,status,registration_sequence,definition_hash,data) VALUES (?,?,?,1,?,?,?,?)`,
        [row.scope, row.stream_id, row.wait_id, row.status, row.registration_sequence, row.definition_hash, row.data]);
    },
    updateWait: async (scope, streamId, waitId, version, status, data) => {
      await tx.query(`UPDATE ${table('waits')} SET version = ?, status = ?, data = ? WHERE scope = ? AND stream_id = ? AND wait_id = ?`,
        [version, status, data, scope, streamId, waitId]);
    },
    targets: async (scope, streamId, waitId) => [...await tx.query<ExecutionWaitTargetRow>(`SELECT * FROM ${table('wait_targets')} WHERE scope = ? AND stream_id = ? AND wait_id = ? ORDER BY ordinal LIMIT 33`, [scope, streamId, waitId])],
    insertTarget: async row => {
      await tx.query(`INSERT INTO ${table('wait_targets')} (scope,stream_id,wait_id,ordinal,run_id,definition_hash,policy_hash) VALUES (?,?,?,?,?,?,?)`,
        [row.scope, row.stream_id, row.wait_id, row.ordinal, row.run_id, row.definition_hash, row.policy_hash]);
    },
    readyWaits: async (scope, streamId, limit) => (await tx.query<{ wait_id: string }>(`SELECT w.wait_id FROM ${table('waits')} w
          WHERE w.scope = ? AND w.stream_id = ? AND w.status = 'waiting'
          AND EXISTS (SELECT 1 FROM ${table('wait_targets')} t WHERE t.scope = w.scope AND t.stream_id = w.stream_id AND t.wait_id = w.wait_id)
          AND NOT EXISTS (SELECT 1 FROM ${table('wait_targets')} t WHERE t.scope = w.scope AND t.stream_id = w.stream_id AND t.wait_id = w.wait_id
            AND NOT EXISTS (SELECT 1 FROM ${backend.prefix}mayura_execution_completions c WHERE c.scope = t.scope AND c.run_id = t.run_id AND c.definition_hash = t.definition_hash AND c.policy_hash = t.policy_hash))
          ORDER BY w.registration_sequence LIMIT ?`, [scope, streamId, limit])).map(row => row.wait_id),
  };
}

/** The SQL layer's execution wait tables on a backend. */
export function sqlExecutionWaitPersistence(backend: SchedulerBackend): ExecutionWaitPersistence {
  const table = (name: 'streams' | 'waits' | 'wait_targets' | 'wait_events') => `${backend.prefix}mayura_execution_${name}`;
  return {
    transaction: body => backend.transaction(tx => body(sqlExecutionWaitTransaction(backend, tx))),
    initialize: () => backend.transaction(async tx => {
      await advisoryLock(tx, backend, `mayura:execution-wait-schema:${backend.prefix}`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table('streams')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, policy_hash TEXT NOT NULL, format INTEGER NOT NULL CHECK(format = 1),
        wait_count INTEGER NOT NULL CHECK(wait_count BETWEEN 0 AND 128), event_sequence INTEGER NOT NULL CHECK(event_sequence BETWEEN 0 AND 257),
        PRIMARY KEY(scope,stream_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table('waits')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, wait_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2),
        status TEXT NOT NULL, registration_sequence INTEGER NOT NULL CHECK(registration_sequence BETWEEN 2 AND 257), definition_hash TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(scope,stream_id,wait_id), UNIQUE(scope,stream_id,registration_sequence),
        FOREIGN KEY(scope,stream_id) REFERENCES ${table('streams')}(scope,stream_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table('wait_targets')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, wait_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
        run_id TEXT NOT NULL, definition_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
        PRIMARY KEY(scope,stream_id,wait_id,ordinal), UNIQUE(scope,stream_id,wait_id,run_id),
        FOREIGN KEY(scope,stream_id,wait_id) REFERENCES ${table('waits')}(scope,stream_id,wait_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${table('wait_events')} (
        scope TEXT NOT NULL, stream_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 257),
        type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope,stream_id,sequence),
        FOREIGN KEY(scope,stream_id) REFERENCES ${table('streams')}(scope,stream_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_execution_waits_ready ON ${table('waits')}(scope,stream_id,status,registration_sequence)`);
    }),
  };
}
