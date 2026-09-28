import { jsonValue, MayuraError, type JsonObject, type JsonValue, type RunEvent } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredRecord } from './contracts.js';
import { workflowHashMaterial } from './workflow-format2.js';

export type RunRecordStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
/** Structurally matches `RunRecordView` in mayura/server. */
export interface RunRecordView {
  readonly runId: string; readonly agentId: string; readonly replicaId: string; readonly status: RunRecordStatus;
  readonly leaseExpiresAtMs: number; readonly cancelRequested: boolean; readonly lastSequence: number;
  readonly snapshot: JsonObject; readonly outcome?: JsonObject;
}
export type RunRecordClaim = { readonly status: 'claimed' }
  | { readonly status: 'existing'; readonly digest: string; readonly runId: string | null; readonly claimedAtMs: number };
/** Structurally matches `AgentServerOptions.runRecords`; the server package does not depend on storage. */
export interface RunRecords {
  claim(input: { readonly owner: string; readonly key: string; readonly digest: string; readonly replicaId: string; readonly nowMs: number; readonly signal?: AbortSignal }): Promise<RunRecordClaim>;
  release(input: { readonly owner: string; readonly key: string; readonly replicaId: string; readonly signal?: AbortSignal }): Promise<void>;
  start(input: { readonly owner: string; readonly key: string; readonly runId: string; readonly agentId: string; readonly replicaId: string;
    readonly leaseExpiresAtMs: number; readonly snapshot: JsonObject; readonly signal?: AbortSignal }): Promise<void>;
  update(input: { readonly owner: string; readonly runId: string; readonly replicaId: string; readonly events: readonly RunEvent[]; readonly snapshot: JsonObject;
    readonly leaseExpiresAtMs: number; readonly outcome?: JsonObject; readonly signal?: AbortSignal })
    : Promise<{ readonly status: 'written'; readonly cancelRequested: boolean } | { readonly status: 'lost' }>;
  read(input: { readonly owner: string; readonly runId: string; readonly signal?: AbortSignal }): Promise<RunRecordView | null>;
  events(input: { readonly owner: string; readonly runId: string; readonly after: number; readonly limit: number; readonly signal?: AbortSignal }): Promise<readonly RunEvent[]>;
  requestCancel(input: { readonly owner: string; readonly runId: string; readonly signal?: AbortSignal }): Promise<RunRecordView | null>;
  abandon(input: { readonly owner: string; readonly runId: string; readonly nowMs: number; readonly signal?: AbortSignal }): Promise<RunRecordView | null>;
}
export interface AggregateRunRecordOptions {
  /** Most events kept per run (default 2,048, at least 16). Later events are summarized by one `events.gap` before `run.completed`. */
  readonly maxEvents?: number;
}

const encoder = new TextEncoder();
async function sha256(domain: string, value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(workflowHashMaterial(domain, value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function digestText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const runIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const replicaPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const statuses = new Set<RunRecordStatus>(['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const eventTypes = new Set(['run.started', 'model.started', 'model.completed', 'tool.started', 'tool.completed', 'hook.started', 'hook.completed',
  'step.started', 'step.completed', 'delegate.started', 'delegate.completed', 'run.completed', 'events.gap', 'output.delta', 'output.withheld']);
/** Outcomes up to this size live in the run record; larger ones in chunk events of a companion aggregate. */
const inlineOutcomeBytes = 262_144; const maxOutcomeBytes = 16_777_216; const chunkChars = 16_384; const chunksPerWrite = 16;
/** One record write carries at most this much event data, well inside the store's one-MiB transaction bound. */
const maxBatchBytes = 786_432; const maxGaps = 64;

interface RunState {
  readonly format: 1; readonly kind: 'run'; readonly runId: string; readonly agentId: string; readonly replicaId: string; readonly status: RunRecordStatus;
  readonly leaseExpiresAtMs: number; readonly cancelRequested: boolean; readonly snapshot: JsonObject;
  /** Run sequence of the last event received, stored or not. */
  readonly lastSequence: number;
  /** Aggregate events written; each holds one run event, and a gap event stands for several sequences. */
  readonly stored: number; readonly gaps: readonly (readonly [number, number])[];
  /** First run sequence not stored because the event bound was reached; summarized as a gap when the run ends. */
  readonly truncatedFrom: number | null;
  readonly outcome: JsonObject | null; readonly outcomeRef: { readonly bytes: number; readonly digest: string } | null;
}
interface ClaimState {
  readonly format: 1; readonly kind: 'claim'; readonly digest: string; readonly runId: string | null; readonly claimedAtMs: number;
  readonly replicaId: string; readonly released: boolean;
}
function integrity(): never { throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored run record failed integrity validation.'); }
function invalid(message: string): never { throw new MayuraError('INVALID_INPUT', message); }
function owner(value: unknown): string { if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) invalid('A run record requires a bounded owner.'); return value; }
function runId(value: unknown): string { if (typeof value !== 'string' || !runIdPattern.test(value)) invalid('A run record requires a run id.'); return value; }
function replica(value: unknown): string { if (typeof value !== 'string' || !replicaPattern.test(value)) invalid('A run record requires a replica id.'); return value; }
function time(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('A run record time must be a nonnegative integer.'); return value as number; }
function snapshotOf(value: unknown, id: string): JsonObject {
  let copy: JsonValue; try { copy = jsonValue(value, { maxBytes: 786_432 }); } catch { return invalid('A run snapshot must be bounded JSON.'); }
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy) || copy['id'] !== id || !statuses.has(copy['status'] as RunRecordStatus)
    || Object.keys(copy).some(key => !['id', 'status', 'budget', 'evidence'].includes(key))) invalid('A run snapshot has an unexpected shape.');
  return copy;
}
function claimState(record: StoredRecord): ClaimState {
  const state = record.state;
  if (state['format'] !== 1 || state['kind'] !== 'claim' || typeof state['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(state['digest'])
    || (state['runId'] !== null && (typeof state['runId'] !== 'string' || !runIdPattern.test(state['runId'])))
    || !Number.isSafeInteger(state['claimedAtMs']) || typeof state['replicaId'] !== 'string' || typeof state['released'] !== 'boolean') integrity();
  return state as unknown as ClaimState;
}
function runState(record: StoredRecord, id: string): RunState {
  const state = record.state; const gaps = state['gaps']; const ref = state['outcomeRef'];
  if (state['format'] !== 1 || state['kind'] !== 'run' || state['runId'] !== id || typeof state['agentId'] !== 'string' || typeof state['replicaId'] !== 'string'
    || !statuses.has(state['status'] as RunRecordStatus) || !Number.isSafeInteger(state['leaseExpiresAtMs']) || typeof state['cancelRequested'] !== 'boolean'
    || state['snapshot'] === null || typeof state['snapshot'] !== 'object' || Array.isArray(state['snapshot'])
    || !Number.isSafeInteger(state['lastSequence']) || !Number.isSafeInteger(state['stored']) || !Array.isArray(gaps) || gaps.length > maxGaps + 1
    || gaps.some(gap => !Array.isArray(gap) || gap.length !== 2 || !Number.isSafeInteger(gap[0]) || !Number.isSafeInteger(gap[1]))
    || (state['truncatedFrom'] !== null && !Number.isSafeInteger(state['truncatedFrom']))
    || (state['outcome'] !== null && (typeof state['outcome'] !== 'object' || Array.isArray(state['outcome'])))
    || (ref !== null && (typeof ref !== 'object' || Array.isArray(ref) || !Number.isSafeInteger(ref['bytes']) || typeof ref['digest'] !== 'string'))
    || ((state['status'] === 'running') !== (state['outcome'] === null && ref === null))) integrity();
  return state as unknown as RunState;
}
function eventData(event: RunEvent): JsonObject {
  return { sequence: event.sequence, timestamp: event.timestamp, metadata: event.metadata as JsonObject };
}

/**
 * Durable agent run records for `AgentServerOptions.runRecords`, on any aggregate store (SQLite or PostgreSQL). Every
 * owner's records live under a scope derived from it, so one caller can never read another's runs. Records are
 * permanent, like submission claims: each keeps the run's snapshot, at most `maxEvents` content-free metadata events
 * and its outcome.
 */
export function createAggregateRunRecords(store: AggregateStore, options: AggregateRunRecordOptions = {}): RunRecords {
  if (!store || typeof store.create !== 'function' || typeof store.update !== 'function' || typeof store.events !== 'function')
    throw new MayuraError('INVALID_CONFIG', 'Run records require an aggregate store.');
  const maxEvents = options.maxEvents ?? 2_048;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 16 || maxEvents > 65_536) throw new MayuraError('INVALID_CONFIG', 'maxEvents must be an integer from 16 to 65,536.');
  let definitionHash: Promise<string> | undefined;
  const format = (): Promise<string> => (definitionHash ??= sha256('mayura:run-records-format:v1', {}));
  const scopeOf = (value: string): Promise<string> => sha256('mayura:run-records-scope:v1', { owner: value });
  const claimId = (value: string, key: string): Promise<string> => sha256('mayura:run-records-claim:v1', { owner: value, key });
  /** Compare-and-set with a bounded number of fresh attempts: concurrent writers are cancel requests and abandonment. */
  const retrying = async <T>(signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> => {
    for (let tries = 0; ; tries++) {
      signal?.throwIfAborted();
      try { return await attempt(); } catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT' || tries >= 8) throw error; }
    }
  };
  const readRun = async (scope: string, id: string): Promise<{ record: StoredRecord; state: RunState } | null> => {
    const record = await store.read(scope, `run:${id}`); return record ? { record, state: runState(record, id) } : null;
  };
  const outcomeOf = async (scope: string, state: RunState): Promise<JsonObject | undefined> => {
    if (state.outcome) return state.outcome;
    if (!state.outcomeRef) return undefined;
    const id = `outcome:${state.runId}`; let text = ''; let after = 0;
    for (;;) {
      const page = await store.events(scope, id, after);
      for (const event of page) { const chunk = event.data['text']; if (typeof chunk !== 'string') integrity(); text += chunk; after = event.sequence; }
      if (page.length < 1_000) break;
    }
    if (encoder.encode(text).byteLength !== state.outcomeRef.bytes || await digestText(text) !== state.outcomeRef.digest) integrity();
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { return integrity(); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) integrity();
    return parsed as JsonObject;
  };
  const view = async (scope: string, state: RunState): Promise<RunRecordView> => {
    const outcome = await outcomeOf(scope, state);
    return Object.freeze({ runId: state.runId, agentId: state.agentId, replicaId: state.replicaId, status: state.status, leaseExpiresAtMs: state.leaseExpiresAtMs,
      cancelRequested: state.cancelRequested, lastSequence: state.lastSequence, snapshot: state.snapshot, ...(outcome ? { outcome } : {}) });
  };
  /** Store a large outcome as ordered chunk events of its own aggregate; a retried write continues where it stopped. */
  const storeOutcome = async (scope: string, id: string, text: string): Promise<{ bytes: number; digest: string }> => {
    const bytes = encoder.encode(text).byteLength; const digest = await digestText(text); const hash = await format();
    const chunks: string[] = []; for (let index = 0; index < text.length; index += chunkChars) chunks.push(text.slice(index, index + chunkChars));
    const aggregate = `outcome:${id}`; let record = await store.read(scope, aggregate);
    if (!record) {
      const created = await store.create({ scope, id: aggregate, idempotencyKey: aggregate, definitionHash: hash, state: { format: 1, digest, written: Math.min(chunks.length, chunksPerWrite) },
        events: chunks.slice(0, chunksPerWrite).map(chunk => ({ type: 'outcome.chunk', data: { text: chunk } })) });
      record = created.record;
    }
    // An earlier, interrupted attempt for a different outcome cannot be completed with this one.
    if (record.state['digest'] !== digest || !Number.isSafeInteger(record.state['written'])) integrity();
    while ((record.state['written'] as number) < chunks.length) {
      const written = record.state['written'] as number; const next = chunks.slice(written, written + chunksPerWrite);
      record = await store.update({ scope, id: aggregate, expectedVersion: record.version, state: { format: 1, digest, written: written + next.length },
        events: next.map(chunk => ({ type: 'outcome.chunk', data: { text: chunk } })) });
    }
    return { bytes, digest };
  };

  return Object.freeze<RunRecords>({
    async claim(input) {
      const who = owner(input?.owner); replica(input.replicaId); time(input.nowMs);
      if (typeof input.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.key) || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest))
        invalid('A submission claim requires a bounded key and a request digest.');
      input.signal?.throwIfAborted();
      const scope = await scopeOf(who); const id = await claimId(who, input.key);
      const fresh = { format: 1, kind: 'claim', digest: input.digest, runId: null, claimedAtMs: input.nowMs, replicaId: input.replicaId, released: false };
      return retrying(input.signal, async () => {
        const existing = await store.read(scope, id);
        if (!existing) {
          try {
            const created = await store.create({ scope, id, idempotencyKey: id, definitionHash: await format(), state: fresh, events: [{ type: 'submission.claimed', data: {} }] });
            if (created.created) return { status: 'claimed' as const };
          } catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
          const winner = claimState((await store.read(scope, id)) ?? integrity());
          return { status: 'existing' as const, digest: winner.digest, runId: winner.runId, claimedAtMs: winner.claimedAtMs };
        }
        const state = claimState(existing);
        if (state.released) {
          // A claim given back before its run started: the next claimant takes it over atomically.
          await store.update({ scope, id, expectedVersion: existing.version, state: fresh, events: [{ type: 'submission.claimed', data: {} }] });
          return { status: 'claimed' as const };
        }
        return { status: 'existing' as const, digest: state.digest, runId: state.runId, claimedAtMs: state.claimedAtMs };
      });
    },
    async release(input) {
      const who = owner(input?.owner); replica(input.replicaId);
      if (typeof input.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.key)) invalid('A submission release requires its key.');
      const scope = await scopeOf(who); const id = await claimId(who, input.key);
      await retrying(input.signal, async () => {
        const existing = await store.read(scope, id); if (!existing) return;
        const state = claimState(existing);
        // Only the claimant may give back a claim, and only before its run was bound.
        if (state.replicaId !== input.replicaId || state.runId !== null || state.released) return;
        await store.update({ scope, id, expectedVersion: existing.version, state: { ...state, released: true }, events: [{ type: 'submission.released', data: {} }] });
      });
    },
    async start(input) {
      const who = owner(input?.owner); const id = runId(input.runId); replica(input.replicaId); time(input.leaseExpiresAtMs);
      if (typeof input.agentId !== 'string' || !identifier.test(input.agentId)) invalid('A run record requires an agent id.');
      if (typeof input.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.key)) invalid('A run record requires its submission key.');
      const snapshot = snapshotOf(input.snapshot, id); input.signal?.throwIfAborted();
      const scope = await scopeOf(who); const hash = await format();
      const state: RunState = { format: 1, kind: 'run', runId: id, agentId: input.agentId, replicaId: input.replicaId, status: 'running',
        leaseExpiresAtMs: input.leaseExpiresAtMs, cancelRequested: false, snapshot: { ...snapshot, status: 'running' }, lastSequence: 0, stored: 0, gaps: [],
        truncatedFrom: null, outcome: null, outcomeRef: null };
      const created = await store.create({ scope, id: `run:${id}`, idempotencyKey: `run:${id}`, definitionHash: hash, state: state as unknown as JsonObject, events: [] });
      if (!created.created && (created.record.state['replicaId'] !== input.replicaId || created.record.state['kind'] !== 'run')) integrity();
      // Bind the submission key to the run, so every replica can replay it.
      const claim = await claimId(who, input.key);
      await retrying(input.signal, async () => {
        const existing = await store.read(scope, claim); if (!existing) integrity();
        const current = claimState(existing);
        if (current.runId === id) return;
        if (current.runId !== null || current.replicaId !== input.replicaId || current.released) integrity();
        await store.update({ scope, id: claim, expectedVersion: existing.version, state: { ...current, runId: id }, events: [{ type: 'submission.started', data: {} }] });
      });
    },
    async update(input) {
      const who = owner(input?.owner); const id = runId(input.runId); replica(input.replicaId); time(input.leaseExpiresAtMs);
      const snapshot = snapshotOf(input.snapshot, id);
      if (!Array.isArray(input.events) || input.events.length > 1_000) invalid('A run record update carries at most 1,000 events.');
      let outcomeText: string | undefined;
      if (input.outcome !== undefined) {
        try { outcomeText = JSON.stringify(jsonValue(input.outcome, { maxBytes: maxOutcomeBytes })); } catch { invalid('A run outcome must be JSON of at most 16 MiB.'); }
        if (!statuses.has(input.outcome['status'] as RunRecordStatus) || input.outcome['status'] === 'running') invalid('A run outcome needs a final status.');
      }
      input.signal?.throwIfAborted();
      const scope = await scopeOf(who);
      // Events are written in batches that fit one transaction; the outcome goes with the last batch.
      let remaining = [...input.events]; let cancelRequested = false;
      do {
        let bytes = 0; let count = 0;
        while (count < remaining.length) {
          bytes += encoder.encode(JSON.stringify(eventData(remaining[count]!))).byteLength + 64;
          if (count > 0 && bytes > maxBatchBytes) break; count++;
        }
        const batch = remaining.slice(0, count); remaining = remaining.slice(count); const final = remaining.length === 0 && outcomeText !== undefined;
        const ref = final && encoder.encode(outcomeText!).byteLength > inlineOutcomeBytes ? await storeOutcome(scope, id, outcomeText!) : null;
        const result = await retrying(input.signal, async () => {
          const current = await readRun(scope, id);
          if (!current) integrity();
          if (current.state.replicaId !== input.replicaId || current.state.status !== 'running') return 'lost' as const;
          let { lastSequence, stored, truncatedFrom } = current.state; const gaps = current.state.gaps.map(gap => [gap[0], gap[1]] as [number, number]);
          const appended: { type: string; data: JsonObject }[] = [];
          const keep = (event: RunEvent): void => { appended.push({ type: event.type, data: eventData(event) }); stored++; };
          for (const event of batch) {
            const gap = event?.type === 'events.gap';
            if (!event || event.runId !== id || !eventTypes.has(event.type) || !Number.isSafeInteger(event.sequence) || typeof event.timestamp !== 'string' || event.timestamp.length > 64
              || event.metadata === null || typeof event.metadata !== 'object' || (gap ? event.metadata['from'] !== lastSequence + 1 || event.metadata['to'] !== event.sequence || event.sequence <= lastSequence
                : event.sequence !== lastSequence + 1)) invalid('Run events must continue the recorded sequence.');
            let size = 0; try { size = encoder.encode(JSON.stringify(jsonValue(event.metadata, { maxBytes: 16_384 }))).byteLength; } catch { size = Infinity; }
            const from = gap ? event.metadata['from'] as number : event.sequence;
            // Two slots stay free for the closing gap and run.completed, so a truncated history still ends truthfully.
            const room = truncatedFrom === null && size <= 16_384 && stored < maxEvents - 2 && (!gap || gaps.length < maxGaps);
            if (event.type === 'run.completed' && truncatedFrom !== null) {
              if (truncatedFrom <= event.sequence - 1) {
                gaps.push([truncatedFrom, event.sequence - 1]);
                keep({ runId: id, sequence: event.sequence - 1, timestamp: event.timestamp, type: 'events.gap', metadata: { from: truncatedFrom, to: event.sequence - 1 } });
              }
              truncatedFrom = null; keep(event);
            } else if (room || (event.type === 'run.completed' && stored < maxEvents)) { if (gap) gaps.push([from, event.sequence]); keep(event); }
            else if (truncatedFrom === null) truncatedFrom = from;
            lastSequence = event.sequence;
          }
          let status: RunRecordStatus = 'running'; let outcome: JsonObject | null = null;
          if (final) {
            status = input.outcome!['status'] as RunRecordStatus;
            // A history that never reached run.completed still ends with a gap for what was not kept.
            if (truncatedFrom !== null && truncatedFrom <= lastSequence) {
              gaps.push([truncatedFrom, lastSequence]);
              keep({ runId: id, sequence: lastSequence, timestamp: new Date().toISOString(), type: 'events.gap', metadata: { from: truncatedFrom, to: lastSequence } });
              truncatedFrom = null;
            }
            if (!ref) outcome = JSON.parse(outcomeText!) as JsonObject;
          }
          const state: RunState = { ...current.state, leaseExpiresAtMs: input.leaseExpiresAtMs, snapshot: { ...snapshot, status: final ? status : 'running' },
            lastSequence, stored, gaps, truncatedFrom, status, outcome, outcomeRef: final ? ref : null };
          await store.update({ scope, id: `run:${id}`, expectedVersion: current.record.version, state: state as unknown as JsonObject, events: appended });
          return current.state.cancelRequested;
        });
        if (result === 'lost') return { status: 'lost' as const };
        cancelRequested = result;
      } while (remaining.length > 0);
      return { status: 'written' as const, cancelRequested };
    },
    async read(input) {
      const scope = await scopeOf(owner(input?.owner)); const id = runId(input.runId); input.signal?.throwIfAborted();
      const current = await readRun(scope, id); return current ? view(scope, current.state) : null;
    },
    async events(input) {
      const scope = await scopeOf(owner(input?.owner)); const id = runId(input.runId);
      if (!Number.isSafeInteger(input.after) || input.after < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) invalid('Event reads need a cursor and a limit from 1 to 1,000.');
      input.signal?.throwIfAborted();
      const current = await readRun(scope, id); if (!current) return [];
      // Map the run sequence to the aggregate position: each stored gap stands for (to - from + 1) sequences in one slot.
      let shift = 0; let position: number | undefined;
      for (const [from, to] of current.state.gaps) {
        if (to <= input.after) shift += to - from;
        else if (from <= input.after) { position = from - 1 - shift; break; }
        else break;
      }
      position = Math.min(position ?? input.after - shift, current.state.stored);
      const page = await store.events(scope, `run:${id}`, position);
      const result: RunEvent[] = [];
      for (const stored of page.slice(0, input.limit)) {
        const data = stored.data; const sequence = data['sequence']; const metadata = data['metadata'];
        if (!Number.isSafeInteger(sequence) || typeof data['timestamp'] !== 'string' || metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
          || !eventTypes.has(stored.type)) integrity();
        let item: RunEvent = Object.freeze({ runId: id, sequence: sequence as number, timestamp: data['timestamp'], type: stored.type as RunEvent['type'],
          metadata: Object.freeze({ ...(metadata as Record<string, string | number | boolean>) }) });
        // A reader that stopped inside a gap sees the rest of that gap from its own position.
        if (result.length === 0 && item.type === 'events.gap' && (item.metadata['from'] as number) <= input.after) {
          if (item.sequence <= input.after) continue;
          item = Object.freeze({ ...item, metadata: Object.freeze({ from: input.after + 1, to: item.sequence }) });
        }
        if (item.sequence <= input.after) continue;
        result.push(item);
      }
      return Object.freeze(result);
    },
    async requestCancel(input) {
      const scope = await scopeOf(owner(input?.owner)); const id = runId(input.runId);
      return retrying(input.signal, async () => {
        const current = await readRun(scope, id); if (!current) return null;
        if (current.state.status !== 'running' || current.state.cancelRequested) return view(scope, current.state);
        const state = { ...current.state, cancelRequested: true };
        await store.update({ scope, id: `run:${id}`, expectedVersion: current.record.version, state: state as unknown as JsonObject, events: [] });
        return view(scope, state);
      });
    },
    async abandon(input) {
      const scope = await scopeOf(owner(input?.owner)); const id = runId(input.runId); const now = time(input.nowMs);
      return retrying(input.signal, async () => {
        const current = await readRun(scope, id); if (!current) return null;
        if (current.state.status !== 'running' || current.state.leaseExpiresAtMs >= now) return view(scope, current.state);
        // The owner stopped renewing: nobody can say what its run did, so the record ends as outcome_unknown.
        const evidence = current.state.snapshot['evidence'] ?? [];
        const outcome: JsonObject = { status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN',
          message: 'The server replica running this run stopped before recording its outcome. Effects it started may or may not have happened.' }, evidence };
        const timestamp = new Date().toISOString(); const gaps = current.state.gaps.map(gap => [gap[0], gap[1]] as [number, number]);
        const appended: { type: string; data: JsonObject }[] = []; let { lastSequence, truncatedFrom } = current.state;
        if (truncatedFrom !== null && truncatedFrom <= lastSequence) {
          gaps.push([truncatedFrom, lastSequence]);
          appended.push({ type: 'events.gap', data: { sequence: lastSequence, timestamp, metadata: { from: truncatedFrom, to: lastSequence } } }); truncatedFrom = null;
        }
        lastSequence += 1;
        appended.push({ type: 'run.completed', data: { sequence: lastSequence, timestamp, metadata: { status: 'outcome_unknown' } } });
        const state: RunState = { ...current.state, status: 'outcome_unknown', snapshot: { ...current.state.snapshot, status: 'outcome_unknown' }, outcome, outcomeRef: null,
          gaps, truncatedFrom, lastSequence, stored: current.state.stored + appended.length };
        await store.update({ scope, id: `run:${id}`, expectedVersion: current.record.version, state: state as unknown as JsonObject, events: appended });
        return view(scope, state);
      });
    },
  });
}
