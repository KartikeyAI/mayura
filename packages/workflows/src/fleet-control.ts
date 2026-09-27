import { freezeJson, jsonValue, MayuraError, type ErrorCode, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import type { WorkflowGraphDiscovery } from './graph-discovery.js';
import type { WorkflowLifecycleFleetRuntime } from './lifecycle-fleet.js';
import type { WorkflowCompositeFleetRuntime } from './composite-fleet.js';

/** Minimal durable hold reader that hosts and coordinators consult before driving a page. */
export interface WorkflowFleetHoldReader { isHeld(): Promise<boolean> }
export interface WorkflowFleetHoldState {
  readonly held: boolean;
  /** Increments each time the scope enters the held state. */
  readonly generation: number;
  readonly changedAtMs: number | null;
}
/** One format's pausable population. Discovery candidates are hints; every pause/resume goes through the format runtime. */
export interface WorkflowFleetTarget {
  readonly name: string;
  discover(cursor: JsonValue | null, limit: number): Promise<{ readonly runIds: readonly string[]; readonly nextCursor: JsonValue | null }>;
  inspect(runId: string): Promise<{ readonly status: string }>;
  pause(runId: string): Promise<{ readonly status: string }>;
  resume(runId: string): Promise<{ readonly status: string }>;
}
export type WorkflowFleetSweepOutcome =
  | { readonly target: string; readonly runId: string; readonly outcome: 'paused' | 'already_paused' | 'terminal' | 'busy' }
  | { readonly target: string; readonly runId: string; readonly outcome: 'resumed' | 'not_paused' | 'missing' | 'unregistered' }
  | { readonly target: string; readonly runId: string; readonly outcome: 'failed'; readonly code: ErrorCode };
export interface WorkflowFleetSweepCursor { readonly format: 1; readonly scope: string; readonly phase: 'pause' | 'resume'; readonly position: number; readonly inner: JsonValue | null }
export interface WorkflowFleetSweepReport {
  readonly outcomes: readonly WorkflowFleetSweepOutcome[];
  /** Null once every target (pause) or ledger shard (resume) has been visited. */
  readonly nextCursor: WorkflowFleetSweepCursor | null;
}
export interface WorkflowFleetControl extends WorkflowFleetHoldReader {
  inspect(): Promise<WorkflowFleetHoldState>;
  /** Durably hold the scope. Idempotent; hosts and coordinators configured with this control stop driving runs. */
  hold(): Promise<WorkflowFleetHoldState>;
  /** Durably lift the hold. Idempotent; it resumes no run by itself. */
  release(): Promise<WorkflowFleetHoldState>;
  /** While held, pause one discovery page of runs and record exactly which runs this fleet paused. */
  sweepPause(targets: readonly WorkflowFleetTarget[], command?: { readonly cursor?: WorkflowFleetSweepCursor | null; readonly limit?: number }): Promise<WorkflowFleetSweepReport>;
  /** After release, resume only runs this fleet paused, never runs paused individually. */
  sweepResume(targets: readonly WorkflowFleetTarget[], command?: { readonly cursor?: WorkflowFleetSweepCursor | null; readonly limit?: number }): Promise<WorkflowFleetSweepReport>;
}
export interface WorkflowFleetControlOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  readonly now?: () => number;
}

interface HoldState { format: 1; held: boolean; generation: number; changedAtMs: number | null }
interface LedgerEntry { target: string; runId: string; state: 'pending' | 'confirmed' }
interface LedgerState { format: 1; shard: number; entries: LedgerEntry[] }
const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const runPattern = /^[a-f0-9]{64}$/;
const namePattern = /^[a-z][a-z0-9-]{0,31}$/;
const shardCapacity = 256;
const retries = 32;
const codes = new Set<ErrorCode>(['INVALID_INPUT', 'PERMISSION_DENIED', 'LIMIT_EXCEEDED', 'CANCELLED', 'TIMEOUT', 'UNSUPPORTED_PROFILE',
  'NOT_FOUND', 'CONFLICT', 'STORAGE_UNAVAILABLE']);
const code = (error: unknown): ErrorCode => error instanceof MayuraError && codes.has(error.code) ? error.code : 'STORAGE_UNAVAILABLE';
const isCode = (error: unknown, expected: string): boolean =>
  (error instanceof MayuraError || error instanceof StorageError) && error.code === expected;

/** Durable per-scope fleet hold plus an exact ledger of the runs a fleet pause paused. */
export function createWorkflowFleetControl(options: WorkflowFleetControlOptions): WorkflowFleetControl {
  const { store } = options;
  if (!store || typeof store.read !== 'function' || typeof store.create !== 'function' || typeof store.update !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'Fleet control requires an aggregate store.');
  }
  const scope = digest('mayura:scope:v1', { principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  const holdId = digest('mayura:workflow-fleet-hold:v1', { scope });
  const ledgerId = (shard: number): string => digest('mayura:workflow-fleet-ledger:v1', { scope, shard });
  const now = (): number => {
    const value = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted fleet clock returned an invalid timestamp.');
    return value;
  };
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof MayuraError || isCode(error, 'CONFLICT')) throw error;
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Fleet control storage is unavailable.');
    }
  };
  const holdFrom = (record: StoredRecord | undefined): HoldState => {
    if (!record) return { format: 1, held: false, generation: 0, changedAtMs: null };
    const state = record.state;
    if (record.scope !== scope || record.id !== holdId || state['format'] !== 1 || typeof state['held'] !== 'boolean'
      || !Number.isSafeInteger(state['generation']) || (state['generation'] as number) < 0
      || (state['changedAtMs'] !== null && !Number.isSafeInteger(state['changedAtMs']))) {
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored fleet hold failed integrity validation.');
    }
    return { format: 1, held: state['held'], generation: state['generation'] as number, changedAtMs: state['changedAtMs'] as number | null };
  };
  const publicHold = (state: HoldState): WorkflowFleetHoldState =>
    freezeJson(jsonValue({ held: state.held, generation: state.generation, changedAtMs: state.changedAtMs })) as unknown as WorkflowFleetHoldState;
  const inspect = async (): Promise<WorkflowFleetHoldState> => publicHold(holdFrom(await guarded(() => store.read(scope, holdId))));

  const transition = async (held: boolean): Promise<WorkflowFleetHoldState> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      const record = await guarded(() => store.read(scope, holdId)); const current = holdFrom(record);
      if (current.held === held) return publicHold(current);
      const next: HoldState = { format: 1, held, generation: held ? current.generation + 1 : current.generation, changedAtMs: now() };
      const event = { type: held ? 'fleet.held' : 'fleet.released', data: { generation: next.generation } };
      try {
        if (!record) {
          const created = await store.create({ scope, id: holdId, idempotencyKey: holdId, definitionHash: digest('mayura:workflow-fleet-hold-format:v1', {}),
            state: jsonValue(next) as JsonObject, events: [event] });
          if (!created.created) continue;
        } else await store.update({ scope, id: holdId, expectedVersion: record.version, state: jsonValue(next) as JsonObject, events: [event] });
        return publicHold(next);
      } catch (error) {
        if (isCode(error, 'CONFLICT')) continue;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Fleet hold transition could not be confirmed.');
      }
    }
    throw new MayuraError('CONFLICT', 'Fleet hold remained busy after bounded retries.');
  };

  const ledgerFrom = (record: StoredRecord | undefined, shard: number): LedgerState => {
    if (!record) return { format: 1, shard, entries: [] };
    const state = record.state; const entries = state['entries'];
    if (record.scope !== scope || record.id !== ledgerId(shard) || state['format'] !== 1 || state['shard'] !== shard
      || !Array.isArray(entries) || entries.length > shardCapacity) throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored fleet ledger failed integrity validation.');
    return { format: 1, shard, entries: entries.map(raw => {
      const entry = raw as JsonObject;
      if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 3 || typeof entry['target'] !== 'string' || !namePattern.test(entry['target'])
        || typeof entry['runId'] !== 'string' || !runPattern.test(entry['runId']) || parseInt(entry['runId'].slice(0, 2), 16) !== shard
        || !['pending', 'confirmed'].includes(entry['state'] as string)) throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored fleet ledger failed integrity validation.');
      return { target: entry['target'], runId: entry['runId'], state: entry['state'] as LedgerEntry['state'] };
    }) };
  };
  /** Apply one bounded change to a ledger shard with compare-and-set retries. */
  const editLedger = async (shard: number, change: (entries: LedgerEntry[]) => boolean): Promise<void> => {
    for (let attempt = 0; attempt < retries; attempt++) {
      const record = await guarded(() => store.read(scope, ledgerId(shard))); const state = ledgerFrom(record, shard);
      if (!change(state.entries)) return;
      if (state.entries.length > shardCapacity) throw new MayuraError('LIMIT_EXCEEDED', 'Fleet ledger shard is full.');
      state.entries.sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : left.target < right.target ? -1 : 1);
      const event = { type: 'fleet.ledger.updated', data: { shard, entries: state.entries.length } };
      try {
        if (!record) {
          const created = await store.create({ scope, id: ledgerId(shard), idempotencyKey: ledgerId(shard),
            definitionHash: digest('mayura:workflow-fleet-ledger-format:v1', {}), state: jsonValue(state) as JsonObject, events: [event] });
          if (!created.created) continue;
        } else await store.update({ scope, id: ledgerId(shard), expectedVersion: record.version, state: jsonValue(state) as JsonObject, events: [event] });
        return;
      } catch (error) {
        if (isCode(error, 'CONFLICT')) continue;
        if (error instanceof MayuraError) throw error;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Fleet ledger update could not be confirmed.');
      }
    }
    throw new MayuraError('CONFLICT', 'Fleet ledger remained busy after bounded retries.');
  };
  const shardOf = (runId: string): number => parseInt(runId.slice(0, 2), 16);
  const setEntry = (target: string, runId: string, state: LedgerEntry['state'] | null): Promise<void> => editLedger(shardOf(runId), entries => {
    const index = entries.findIndex(entry => entry.target === target && entry.runId === runId);
    if (state === null) { if (index < 0) return false; entries.splice(index, 1); return true; }
    if (index >= 0) { if (entries[index]!.state === state) return false; entries[index] = { target, runId, state }; return true; }
    entries.push({ target, runId, state }); return true;
  });

  const admitTargets = (targets: readonly WorkflowFleetTarget[]): Map<string, WorkflowFleetTarget> => {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 16) throw new MayuraError('INVALID_INPUT', 'Fleet sweeps require 1–16 targets.');
    const byName = new Map<string, WorkflowFleetTarget>();
    for (const target of targets) {
      if (!target || typeof target.name !== 'string' || !namePattern.test(target.name) || byName.has(target.name)
        || ['discover', 'inspect', 'pause', 'resume'].some(method => typeof (target as unknown as Record<string, unknown>)[method] !== 'function')) {
        throw new MayuraError('INVALID_INPUT', 'Fleet targets require unique names and discover/inspect/pause/resume methods.');
      }
      byName.set(target.name, target);
    }
    return byName;
  };
  const admitCommand = (command: { readonly cursor?: WorkflowFleetSweepCursor | null; readonly limit?: number } | undefined,
    phase: 'pause' | 'resume', positions: number, fallback: number): { position: number; inner: JsonValue | null; limit: number } => {
    const limit = command?.limit ?? fallback;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new MayuraError('INVALID_INPUT', 'Fleet sweep limit must be 1–128.');
    const cursor = command?.cursor ?? null;
    if (cursor === null) return { position: 0, inner: null, limit };
    if (typeof cursor !== 'object' || cursor.format !== 1 || cursor.scope !== scope || cursor.phase !== phase
      || !Number.isSafeInteger(cursor.position) || cursor.position < 0 || cursor.position >= positions) {
      throw new MayuraError('INVALID_INPUT', 'Fleet sweep cursor does not match this scope, phase or target list.');
    }
    return { position: cursor.position, inner: cursor.inner === undefined ? null : jsonValue(cursor.inner), limit };
  };
  const cursorFor = (phase: 'pause' | 'resume', position: number, inner: JsonValue | null): WorkflowFleetSweepCursor =>
    freezeJson(jsonValue({ format: 1, scope, phase, position, inner })) as unknown as WorkflowFleetSweepCursor;
  const report = (outcomes: WorkflowFleetSweepOutcome[], nextCursor: WorkflowFleetSweepCursor | null): WorkflowFleetSweepReport =>
    freezeJson(jsonValue({ outcomes, nextCursor })) as unknown as WorkflowFleetSweepReport;
  const statusOf = async (target: WorkflowFleetTarget, runId: string): Promise<string> => (await target.inspect(runId)).status;

  return Object.freeze<WorkflowFleetControl>({
    inspect,
    isHeld: async () => (await inspect()).held,
    hold: () => transition(true),
    release: () => transition(false),
    async sweepPause(targets, command) {
      const byName = admitTargets(targets); const list = [...byName.values()];
      const { position, inner, limit } = admitCommand(command, 'pause', list.length, 32);
      if (!(await inspect()).held) throw new MayuraError('CONFLICT', 'Hold the fleet before sweeping it into the paused state.');
      const target = list[position]!; const page = await target.discover(inner, limit); const outcomes: WorkflowFleetSweepOutcome[] = [];
      if (!Array.isArray(page.runIds) || page.runIds.length > limit) throw new MayuraError('STORAGE_UNAVAILABLE', 'Fleet target returned an invalid discovery page.');
      for (const runId of page.runIds) {
        if (typeof runId !== 'string' || !runPattern.test(runId)) throw new MayuraError('STORAGE_UNAVAILABLE', 'Fleet target returned an invalid run identity.');
        try {
          const before = await statusOf(target, runId);
          if (terminal.has(before)) { outcomes.push({ target: target.name, runId, outcome: 'terminal' }); continue; }
          if (before === 'paused') { outcomes.push({ target: target.name, runId, outcome: 'already_paused' }); continue; }
          // Record intent first: a crash after the pause but before confirmation must still be resumable by the fleet.
          await setEntry(target.name, runId, 'pending');
          try { await target.pause(runId); await setEntry(target.name, runId, 'confirmed'); outcomes.push({ target: target.name, runId, outcome: 'paused' }); }
          catch (error) {
            if (!isCode(error, 'CONFLICT')) throw error;
            const after = await statusOf(target, runId);
            // Only a pause this sweep committed may stay in the ledger.
            if (after === 'paused') { await setEntry(target.name, runId, 'confirmed'); outcomes.push({ target: target.name, runId, outcome: 'paused' }); }
            else { await setEntry(target.name, runId, null); outcomes.push({ target: target.name, runId, outcome: terminal.has(after) ? 'terminal' : 'busy' }); }
          }
        } catch (error) {
          // Keep any pending entry: the pause may have committed, and the resume sweep settles pending entries safely.
          outcomes.push({ target: target.name, runId, outcome: 'failed', code: code(error) });
        }
      }
      const nextInner = page.nextCursor === undefined ? null : page.nextCursor;
      const next = nextInner !== null ? cursorFor('pause', position, nextInner) : position + 1 < list.length ? cursorFor('pause', position + 1, null) : null;
      return report(outcomes, next);
    },
    async sweepResume(targets, command) {
      const byName = admitTargets(targets); const { position, inner, limit } = admitCommand(command, 'resume', 256, 64);
      if (inner !== null && (typeof inner !== 'string' || inner.length > 128)) throw new MayuraError('INVALID_INPUT', 'Fleet sweep cursor does not match this scope, phase or target list.');
      if ((await inspect()).held) throw new MayuraError('CONFLICT', 'Release the fleet hold before resuming the runs it paused.');
      const outcomes: WorkflowFleetSweepOutcome[] = []; const key = (entry: LedgerEntry): string => `${entry.runId}/${entry.target}`;
      // Entries are sorted, so the last visited key resumes a partially processed shard without revisiting retained entries.
      let shard = position; let after = inner as string | null; let last: string | null = null;
      for (; shard < 256; shard++, after = null) {
        const { entries } = ledgerFrom(await guarded(() => store.read(scope, ledgerId(shard))), shard);
        const pending = entries.filter(entry => after === null || key(entry) > after);
        for (const entry of pending) {
          if (outcomes.length >= limit) break;
          last = key(entry);
          const target = byName.get(entry.target);
          if (!target) { outcomes.push({ target: entry.target, runId: entry.runId, outcome: 'unregistered' }); continue; }
          try {
            let status: string;
            try { status = await statusOf(target, entry.runId); }
            catch (error) { if (!isCode(error, 'NOT_FOUND')) throw error; await setEntry(entry.target, entry.runId, null); outcomes.push({ target: entry.target, runId: entry.runId, outcome: 'missing' }); continue; }
            if (status === 'paused') {
              try { await target.resume(entry.runId); outcomes.push({ target: entry.target, runId: entry.runId, outcome: 'resumed' }); }
              catch (error) { if (!isCode(error, 'CONFLICT') || (await statusOf(target, entry.runId)) === 'paused') throw error; outcomes.push({ target: entry.target, runId: entry.runId, outcome: 'not_paused' }); }
            } else outcomes.push({ target: entry.target, runId: entry.runId, outcome: 'not_paused' });
            await setEntry(entry.target, entry.runId, null);
          } catch (error) { outcomes.push({ target: entry.target, runId: entry.runId, outcome: 'failed', code: code(error) }); }
        }
        if (outcomes.length >= limit) {
          const remaining = pending.some(entry => key(entry) > last!);
          return report(outcomes, remaining ? cursorFor('resume', shard, last) : shard + 1 < 256 ? cursorFor('resume', shard + 1, null) : null);
        }
      }
      return report(outcomes, null);
    },
  });
}

/** Format-5 lifecycle fleet runs, discovered through the fleet index. */
export function lifecycleFleetTarget(runtime: WorkflowLifecycleFleetRuntime, name = 'lifecycle', options: { readonly includePaused?: boolean } = {}): WorkflowFleetTarget {
  return Object.freeze({ name,
    discover: async (cursor: JsonValue | null, limit: number) => {
      const page = await runtime.scan({ cursor: cursor as never, limit });
      // Pause sweeps skip already-paused runs; version inventories must count them.
      return { runIds: page.candidates.filter(candidate => options.includePaused === true || candidate.status !== 'paused').map(candidate => candidate.runId),
        nextCursor: page.nextCursor as unknown as JsonValue | null };
    },
    inspect: (runId: string) => runtime.inspect(runId), pause: (runId: string) => runtime.pause(runId), resume: (runId: string) => runtime.resume(runId) });
}
/** Format-3 graphs and format-4 trees share discovery-plus-runtime adapters. */
export function graphFleetTarget(discovery: WorkflowGraphDiscovery, runtime: {
  inspect(id: string): Promise<{ readonly status: string }>; pause(id: string): Promise<{ readonly status: string }>; resume(id: string): Promise<{ readonly status: string }>;
}, name = 'graphs', options: { readonly includePaused?: boolean } = {}): WorkflowFleetTarget {
  return Object.freeze({ name,
    discover: async (cursor: JsonValue | null, limit: number) => {
      // Discovery pages hold at most 32 candidates; sweeps and inventories may ask for more.
      const page = await discovery.scan({ cursor: cursor as never, limit: Math.min(limit, 32) });
      return { runIds: page.candidates.filter(candidate => options.includePaused === true || candidate.status !== 'paused').map(candidate => candidate.reference.runId),
        nextCursor: page.nextCursor as unknown as JsonValue | null };
    },
    inspect: (runId: string) => runtime.inspect(runId), pause: (runId: string) => runtime.pause(runId), resume: (runId: string) => runtime.resume(runId) });
}
export function treeFleetTarget(discovery: { scan(command?: { readonly cursor?: never; readonly limit?: number }): Promise<{
  readonly candidates: readonly { readonly rootId: string; readonly status: string }[]; readonly nextCursor: unknown }> }, runtime: {
  inspect(id: string): Promise<{ readonly status: string }>; pause(id: string): Promise<{ readonly status: string }>; resume(id: string): Promise<{ readonly status: string }>;
}, name = 'trees', options: { readonly includePaused?: boolean } = {}): WorkflowFleetTarget {
  return Object.freeze({ name,
    discover: async (cursor: JsonValue | null, limit: number) => {
      const page = await discovery.scan({ cursor: cursor as never, limit: Math.min(limit, 32) });
      return { runIds: page.candidates.filter(candidate => options.includePaused === true || candidate.status !== 'paused').map(candidate => candidate.rootId),
        nextCursor: page.nextCursor as JsonValue | null };
    },
    inspect: (runId: string) => runtime.inspect(runId), pause: (runId: string) => runtime.pause(runId), resume: (runId: string) => runtime.resume(runId) });
}

/** Saga and loop runs from the composite fleet index; both formats support quiescent operator pause. */
export function compositeFleetTarget(runtime: WorkflowCompositeFleetRuntime, name = 'composites', options: { readonly includePaused?: boolean } = {}): WorkflowFleetTarget {
  const kinds = new Map<string, 'saga' | 'loop'>();
  const kind = async (runId: string): Promise<'saga' | 'loop'> => {
    const known = kinds.get(runId) ?? await runtime.kindOf(runId);
    if (!known) throw new MayuraError('NOT_FOUND', 'The run is not in this composite fleet index.');
    kinds.set(runId, known); return known;
  };
  return Object.freeze({ name,
    discover: async (cursor: JsonValue | null, limit: number) => {
      const page = await runtime.scan({ cursor: cursor as never, limit: Math.min(limit, 128) });
      const runIds: string[] = [];
      for (const candidate of page.candidates) {
        kinds.set(candidate.runId, candidate.kind);
        if (options.includePaused !== true && (await (candidate.kind === 'loop' ? runtime.loops : runtime.sagas).inspect(candidate.runId)).status === 'paused') continue;
        runIds.push(candidate.runId);
      }
      return { runIds, nextCursor: page.nextCursor as unknown as JsonValue | null };
    },
    inspect: async (runId: string) => (await kind(runId)) === 'loop' ? runtime.loops.inspect(runId) : runtime.sagas.inspect(runId),
    pause: async (runId: string) => (await kind(runId)) === 'loop' ? runtime.loops.pause(runId) : runtime.sagas.pause(runId),
    resume: async (runId: string) => (await kind(runId)) === 'loop' ? runtime.loops.resume(runId) : runtime.sagas.resume(runId) });
}
