import { jsonValue, type ExecutionReceipt, type JsonObject } from '@mayura/core';
import { StorageError, type StoredEvent } from './contracts.js';
import type { Claim, CompleteJobCommand, EvidenceDisposition, JobKey, JobRecord, JobReservation, ReceiptCommand, SchedulerEvidence } from './scheduler-contracts.js';
import { canonical, fields, hash, integer, object, reservation, schedulerCommand, schedulerDigest, type SchedulerMethod } from './scheduler-validation.js';
import { identifier, nextCounter } from './validation.js';

/** Internal parameterized SQL seam; implementations own a real short transaction. */
export interface SchedulerSession { query<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]> }
export interface SchedulerBackend {
  readonly dialect: 'sqlite' | 'postgres'; readonly prefix: string;
  transaction<T>(body: (session: SchedulerSession) => Promise<T>): Promise<T>;
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface Attempt {
  fence: number; workerId: string; claimedAtMs: number; leaseUntilMs: number;
  startedAtMs: number | null; ended: 'released' | 'expired' | 'completed' | 'unknown' | null;
  evidence: SchedulerEvidence[];
}
interface Journal { id: string; digest: string; version: number; operation: 'complete' | 'cancel'; outcome: 'succeeded' | 'failed' | 'blocked' | null }
interface Data {
  format: 1; job: Mutable<JobRecord>; reservation: JobReservation;
  lastClockMs: number; attempts: Attempt[]; commands: Journal[];
}
interface Row {
  scope: string; job_id: string; reservation_key: string; invocation_id: string; run_id: string;
  digest: string; state: string; due_at: number | string; lease_until: number | string | null;
  deadline_at: number | string | null; revoked: number; version: number | string; data: string;
}
const STALE = Symbol('stale');
const terminal = new Set(['succeeded','failed','blocked','cancelled','outcome_unknown']);
const eventTypes = new Set(['job.reserved','job.cancelled','job.lease_expired','job.renewed','job.started','job.completed','job.claimed','job.receipt_recorded','job.recovered']);
class ResourceBusy extends StorageError { constructor() { super('CONFLICT', 'A scheduler resource is already held.'); } }
function failure(): never { throw new StorageError('STORAGE_UNAVAILABLE', 'Stored scheduler state failed integrity validation.'); }
function conflict(): never { throw new StorageError('CONFLICT', 'Scheduler identity or committed command content conflicts.'); }
function limit(): never { throw new StorageError('LIMIT_EXCEEDED', 'The bounded scheduler history or counter limit was reached.'); }
const same = (a: unknown, b: unknown): boolean => canonical(jsonValue(a)) === canonical(jsonValue(b));

/** The authoritative job state is bounded JSON; queue columns are a checked SQL projection. */
function decode(row: Row): Data {
  try {
    const raw = object(JSON.parse(row.data)); fields(raw, ['format','job','reservation','lastClockMs','attempts','commands']);
    if (raw['format'] !== 1) failure();
    const saved = reservation(raw['reservation']);
    const job = object(raw['job']); fields(job, ['scope','jobId','runId','nodeId','invocationId','definitionHash','candidateHash','intent','resourceKeys','state','version','fence','workerId','dueAtMs','deadlineAtMs','leaseUntilMs','startedAtMs','leaseRevoked','cancelRequested','receipt','output']);
    for (const key of ['scope','jobId','runId','nodeId','invocationId','definitionHash','candidateHash','intent','resourceKeys']) if (!same(job[key], (saved as unknown as JsonObject)[key])) failure();
    if (row.scope !== job['scope'] || row.job_id !== job['jobId'] || row.reservation_key !== saved.reservationKey || row.invocation_id !== saved.invocationId || row.run_id !== saved.runId || row.digest !== schedulerDigest('reservation', saved)) failure();
    if (!['ready','leased','started',...terminal].includes(job['state'] as string)) failure();
    integer(job['version'], 1); integer(job['fence'], 0, 128); integer(job['dueAtMs']); integer(raw['lastClockMs']);
    const createdAt = (job['dueAtMs'] as number) - saved.delayMs;
    integer(createdAt, 0, raw['lastClockMs'] as number);
    if (job['deadlineAtMs'] !== (saved.deadlineAfterMs === undefined ? null : createdAt + saved.deadlineAfterMs)) failure();
    for (const key of ['deadlineAtMs','leaseUntilMs','startedAtMs']) if (job[key] !== null) integer(job[key]);
    if (job['workerId'] !== null) identifier(job['workerId'], 'Stored worker');
    if (typeof job['leaseRevoked'] !== 'boolean' || typeof job['cancelRequested'] !== 'boolean') failure();
    if (row.state !== job['state'] || Number(row.version) !== job['version'] || Number(row.due_at) !== job['dueAtMs'] || row.revoked !== Number(job['leaseRevoked']) || (row.lease_until === null ? null : Number(row.lease_until)) !== job['leaseUntilMs'] || (row.deadline_at === null ? null : Number(row.deadline_at)) !== job['deadlineAtMs']) failure();
    if (job['state'] !== 'succeeded' && job['output'] !== null) failure();
    jsonValue(job['output'], { maxBytes: 65_536 });
    const checkReceipt = (value: unknown, released = false): ExecutionReceipt => {
      const item = object(value, 2048); fields(item, ['callId','toolId','execution','disclosure']);
      if (item['callId'] !== saved.intent['callId'] || item['toolId'] !== saved.intent['toolId'] || !['not_started','succeeded','failed','unknown'].includes(item['execution'] as string) || !['withheld', ...(released ? ['released'] : [])].includes(item['disclosure'] as string)) failure();
      return item as unknown as ExecutionReceipt;
    };
    if (job['receipt'] !== null) checkReceipt(job['receipt'], true);
    if (job['state'] === 'succeeded' && ((job['receipt'] as JsonObject | null)?.['execution'] !== 'succeeded' || (job['receipt'] as JsonObject)['disclosure'] !== 'released')) failure();
    if (job['state'] === 'failed' && (job['receipt'] as JsonObject | null)?.['execution'] !== 'failed') failure();
    if (!Array.isArray(raw['attempts']) || raw['attempts'].length !== job['fence'] || !Array.isArray(raw['commands']) || raw['commands'].length > 64) failure();
    let starts = 0;
    for (const [index, value] of raw['attempts'].entries()) {
      const attempt = object(value); fields(attempt, ['fence','workerId','claimedAtMs','leaseUntilMs','startedAtMs','ended','evidence']);
      if (attempt['fence'] !== index + 1) failure(); identifier(attempt['workerId'], 'Stored worker'); integer(attempt['claimedAtMs']); integer(attempt['leaseUntilMs']);
      if (attempt['startedAtMs'] !== null) { integer(attempt['startedAtMs']); starts++; }
      if (![null,'released','expired','completed','unknown'].includes(attempt['ended'] as string | null) || !Array.isArray(attempt['evidence']) || attempt['evidence'].length > 16 || (attempt['startedAtMs'] === null && attempt['evidence'].length > 0)) failure();
      const evidenceIds = new Set<string>();
      for (const item of attempt['evidence']) {
        const evidence = object(item); fields(evidence, ['evidenceId','receipt','disposition','recordedAtMs']);
        const id = identifier(evidence['evidenceId'], 'Stored evidence'); if (evidenceIds.has(id)) failure(); evidenceIds.add(id);
        checkReceipt(evidence['receipt']); integer(evidence['recordedAtMs']);
        if (!['current','late','conflicting'].includes(evidence['disposition'] as string)) failure();
      }
    }
    if (starts > 1 || (job['state'] === 'ready' && starts !== 0)) failure();
    const current = (raw['attempts'] as unknown as Attempt[]).at(-1);
    if (['leased','started'].includes(job['state'] as string) && (!current || current.workerId !== job['workerId'] || current.leaseUntilMs !== job['leaseUntilMs'] || current.startedAtMs !== job['startedAtMs'] || (job['state'] === 'started') !== (current.startedAtMs !== null))) failure();
    if (job['state'] === 'ready' && (job['workerId'] !== null || job['leaseUntilMs'] !== null || job['startedAtMs'] !== null || job['receipt'] !== null)) failure();
    if (job['state'] === 'leased' && job['receipt'] !== null) failure();
    if (['succeeded','failed','outcome_unknown'].includes(job['state'] as string) && (!current || current.startedAtMs === null || current.startedAtMs !== job['startedAtMs'])) failure();
    if (job['receipt'] !== null) {
      const expected = { ...job['receipt'] as JsonObject, disclosure: 'withheld' };
      if (!current?.evidence.some(item => item.disposition === 'current' && same(item.receipt, expected))) failure();
      if ((job['receipt'] as JsonObject)['disclosure'] === 'released' && job['state'] !== 'succeeded') failure();
    }
    const commandIds = new Set<string>(); let previousCommandVersion = 0; let completed: Journal | undefined;
    for (const item of raw['commands']) {
      const command = object(item); fields(command, ['id','digest','version','operation','outcome']);
      const id = identifier(command['id'], 'Stored command'); if (commandIds.has(id)) failure(); commandIds.add(id);
      hash(command['digest']); integer(command['version'], 1, job['version'] as number);
      if ((command['version'] as number) <= previousCommandVersion) failure(); previousCommandVersion = command['version'] as number;
      if (command['operation'] === 'complete') {
        if (completed || !['succeeded','failed','blocked'].includes(command['outcome'] as string)) failure();
        completed = command as unknown as Journal;
      } else if (command['operation'] !== 'cancel' || command['outcome'] !== null) failure();
    }
    if (completed && (starts !== 1 || completed.outcome !== job['state'])) failure();
    if (['succeeded','failed'].includes(job['state'] as string) || (job['state'] === 'blocked' && starts === 1)) {
      if (!completed) failure();
    }
    if (job['cancelRequested'] === true && !(raw['commands'] as unknown as Journal[]).some(command => command.operation === 'cancel')) failure();
    return raw as unknown as Data;
  } catch { return failure(); }
}

/** Shared state machine; there are no application callbacks inside these transactions. */
export class SchedulerDatabase {
  private initialized = false;
  constructor(private readonly backend: SchedulerBackend) {}
  private table(name: string): string { return `${this.backend.prefix}mayura_scheduler_${name}`; }
  private lock(skip = false): string { return this.backend.dialect === 'postgres' ? ` FOR UPDATE${skip ? ' SKIP LOCKED' : ''}` : ''; }
  private async clock(tx: SchedulerSession, floor = 0): Promise<number> {
    const sql = this.backend.dialect === 'postgres'
      ? "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms"
      : "SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms";
    const rows = await tx.query<{ now_ms: number | string }>(sql);
    const now = Number(rows[0]?.now_ms);
    if (!Number.isSafeInteger(now) || now < 0) failure();
    return Math.max(floor, now);
  }
  private async load(tx: SchedulerSession, key: JobKey, locked = false, skip = false): Promise<Data | undefined> {
    const rows = await tx.query<Row>(`SELECT * FROM ${this.table('jobs')} WHERE scope = ? AND job_id = ?${locked ? this.lock(skip) : ''}`, [key.scope, key.jobId]);
    if (!rows[0]) return undefined;
    const data = decode(rows[0]);
    const requests = await tx.query<{ resource_key: string }>(`SELECT resource_key FROM ${this.table('requests')} WHERE scope = ? AND job_id = ? ORDER BY resource_key`, [key.scope, key.jobId]);
    // SQL collation need not match JS UTF-16 ordering; compare canonicalized identities.
    if (!same(requests.map(item => item.resource_key).sort(), data.job.resourceKeys)) failure();
    const held = await tx.query<{ resource_key: string; fence: number | string; disposition: string }>(`SELECT resource_key, fence, disposition FROM ${this.table('resources')} WHERE scope = ? AND job_id = ?`, [key.scope, key.jobId]);
    const expected = data.job.state === 'outcome_unknown' ? 'quarantined' : ['leased','started'].includes(data.job.state) ? 'held' : undefined;
    if (expected === undefined ? held.length !== 0 : held.length !== data.job.resourceKeys.length
      || held.some(row => !data.job.resourceKeys.includes(row.resource_key) || Number(row.fence) !== data.job.fence || row.disposition !== expected)) failure();
    return data;
  }
  private async append(tx: SchedulerSession, data: Data, type: string, now: number): Promise<void> {
    const job = data.job;
    await tx.query(`INSERT INTO ${this.table('heads')} (scope, run_id, sequence) VALUES (?, ?, 0) ON CONFLICT DO NOTHING`, [job.scope, job.runId]);
    const rows = await tx.query<{ sequence: number | string }>(`SELECT sequence FROM ${this.table('heads')} WHERE scope = ? AND run_id = ?${this.lock()}`, [job.scope, job.runId]);
    const current = Number(rows[0]?.sequence); if (!Number.isSafeInteger(current) || current < 0) failure();
    const sequence = nextCounter(current, 1);
    await tx.query(`UPDATE ${this.table('heads')} SET sequence = ? WHERE scope = ? AND run_id = ?`, [sequence, job.scope, job.runId]);
    await tx.query(`INSERT INTO ${this.table('events')} (scope, run_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [job.scope, job.runId, sequence, type, JSON.stringify({ jobId: job.jobId, fence: job.fence, state: job.state }), new Date(now).toISOString()]);
  }
  private async save(tx: SchedulerSession, data: Data, type: string, now: number): Promise<void> {
    data.lastClockMs = Math.max(data.lastClockMs, now); data.job.version = nextCounter(data.job.version, 1);
    const serialized = JSON.stringify(object(data)); const j = data.job;
    const row: Row = { scope: j.scope, job_id: j.jobId, reservation_key: data.reservation.reservationKey, invocation_id: j.invocationId, run_id: j.runId, digest: schedulerDigest('reservation', data.reservation), state: j.state, due_at: j.dueAtMs, lease_until: j.leaseUntilMs, deadline_at: j.deadlineAtMs, revoked: Number(j.leaseRevoked), version: j.version, data: serialized };
    decode(row);
    await tx.query(`UPDATE ${this.table('jobs')} SET state = ?, lease_until = ?, revoked = ?, version = ?, data = ? WHERE scope = ? AND job_id = ?`, [j.state, j.leaseUntilMs, Number(j.leaseRevoked), j.version, serialized, j.scope, j.jobId]);
    await this.append(tx, data, type, now);
  }
  private async holds(tx: SchedulerSession, data: Data): Promise<boolean> {
    const rows = await tx.query<{ resource_key: string; fence: number | string; disposition: string }>(`SELECT resource_key, fence, disposition FROM ${this.table('resources')} WHERE scope = ? AND job_id = ? ORDER BY resource_key`, [data.job.scope, data.job.jobId]);
    return rows.length === data.job.resourceKeys.length && rows.every(row => data.job.resourceKeys.includes(row.resource_key) && Number(row.fence) === data.job.fence && row.disposition === 'held');
  }
  private async release(tx: SchedulerSession, data: Data, quarantine: boolean): Promise<void> {
    const j = data.job;
    if (quarantine) await tx.query(`UPDATE ${this.table('resources')} SET disposition = 'quarantined' WHERE scope = ? AND job_id = ? AND fence = ?`, [j.scope, j.jobId, j.fence]);
    else await tx.query(`DELETE FROM ${this.table('resources')} WHERE scope = ? AND job_id = ? AND fence = ?`, [j.scope, j.jobId, j.fence]);
  }
  private live(data: Data, token: Claim, now: number): boolean {
    const j = data.job;
    return ['leased','started'].includes(j.state) && j.fence === token.fence && j.workerId === token.workerId && !j.cancelRequested && !j.leaseRevoked && j.leaseUntilMs !== null && j.leaseUntilMs > now && (j.deadlineAtMs === null || j.deadlineAtMs > now);
  }
  /** A tagged stale result commits revocation before the public method raises STALE_CLAIM. */
  private async observeExpiry(tx: SchedulerSession, data: Data, now: number): Promise<void> {
    const j = data.job;
    if (['leased','started'].includes(j.state) && !j.leaseRevoked && ((j.leaseUntilMs ?? 0) <= now || (j.deadlineAtMs !== null && j.deadlineAtMs <= now))) {
      j.leaseRevoked = true; await this.save(tx, data, 'job.lease_expired', now);
    }
  }
  private token(data: Data): Claim {
    const j = data.job; return { scope: j.scope, jobId: j.jobId, workerId: j.workerId!, fence: j.fence, leaseUntilMs: j.leaseUntilMs! };
  }
  private async unknown(tx: SchedulerSession, data: Data): Promise<void> {
    data.job.state = 'outcome_unknown'; data.job.leaseRevoked = true; data.job.output = null;
    const attempt = data.attempts.at(-1); if (attempt) attempt.ended = 'unknown';
    await this.release(tx, data, true);
  }
  private journal(data: Data, id: string, value: unknown, append = true): boolean {
    const found = data.commands.find(command => command.id === id); const digest = schedulerDigest('command', value);
    if (found) { if (found.digest !== digest) conflict(); return true; }
    if (!append) return false;
    if (data.commands.length >= 64) limit();
    const request = object(value);
    const operation = request['operation'];
    if (operation !== 'complete' && operation !== 'cancel') failure();
    const outcome = operation === 'complete' ? request['outcome'] as Journal['outcome'] : null;
    data.commands.push({ id, digest, version: nextCounter(data.job.version, 1), operation, outcome }); return false;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.backend.transaction(async tx => {
      if (this.backend.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`mayura:scheduler-schema:${this.backend.prefix}`]);
      const t = (name: string) => this.table(name);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('meta')} (version INTEGER PRIMARY KEY CHECK(version = 1))`);
      await tx.query(`INSERT INTO ${t('meta')} (version) VALUES (1) ON CONFLICT DO NOTHING`);
      const versions = await tx.query<{ version: number }>(`SELECT version FROM ${t('meta')}`);
      if (versions.length !== 1 || versions[0]?.version !== 1) failure();
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('jobs')} (
        scope TEXT NOT NULL, job_id TEXT NOT NULL, reservation_key TEXT NOT NULL, invocation_id TEXT NOT NULL, run_id TEXT NOT NULL,
        digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','leased','started','succeeded','failed','blocked','cancelled','outcome_unknown')),
        due_at BIGINT NOT NULL CHECK(due_at >= 0), deadline_at BIGINT, lease_until BIGINT,
        revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), version BIGINT NOT NULL CHECK(version > 0), data TEXT NOT NULL,
        PRIMARY KEY(scope, job_id), UNIQUE(scope, reservation_key), UNIQUE(scope, invocation_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('requests')} (scope TEXT NOT NULL, job_id TEXT NOT NULL, resource_key TEXT NOT NULL,
        PRIMARY KEY(scope, job_id, resource_key), FOREIGN KEY(scope, job_id) REFERENCES ${t('jobs')}(scope, job_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('resources')} (scope TEXT NOT NULL, resource_key TEXT NOT NULL, job_id TEXT NOT NULL,
        fence BIGINT NOT NULL CHECK(fence > 0), disposition TEXT NOT NULL CHECK(disposition IN ('held','quarantined')),
        PRIMARY KEY(scope, resource_key), FOREIGN KEY(scope, job_id) REFERENCES ${t('jobs')}(scope, job_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('heads')} (scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence >= 0), PRIMARY KEY(scope, run_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS ${t('events')} (scope TEXT NOT NULL, run_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence > 0),
        type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, run_id, sequence), FOREIGN KEY(scope, run_id) REFERENCES ${t('heads')}(scope, run_id))`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_ready ON ${t('jobs')} (scope, due_at, job_id) WHERE state = 'ready'`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_expired ON ${t('jobs')} (scope, lease_until, job_id) WHERE state IN ('leased','started')`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_deadline ON ${t('jobs')} (scope, deadline_at, job_id) WHERE state IN ('ready','leased','started')`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_held_job ON ${t('resources')} (scope, job_id)`);
      await tx.query(`CREATE INDEX IF NOT EXISTS mayura_scheduler_requested_resource ON ${t('requests')} (scope, resource_key, job_id)`);
    });
    this.initialized = true;
  }

  async execute(method: SchedulerMethod, value: unknown): Promise<unknown> {
    const input = schedulerCommand(method, value);
    if (method === 'initialize') return this.initialize();
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize scheduler storage before accessing jobs.');
    if (method === 'reserve') return this.reserve(input as unknown as JobReservation);
    if (method === 'claim') return this.claim(input as unknown as { scope: string; workerId: string; limit: number; leaseMs: number });
    if (method === 'recover') return this.recover(input as unknown as { scope: string; limit: number });
    if (method === 'events') return this.backend.transaction(async tx => {
      const rows = await tx.query<{ sequence: number | string; type: string; data: string; created_at: string }>(`SELECT sequence, type, data, created_at FROM ${this.table('events')} WHERE scope = ? AND run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, [input['scope'], input['runId'], input['after'] ?? 0, input['limit'] ?? 1_000]);
      return rows.map((row): StoredEvent => {
        try {
          const data = object(JSON.parse(row.data), 4096); fields(data, ['jobId','fence','state']);
          identifier(data['jobId'], 'Event job'); integer(data['fence'], 0, 128);
          if (!eventTypes.has(row.type) || !['ready','leased','started',...terminal].includes(data['state'] as string)
            || typeof row.created_at !== 'string' || new Date(row.created_at).toISOString() !== row.created_at) failure();
          return { sequence: integer(Number(row.sequence), 1), type: row.type, data, createdAt: row.created_at };
        } catch { return failure(); }
      });
    });
    const token = input['claim'] as unknown as Claim | undefined;
    const key = token ?? input as unknown as JobKey;
    const result = await this.backend.transaction(async tx => {
      // A row lock gives metadata inspection a coherent job/resource projection under READ COMMITTED.
      const data = await this.load(tx, key, true);
      if (!data) { if (method === 'read') return undefined; throw new StorageError('NOT_FOUND', 'Job was not found in this scope.'); }
      if (method === 'read') return data.job;
      if (method === 'receipts') return data.attempts.find(attempt => attempt.fence === input['fence'])?.evidence ?? [];
      const now = await this.clock(tx, data.lastClockMs);
      if (method === 'cancel') {
        if (this.journal(data, input['commandId'] as string, { operation: method, ...input })) return data.job;
        if (!terminal.has(data.job.state)) {
          data.job.cancelRequested = true; data.job.leaseRevoked = true;
          if (data.job.state === 'started') await this.unknown(tx, data);
          else { data.job.state = 'cancelled'; const attempt = data.attempts.at(-1); if (attempt) attempt.ended = 'released'; await this.release(tx, data, false); }
        }
        await this.save(tx, data, 'job.cancelled', now); return data.job;
      }
      if (method === 'recordReceipt') return this.recordReceipt(tx, data, input as unknown as ReceiptCommand, now);
      if (!token) failure();
      // Retry acknowledgement is allowed after terminal completion, but never yields dispatch authority.
      let completion: CompleteJobCommand | undefined;
      if (method === 'complete') {
        completion = input as unknown as CompleteJobCommand;
        const { leaseUntilMs: _informational, ...identity } = completion.claim;
        if (this.journal(data, completion.commandId, { ...input, operation: method, claim: identity }, false)) return data.job;
      }
      if (!this.live(data, token, now)) { await this.observeExpiry(tx, data, now); return STALE; }
      if (!await this.holds(tx, data)) failure();
      if (method === 'renew') {
        const expiry = Math.min(nextCounter(now, input['leaseMs'] as number), data.job.deadlineAtMs ?? Number.MAX_SAFE_INTEGER);
        data.job.leaseUntilMs = expiry; data.attempts.at(-1)!.leaseUntilMs = expiry;
        await this.save(tx, data, 'job.renewed', now); return this.token(data);
      }
      if (method === 'start') {
        if (data.job.candidateHash !== input['candidateHash']) conflict();
        if (data.job.state === 'started') return { status: 'already_started', job: data.job };
        data.job.state = 'started'; data.job.startedAtMs = now; data.attempts.at(-1)!.startedAtMs = now;
        await this.save(tx, data, 'job.started', now); return { status: 'started', job: data.job };
      }
      if (completion) {
        if (data.job.state !== 'started') return STALE;
        const evidence = data.attempts.at(-1)!.evidence.find(item => item.evidenceId === completion.evidenceId && item.disposition === 'current');
        if (!evidence || evidence.receipt.execution === 'unknown' || (completion.outcome === 'succeeded' && evidence.receipt.execution !== 'succeeded') || (completion.outcome === 'failed' && evidence.receipt.execution !== 'failed')) conflict();
        const { leaseUntilMs: _informational, ...identity } = completion.claim;
        this.journal(data, completion.commandId, { ...input, operation: method, claim: identity });
        data.job.state = completion.outcome; data.job.output = completion.output; data.job.leaseRevoked = true;
        data.job.receipt = { ...evidence.receipt, disclosure: completion.outcome === 'succeeded' ? 'released' : 'withheld' };
        data.attempts.at(-1)!.ended = 'completed';
        await this.release(tx, data, false); await this.save(tx, data, 'job.completed', now); return data.job;
      }
      return failure();
    });
    if (result === STALE) throw new StorageError('STALE_CLAIM', 'Scheduler ownership is stale, expired or no longer authorizes this transition.');
    return result;
  }

  private async reserve(input: JobReservation): Promise<unknown> {
    return this.backend.transaction(async tx => {
      const now = await this.clock(tx); const digest = schedulerDigest('reservation', input);
      const j: Mutable<JobRecord> = {
        scope: input.scope, jobId: input.jobId, runId: input.runId, nodeId: input.nodeId, invocationId: input.invocationId,
        definitionHash: input.definitionHash, candidateHash: input.candidateHash, intent: input.intent, resourceKeys: input.resourceKeys,
        state: 'ready', version: 1, fence: 0, workerId: null, dueAtMs: nextCounter(now, input.delayMs),
        deadlineAtMs: input.deadlineAfterMs === undefined ? null : nextCounter(now, input.deadlineAfterMs),
        leaseUntilMs: null, startedAtMs: null, leaseRevoked: false, cancelRequested: false, receipt: null, output: null,
      };
      const data: Data = { format: 1, job: j, reservation: input, lastClockMs: now, attempts: [], commands: [] };
      const inserted = await tx.query<{ job_id: string }>(`INSERT INTO ${this.table('jobs')} (scope, job_id, reservation_key, invocation_id, run_id, digest, state, due_at, deadline_at, lease_until, revoked, version, data)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL, 0, 1, ?) ON CONFLICT DO NOTHING RETURNING job_id`, [j.scope, j.jobId, input.reservationKey, j.invocationId, j.runId, digest, j.dueAtMs, j.deadlineAtMs, JSON.stringify(data)]);
      if (inserted.length === 0) {
        const rows = await tx.query<Row>(`SELECT * FROM ${this.table('jobs')} WHERE scope = ? AND reservation_key = ?${this.lock()}`, [j.scope, input.reservationKey]);
        const existing = rows[0]; if (!existing || existing.digest !== digest) conflict();
        const current = await this.load(tx, { scope: j.scope, jobId: existing.job_id }, true);
        if (!current) failure();
        return { job: current.job, created: false };
      }
      for (const resource of j.resourceKeys) await tx.query(`INSERT INTO ${this.table('requests')} (scope, job_id, resource_key) VALUES (?, ?, ?)`, [j.scope, j.jobId, resource]);
      await this.append(tx, data, 'job.reserved', now);
      return { job: j, created: true };
    });
  }

  private async claim(input: { scope: string; workerId: string; limit: number; leaseMs: number }): Promise<unknown> {
    const candidates = await this.backend.transaction(async tx => {
      const now = await this.clock(tx);
      return tx.query<{ job_id: string }>(`SELECT j.job_id FROM ${this.table('jobs')} j WHERE j.scope = ? AND j.state = 'ready' AND j.due_at <= ?
        AND (j.deadline_at IS NULL OR j.deadline_at > ?) AND NOT EXISTS (SELECT 1 FROM ${this.table('requests')} r JOIN ${this.table('resources')} h ON h.scope = r.scope AND h.resource_key = r.resource_key WHERE r.scope = j.scope AND r.job_id = j.job_id)
        AND NOT EXISTS (SELECT 1 FROM ${this.table('requests')} wanted JOIN ${this.table('requests')} owned ON owned.scope = wanted.scope AND owned.resource_key = wanted.resource_key
          JOIN ${this.table('jobs')} owner ON owner.scope = owned.scope AND owner.job_id = owned.job_id
          WHERE wanted.scope = j.scope AND wanted.job_id = j.job_id AND owner.job_id <> j.job_id AND owner.state IN ('leased','started','outcome_unknown'))
        ORDER BY j.due_at, j.job_id LIMIT 128${this.backend.dialect === 'postgres' ? ' FOR UPDATE OF j SKIP LOCKED' : ''}`, [input.scope, now, now]);
    });
    const result: { job: JobRecord; claim: Claim }[] = [];
    for (const candidate of candidates) {
      if (result.length >= input.limit) break;
      try {
        const claimed = await this.backend.transaction(async tx => {
          const data = await this.load(tx, { scope: input.scope, jobId: candidate.job_id }, true, true); if (!data || data.job.state !== 'ready') return undefined;
          const j = data.job; const now = await this.clock(tx, data.lastClockMs);
          if (j.cancelRequested || j.dueAtMs > now || (j.deadlineAtMs !== null && j.deadlineAtMs <= now)) return undefined;
          if (j.fence >= 128) return undefined;
          const fence = j.fence + 1;
          // Redundant logical ownership stops overlap even if a normalized hold row was lost.
          // This is corruption defense, not protection against a privileged writer changing all copies.
          const owners = await tx.query<{ job_id: string }>(`SELECT owner.job_id FROM ${this.table('requests')} wanted
            JOIN ${this.table('requests')} owned ON owned.scope = wanted.scope AND owned.resource_key = wanted.resource_key
            JOIN ${this.table('jobs')} owner ON owner.scope = owned.scope AND owner.job_id = owned.job_id
            WHERE wanted.scope = ? AND wanted.job_id = ? AND owner.job_id <> ? AND owner.state IN ('leased','started','outcome_unknown') LIMIT 1`, [j.scope, j.jobId, j.jobId]);
          if (owners.length > 0) return undefined;
          for (const resource of j.resourceKeys) {
            const held = await tx.query<{ resource_key: string }>(`INSERT INTO ${this.table('resources')} (scope, resource_key, job_id, fence, disposition) VALUES (?, ?, ?, ?, 'held') ON CONFLICT DO NOTHING RETURNING resource_key`, [j.scope, resource, j.jobId, fence]);
            if (held.length === 0) throw new ResourceBusy();
          }
          j.state = 'leased'; j.workerId = input.workerId; j.fence = fence; j.leaseRevoked = false;
          j.leaseUntilMs = Math.min(nextCounter(now, input.leaseMs), j.deadlineAtMs ?? Number.MAX_SAFE_INTEGER);
          data.attempts.push({ fence, workerId: input.workerId, claimedAtMs: now, leaseUntilMs: j.leaseUntilMs, startedAtMs: null, ended: null, evidence: [] });
          await this.save(tx, data, 'job.claimed', now); return { job: j, claim: this.token(data) };
        });
        if (claimed) result.push(claimed);
      } catch (error) { if (!(error instanceof ResourceBusy)) throw error; }
    }
    return result;
  }

  private async recordReceipt(tx: SchedulerSession, data: Data, command: ReceiptCommand, now: number): Promise<unknown> {
    const attempt = data.attempts.find(item => item.fence === command.fence);
    if (!attempt || attempt.startedAtMs === null) throw new StorageError('STALE_CLAIM', 'Evidence does not identify a started scheduler attempt.');
    if (command.receipt.callId !== data.reservation.intent['callId'] || command.receipt.toolId !== data.reservation.intent['toolId']) conflict();
    const existing = attempt.evidence.find(item => item.evidenceId === command.evidenceId);
    if (existing) { if (!same(existing.receipt, command.receipt)) conflict(); return { disposition: existing.disposition, job: data.job }; }
    if (attempt.evidence.length >= 16) limit();
    const token = { scope: data.job.scope, jobId: data.job.jobId, fence: attempt.fence, workerId: attempt.workerId, leaseUntilMs: attempt.leaseUntilMs };
    const current = this.live(data, token, now) && data.job.state === 'started';
    const known = attempt.evidence.find(item => item.receipt.execution !== 'unknown');
    let disposition: EvidenceDisposition = current ? 'current' : 'late';
    if (known && command.receipt.execution !== 'unknown' && known.receipt.execution !== command.receipt.execution) disposition = 'conflicting';
    attempt.evidence.push({ evidenceId: command.evidenceId, receipt: command.receipt, disposition, recordedAtMs: now });
    if (current && disposition === 'current') {
      if (!data.job.receipt || data.job.receipt.execution === 'unknown' || command.receipt.execution !== 'unknown') data.job.receipt = command.receipt;
      if (command.receipt.execution === 'unknown') await this.unknown(tx, data);
    } else if (data.job.state === 'started') await this.unknown(tx, data);
    await this.save(tx, data, 'job.receipt_recorded', now);
    return { disposition, job: data.job };
  }

  private async recover(input: { scope: string; limit: number }): Promise<unknown> {
    const candidates = await this.backend.transaction(async tx => {
      const now = await this.clock(tx);
      return tx.query<{ job_id: string }>(`SELECT job_id FROM ${this.table('jobs')} WHERE scope = ? AND state IN ('ready','leased','started')
        AND (revoked = 1 OR lease_until <= ? OR deadline_at <= ?) ORDER BY job_id LIMIT ?${this.lock(true)}`, [input.scope, now, now, input.limit]);
    });
    const result: JobRecord[] = [];
    for (const key of candidates) {
      const recovered = await this.backend.transaction(async tx => {
        const data = await this.load(tx, { scope: input.scope, jobId: key.job_id }, true, true); if (!data || terminal.has(data.job.state)) return undefined;
        const j = data.job; const now = await this.clock(tx, data.lastClockMs);
        const deadline = j.deadlineAtMs !== null && j.deadlineAtMs <= now;
        if (!deadline && !j.leaseRevoked && (j.leaseUntilMs === null || j.leaseUntilMs > now)) return undefined;
        j.leaseRevoked = true;
        if (j.state === 'started') await this.unknown(tx, data);
        else {
          const attempt = data.attempts.at(-1); if (attempt) attempt.ended = 'expired';
          j.state = deadline || j.cancelRequested ? 'cancelled' : j.fence >= 128 ? 'blocked' : 'ready';
          j.workerId = null; j.leaseUntilMs = null; j.startedAtMs = null;
          // A ready job no longer has live ownership; it must not be recovered repeatedly.
          j.leaseRevoked = false;
          await this.release(tx, data, false);
        }
        await this.save(tx, data, 'job.recovered', now); return j;
      });
      if (recovered) result.push(recovered);
    }
    return result;
  }
}
