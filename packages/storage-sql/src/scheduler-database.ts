import { jsonValue, type ExecutionReceipt, type JsonObject } from '@mayura/core';
import { StorageError, type StoredEvent, type StoredEventInput } from './contracts.js';
import type { Claim, CompleteJobCommand, EvidenceDisposition, JobKey, JobRecord, JobReservation, ReceiptCommand, SchedulerEvidence } from './scheduler-contracts.js';
import { canonical, evidenceSource, fields, hash, integer, object, reservation, schedulerCommand, schedulerDigest, settlement, type SchedulerMethod } from './scheduler-validation.js';
import { identifier, nextCounter } from './validation.js';
import { writerRequired } from './aggregate-session.js';
import { sqlSchedulerPersistence, sqlSchedulerTransaction, type SchedulerJobRow, type SchedulerPersistence, type SchedulerTransaction } from './scheduler-persistence.js';

/** Internal parameterized SQL seam; implementations own a real short transaction. */
export interface SchedulerSession { query<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]> }
export interface SchedulerBackend {
  readonly dialect: 'sqlite' | 'postgres' | 'mysql'; readonly prefix: string;
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
type Row = SchedulerJobRow;
const STALE = Symbol('stale');
const terminal = new Set(['succeeded','failed','blocked','cancelled','outcome_unknown']);
const eventTypes = new Set(['job.reserved','job.cancelled','job.lease_expired','job.renewed','job.started','job.completed','job.claimed','job.receipt_recorded','job.recovered']);
export class ResourceBusy extends StorageError { constructor() { super('CONFLICT', 'A scheduler resource is already held.'); } }
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
        const evidence = object(item); fields(evidence, ['evidenceId','receipt','disposition','recordedAtMs'], ['settlement','source']);
        const id = identifier(evidence['evidenceId'], 'Stored evidence'); if (evidenceIds.has(id)) failure(); evidenceIds.add(id);
        checkReceipt(evidence['receipt']); integer(evidence['recordedAtMs']);
        if (evidence['settlement'] !== undefined) settlement(evidence['settlement']);
        if (evidence['source'] !== undefined) evidenceSource(evidence['source']);
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

/**
 * Shared state machine; there are no application callbacks inside these transactions. It decides everything a job may
 * do and reads and writes rows only through a `SchedulerPersistence`: the SQL layer's tables for a SQL backend, or a
 * store's own (such as MongoDB's) for anything else.
 */
export class SchedulerDatabase {
  private initialized = false;
  private readonly persistence: SchedulerPersistence;
  private readonly sql: SchedulerBackend | undefined;
  constructor(backend: SchedulerBackend | SchedulerPersistence, private readonly integration?: { runId: string; jobId?: string; events: StoredEventInput[]; clock: { value: number }; admissionExpiresAt?: number }) {
    this.sql = 'dialect' in backend ? backend : undefined;
    this.persistence = 'dialect' in backend ? sqlSchedulerPersistence(backend) : backend;
  }
  /**
   * Internal finite-operation seam. The caller owns the real transaction and aggregate-first locks: a SQL session on a
   * SQL backend, or the store's own scheduler transaction.
   */
  inSession(tx: SchedulerSession | SchedulerTransaction, runId: string, events: StoredEventInput[], jobId?: string, clock = { value: 0 }, admissionExpiresAt?: number): SchedulerDatabase {
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize scheduler storage before integrated use.');
    let transaction: SchedulerTransaction;
    if ('query' in tx) { if (!this.sql) failure(); transaction = sqlSchedulerTransaction(this.sql, tx); } else transaction = tx;
    const within: SchedulerPersistence = { initialize: async () => {}, transaction: <T>(body: (session: SchedulerTransaction) => Promise<T>) => body(transaction) };
    const child = new SchedulerDatabase(within, { runId, events, clock, ...(jobId === undefined ? {} : { jobId }), ...(admissionExpiresAt === undefined ? {} : { admissionExpiresAt }) });
    child.initialized = true; return child;
  }
  private async access(tx: SchedulerTransaction, key: JobKey, mutation: boolean): Promise<string | undefined> {
    const hint = await tx.jobRunId(key);
    if (hint === undefined) return undefined;
    if (this.integration) { if (hint !== this.integration.runId || (this.integration.jobId !== undefined && key.jobId !== this.integration.jobId)) failure(); }
    else {
      await tx.lockAggregate(key.scope, hint);
      if (mutation && await tx.ownedRun(key.scope, hint)) writerRequired();
    }
    return hint;
  }
  private async clock(tx: SchedulerTransaction, floor = 0): Promise<number> {
    const now = await tx.clock();
    if (!Number.isSafeInteger(now) || now < 0) failure();
    const observed = Math.max(floor, now, this.integration?.clock.value ?? 0);
    if (this.integration) this.integration.clock.value = observed;
    return observed;
  }
  private async load(tx: SchedulerTransaction, key: JobKey, locked = false, skip = false): Promise<Data | undefined> {
    const row = await tx.job(key, locked ? (skip ? 'skip' : 'lock') : 'none');
    if (!row) return undefined;
    const data = decode(row);
    const requests = await tx.requests(key);
    // Stored ordering (a SQL collation) need not match JS UTF-16 ordering; compare canonicalized identities.
    if (!same([...requests].sort(), data.job.resourceKeys)) failure();
    const held = await tx.held(key, false);
    const expected = data.job.state === 'outcome_unknown' ? 'quarantined' : ['leased','started'].includes(data.job.state) ? 'held' : undefined;
    if (expected === undefined ? held.length !== 0 : held.length !== data.job.resourceKeys.length
      || held.some(row => !data.job.resourceKeys.includes(row.resource_key) || Number(row.fence) !== data.job.fence || row.disposition !== expected)) failure();
    return data;
  }
  private async append(tx: SchedulerTransaction, data: Data, type: string, now: number): Promise<void> {
    const job = data.job;
    if (this.integration) { this.integration.events.push({ type, data: { nodeId: job.nodeId, jobId: job.jobId, fence: job.fence, state: job.state } }); return; }
    await tx.appendEvent(job.scope, job.runId, type, JSON.stringify({ jobId: job.jobId, fence: job.fence, state: job.state }), new Date(now).toISOString());
  }
  private async save(tx: SchedulerTransaction, data: Data, type: string, now: number): Promise<void> {
    data.lastClockMs = Math.max(data.lastClockMs, now); data.job.version = nextCounter(data.job.version, 1);
    const serialized = JSON.stringify(object(data)); const j = data.job;
    const row: Row = { scope: j.scope, job_id: j.jobId, reservation_key: data.reservation.reservationKey, invocation_id: j.invocationId, run_id: j.runId, digest: schedulerDigest('reservation', data.reservation), state: j.state, due_at: j.dueAtMs, lease_until: j.leaseUntilMs, deadline_at: j.deadlineAtMs, revoked: Number(j.leaseRevoked), version: j.version, data: serialized };
    decode(row);
    await tx.updateJob(row);
    await this.append(tx, data, type, now);
  }
  private async holds(tx: SchedulerTransaction, data: Data): Promise<boolean> {
    const rows = await tx.held({ scope: data.job.scope, jobId: data.job.jobId }, true);
    return rows.length === data.job.resourceKeys.length && rows.every(row => data.job.resourceKeys.includes(row.resource_key) && Number(row.fence) === data.job.fence && row.disposition === 'held');
  }
  private async release(tx: SchedulerTransaction, data: Data, quarantine: boolean): Promise<void> {
    const j = data.job;
    await tx.releaseResources(j.scope, j.jobId, j.fence, quarantine);
  }
  private live(data: Data, token: Claim, now: number): boolean {
    const j = data.job;
    return ['leased','started'].includes(j.state) && j.fence === token.fence && j.workerId === token.workerId && !j.cancelRequested && !j.leaseRevoked && j.leaseUntilMs !== null && j.leaseUntilMs > now && (j.deadlineAtMs === null || j.deadlineAtMs > now);
  }
  /** A tagged stale result commits revocation before the public method raises STALE_CLAIM. */
  private async observeExpiry(tx: SchedulerTransaction, data: Data, now: number): Promise<void> {
    const j = data.job;
    if (['leased','started'].includes(j.state) && !j.leaseRevoked && ((j.leaseUntilMs ?? 0) <= now || (j.deadlineAtMs !== null && j.deadlineAtMs <= now))) {
      j.leaseRevoked = true; await this.save(tx, data, 'job.lease_expired', now);
    }
  }
  /** Inside a workflow, only its own run's (and job's) jobs; otherwise every run no workflow owns. */
  private filter(): { runId?: string; jobId?: string } {
    return this.integration ? { runId: this.integration.runId, ...(this.integration.jobId === undefined ? {} : { jobId: this.integration.jobId }) } : {};
  }
  private token(data: Data): Claim {
    const j = data.job; return { scope: j.scope, jobId: j.jobId, workerId: j.workerId!, fence: j.fence, leaseUntilMs: j.leaseUntilMs! };
  }
  private async unknown(tx: SchedulerTransaction, data: Data): Promise<void> {
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
    await this.persistence.initialize();
    this.initialized = true;
  }

  async execute(method: SchedulerMethod, value: unknown): Promise<unknown> {
    const input = schedulerCommand(method, value);
    if (method === 'initialize') return this.initialize();
    if (!this.initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize scheduler storage before accessing jobs.');
    if (method === 'reserve') return this.reserve(input as unknown as JobReservation);
    if (method === 'claim') return this.claim(input as unknown as { scope: string; workerId: string; limit: number; leaseMs: number });
    if (method === 'recover') return this.recover(input as unknown as { scope: string; limit: number });
    if (method === 'events') return this.persistence.transaction(async tx => {
      const rows = await tx.events(input['scope'] as string, input['runId'] as string, (input['after'] ?? 0) as number, (input['limit'] ?? 1_000) as number);
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
    const result = await this.persistence.transaction(async tx => {
      const runHint = await this.access(tx, key, method !== 'read' && method !== 'receipts');
      // A row lock gives metadata inspection a coherent job/resource projection under READ COMMITTED.
      const data = await this.load(tx, key, true);
      if (!data) { if (method === 'read') return undefined; throw new StorageError('NOT_FOUND', 'Job was not found in this scope.'); }
      if (data.job.runId !== runHint) failure();
      if (method === 'read') return data.job;
      if (method === 'receipts') return data.attempts.find(attempt => attempt.fence === input['fence'])?.evidence ?? [];
      const now = await this.clock(tx, data.lastClockMs);
      // Integrated review authority is tested at exactly the same post-lock instant as the lease.
      // The outer finite reducer commits its never-started expiry disposition before surfacing stale.
      if ((method === 'start' || method === 'renew') && data.job.startedAtMs === null
        && this.integration?.admissionExpiresAt !== undefined && this.integration.admissionExpiresAt <= now) return STALE;
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
    return this.persistence.transaction(async tx => {
      if (this.integration) { if (input.runId !== this.integration.runId) failure(); }
      else {
        await tx.lockRunIdentity(input.scope, input.runId);
        await tx.lockAggregate(input.scope, input.runId);
        if (await tx.ownedRun(input.scope, input.runId)) writerRequired();
      }
      const now = await this.clock(tx); const digest = schedulerDigest('reservation', input);
      const j: Mutable<JobRecord> = {
        scope: input.scope, jobId: input.jobId, runId: input.runId, nodeId: input.nodeId, invocationId: input.invocationId,
        definitionHash: input.definitionHash, candidateHash: input.candidateHash, intent: input.intent, resourceKeys: input.resourceKeys,
        state: 'ready', version: 1, fence: 0, workerId: null, dueAtMs: nextCounter(now, input.delayMs),
        deadlineAtMs: input.deadlineAfterMs === undefined ? null : nextCounter(now, input.deadlineAfterMs),
        leaseUntilMs: null, startedAtMs: null, leaseRevoked: false, cancelRequested: false, receipt: null, output: null,
      };
      const data: Data = { format: 1, job: j, reservation: input, lastClockMs: now, attempts: [], commands: [] };
      const inserted = await tx.insertJob({ scope: j.scope, job_id: j.jobId, reservation_key: input.reservationKey, invocation_id: j.invocationId, run_id: j.runId, digest,
        state: 'ready', due_at: j.dueAtMs, deadline_at: j.deadlineAtMs, lease_until: null, revoked: 0, version: 1, data: JSON.stringify(data) });
      if (!inserted) {
        const existing = await tx.jobByReservation(j.scope, input.reservationKey); if (!existing || existing.digest !== digest) conflict();
        const current = await this.load(tx, { scope: j.scope, jobId: existing.job_id }, true);
        if (!current) failure();
        return { job: current.job, created: false };
      }
      await tx.insertRequests(j.scope, j.jobId, j.resourceKeys);
      await this.append(tx, data, 'job.reserved', now);
      return { job: j, created: true };
    });
  }

  private async claim(input: { scope: string; workerId: string; limit: number; leaseMs: number }): Promise<unknown> {
    const candidates = await this.persistence.transaction(async tx => tx.claimCandidates({ scope: input.scope, now: await this.clock(tx), ...this.filter() }));
    const result: { job: JobRecord; claim: Claim }[] = [];
    for (const candidate of candidates) {
      if (result.length >= input.limit) break;
      try {
        const claimed = await this.persistence.transaction(async tx => {
          const runHint = await this.access(tx, { scope: input.scope, jobId: candidate }, true);
          const data = await this.load(tx, { scope: input.scope, jobId: candidate }, true, true); if (!data || data.job.state !== 'ready') return undefined;
          if (data.job.runId !== runHint) failure();
          const j = data.job; const now = await this.clock(tx, data.lastClockMs);
          if (j.cancelRequested || j.dueAtMs > now || (j.deadlineAtMs !== null && j.deadlineAtMs <= now)) return undefined;
          if (j.fence >= 128) return undefined;
          const fence = j.fence + 1;
          // Redundant logical ownership stops overlap even if a normalized hold row was lost.
          // This is corruption defense, not protection against a privileged writer changing all copies.
          if (await tx.resourceOwnedElsewhere(j.scope, j.jobId)) return undefined;
          for (const resource of j.resourceKeys) {
            if (!await tx.holdResource(j.scope, resource, j.jobId, fence)) throw new ResourceBusy();
          }
          const claimedAt = await this.clock(tx, now);
          if (j.deadlineAtMs !== null && j.deadlineAtMs <= claimedAt) throw new ResourceBusy();
          j.state = 'leased'; j.workerId = input.workerId; j.fence = fence; j.leaseRevoked = false;
          j.leaseUntilMs = Math.min(nextCounter(claimedAt, input.leaseMs), j.deadlineAtMs ?? Number.MAX_SAFE_INTEGER);
          data.attempts.push({ fence, workerId: input.workerId, claimedAtMs: claimedAt, leaseUntilMs: j.leaseUntilMs, startedAtMs: null, ended: null, evidence: [] });
          await this.save(tx, data, 'job.claimed', claimedAt); return { job: j, claim: this.token(data) };
        });
        if (claimed) result.push(claimed);
      } catch (error) { if (this.integration || !(error instanceof ResourceBusy)) throw error; }
    }
    return result;
  }

  private async recordReceipt(tx: SchedulerTransaction, data: Data, command: ReceiptCommand, now: number): Promise<unknown> {
    const attempt = data.attempts.find(item => item.fence === command.fence);
    if (!attempt || attempt.startedAtMs === null) throw new StorageError('STALE_CLAIM', 'Evidence does not identify a started scheduler attempt.');
    if (command.receipt.callId !== data.reservation.intent['callId'] || command.receipt.toolId !== data.reservation.intent['toolId']) conflict();
    const existing = attempt.evidence.find(item => item.evidenceId === command.evidenceId);
    if (existing) {
      const sameSettlement = existing.settlement === undefined || command.settlement === undefined
        ? existing.settlement === command.settlement : same(existing.settlement, command.settlement);
      const sameSource = existing.source === undefined || command.source === undefined
        ? existing.source === command.source : same(existing.source, command.source);
      if (!same(existing.receipt, command.receipt) || !sameSettlement || !sameSource) conflict();
      return { disposition: existing.disposition, job: data.job };
    }
    if (attempt.evidence.length >= 16) limit();
    const token = { scope: data.job.scope, jobId: data.job.jobId, fence: attempt.fence, workerId: attempt.workerId, leaseUntilMs: attempt.leaseUntilMs };
    const current = this.live(data, token, now) && data.job.state === 'started';
    const known = attempt.evidence.find(item => item.receipt.execution !== 'unknown');
    let disposition: EvidenceDisposition = current ? 'current' : 'late';
    if (known && command.receipt.execution !== 'unknown' && known.receipt.execution !== command.receipt.execution) disposition = 'conflicting';
    attempt.evidence.push({ evidenceId: command.evidenceId, receipt: command.receipt,
      ...(command.settlement === undefined ? {} : { settlement: command.settlement }),
      ...(command.source === undefined ? {} : { source: command.source }), disposition, recordedAtMs: now });
    if (current && disposition === 'current') {
      if (!data.job.receipt || data.job.receipt.execution === 'unknown' || command.receipt.execution !== 'unknown') data.job.receipt = command.receipt;
      if (command.receipt.execution === 'unknown') await this.unknown(tx, data);
    } else if (data.job.state === 'started') await this.unknown(tx, data);
    await this.save(tx, data, 'job.receipt_recorded', now);
    return { disposition, job: data.job };
  }

  private async recover(input: { scope: string; limit: number }): Promise<unknown> {
    const candidates = await this.persistence.transaction(async tx => tx.recoverCandidates({ scope: input.scope, now: await this.clock(tx), limit: input.limit, ...this.filter() }));
    const result: JobRecord[] = [];
    for (const key of candidates) {
      const recovered = await this.persistence.transaction(async tx => {
        const runHint = await this.access(tx, { scope: input.scope, jobId: key }, true);
        const data = await this.load(tx, { scope: input.scope, jobId: key }, true, true); if (!data || terminal.has(data.job.state)) return undefined;
        if (data.job.runId !== runHint) failure();
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
