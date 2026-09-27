import { MayuraError, jsonValue, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import { StorageError, type AggregateStore, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import type { WorkflowFleetControl, WorkflowFleetHoldState, WorkflowFleetTarget } from './fleet-control.js';
import { graphFleetTarget, lifecycleFleetTarget, treeFleetTarget } from './fleet-control.js';
import type { WorkflowGraphDiscovery } from './graph-discovery.js';
import type { AnyWorkflowGraph } from './graph-definition.js';
import type { AnyWorkflowTree } from './children-definition.js';
import type { AnyWorkflowLifecycle } from './lifecycle-definition.js';
import type { WorkflowLifecycleFleetRuntime } from './lifecycle-fleet.js';
import type { WorkflowGraphRuntime } from './graphs.js';
import type { WorkflowTreeRuntime } from './children-runtime.js';
import type { WorkflowTreeDiscovery } from './children-discovery.js';
import type { MigrationCommand, MigrationPlan, WorkflowMigration, WorkflowMigrationCatalog } from './migration.js';
import { createWorkflowMigrationService, pinnedDefinitionHash, type WorkflowMigrationOfferRecord } from './migration-service.js';

/*
 * Production operator adapters. They implement the agent server's workflow transports (structurally: this package does
 * not depend on the server) over the real format runtimes, so a host does not hand-write revision checks, command
 * idempotency, multi-version views or index paging.
 */

export type WorkflowCommandOutcome = 'applied' | 'conflict' | 'not_found';
/** An outcome plus an optional small result recorded with it (at most 256 KiB), returned again on every retry. */
export interface WorkflowCommandResult { readonly outcome: WorkflowCommandOutcome; readonly detail?: JsonValue }
export interface WorkflowCommandJournal {
  /**
   * Run one operator command at most once per `commandId`. A retry with the same request returns the recorded outcome;
   * a different request under the same id is a conflict. If an earlier attempt died mid-flight, `observe` decides whether
   * its effect already happened before anything is applied again.
   */
  run(command: {
    readonly runId: string; readonly action: string; readonly commandId: string; readonly request: JsonValue;
    readonly observe: () => Promise<boolean>; readonly apply: () => Promise<WorkflowCommandResult>;
  }): Promise<WorkflowCommandResult>;
}
export interface WorkflowCommandJournalOptions {
  readonly store: AggregateStore; readonly scope: Scope;
  /** How long an in-flight attempt owns its command before a retry may take over (default 60 s). */
  readonly leaseMs?: number;
  readonly now?: () => number;
}
interface JournalState { format: 1; digest: string; action: string; status: 'pending' | 'completed'; attempt: number; leaseUntilMs: number; outcome: WorkflowCommandOutcome | null; detail: JsonValue }

const hashPattern = /^[a-f0-9]{64}$/;
const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const outcomes = new Set<WorkflowCommandOutcome>(['applied', 'conflict', 'not_found']);
const isCode = (error: unknown, code: string): boolean => (error instanceof StorageError || error instanceof MayuraError) && error.code === code;

/** Durable, aggregate-backed command journal. One small permanent record per command id. */
export function createWorkflowCommandJournal(options: WorkflowCommandJournalOptions): WorkflowCommandJournal {
  const { store } = options; const leaseMs = options.leaseMs ?? 60_000; const now = options.now ?? Date.now;
  if (!store || typeof store.create !== 'function' || typeof store.update !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new MayuraError('INVALID_CONFIG', 'A workflow command journal needs an aggregate store and a lease between 1 s and 1 h.');
  }
  const scope = digest('mayura:workflow-command-journal:v1', { principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  const definitionHash = digest('mayura:workflow-command-format:v1', {});
  const decode = (record: StoredRecord): JournalState => {
    const state = record.state as unknown as JournalState;
    if (record.definitionHash !== definitionHash || state?.format !== 1 || typeof state.digest !== 'string' || !hashPattern.test(state.digest)
      || !['pending', 'completed'].includes(state.status) || !Number.isSafeInteger(state.attempt) || state.attempt < 1 || !Number.isSafeInteger(state.leaseUntilMs)
      || (state.status === 'completed') !== (state.outcome !== null && outcomes.has(state.outcome))) {
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored workflow command failed integrity validation.');
    }
    return state;
  };
  const write = (record: StoredRecord, state: JournalState, type: string) => store.update({ scope, id: record.id, expectedVersion: record.version,
    state: state as unknown as JsonObject, events: [{ type, data: { attempt: state.attempt, ...(state.outcome ? { outcome: state.outcome } : {}) } }] });
  return Object.freeze<WorkflowCommandJournal>({
    async run(command) {
      if (typeof command?.runId !== 'string' || !hashPattern.test(command.runId) || typeof command.action !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(command.action)
        || typeof command.commandId !== 'string' || !commandPattern.test(command.commandId)) throw new MayuraError('INVALID_INPUT', 'A workflow command needs a run id, an action and a bounded command id.');
      const id = digest('mayura:workflow-command-entry:v1', { runId: command.runId, commandId: command.commandId });
      const requestDigest = digest('mayura:workflow-command-request:v1', { runId: command.runId, action: command.action, request: jsonValue(command.request, { maxBytes: 65_536 }) });
      // A failed attempt releases its lease so a retry can take over at once (after checking whether the effect happened).
      const attemptOn = async (record: StoredRecord, state: JournalState, operation: () => Promise<WorkflowCommandResult>): Promise<WorkflowCommandResult> => {
        let result: WorkflowCommandResult;
        try { result = await operation(); }
        catch (error) { await write(record, { ...state, leaseUntilMs: 0 }, 'command.released').catch(() => undefined); throw error; }
        return finish(record, state, result);
      };
      const finish = async (record: StoredRecord, state: JournalState, result: WorkflowCommandResult): Promise<WorkflowCommandResult> => {
        if (!outcomes.has(result?.outcome)) throw new MayuraError('INVALID_INPUT', 'A workflow command must report applied, conflict or not_found.');
        const detail = result.detail === undefined ? null : jsonValue(result.detail, { maxBytes: 262_144 });
        try { await write(record, { ...state, status: 'completed', outcome: result.outcome, detail }, 'command.completed'); }
        catch (error) { if (!isCode(error, 'CONFLICT')) throw error; }
        return detail === null ? { outcome: result.outcome } : { outcome: result.outcome, detail };
      };
      for (let attempt = 0; attempt < 8; attempt++) {
        const existing = await store.read(scope, id);
        if (!existing) {
          const state: JournalState = { format: 1, digest: requestDigest, action: command.action, status: 'pending', attempt: 1, leaseUntilMs: now() + leaseMs, outcome: null, detail: null };
          let created: { record: StoredRecord; created: boolean };
          try { created = await store.create({ scope, id, idempotencyKey: id, definitionHash, state: state as unknown as JsonObject, events: [{ type: 'command.claimed', data: { action: command.action } }] }); }
          catch (error) { if (isCode(error, 'CONFLICT')) continue; throw error; }
          if (!created.created) continue;
          return attemptOn(created.record, state, command.apply);
        }
        const state = decode(existing);
        if (state.digest !== requestDigest) return { outcome: 'conflict' };
        if (state.status === 'completed') return state.detail === null ? { outcome: state.outcome! } : { outcome: state.outcome!, detail: state.detail };
        // Another attempt owns the command until its lease ends; answering conflict makes the client re-read.
        if (state.leaseUntilMs > now()) return { outcome: 'conflict' };
        let taken: StoredRecord; const next: JournalState = { ...state, attempt: state.attempt + 1, leaseUntilMs: now() + leaseMs };
        try { taken = await write(existing, next, 'command.retaken'); }
        catch (error) { if (isCode(error, 'CONFLICT')) continue; throw error; }
        // The abandoned attempt may have applied its effect before dying: never apply twice.
        return attemptOn(taken, next, async () => (await command.observe()) ? { outcome: 'applied' } : command.apply());
      }
      return { outcome: 'conflict' };
    },
  });
}

/** Structural copies of the agent server's workflow transport records. */
export type WorkflowOperatorStatus = 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export type WorkflowOperatorNodeKind = 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer';
export type WorkflowOperatorStepStatus = 'pending' | 'waiting' | 'approved' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown' | 'skipped' | 'timed_out';
export interface WorkflowOperatorView {
  readonly format: 3 | 4 | 5; readonly definitionId: string; readonly definitionVersion: string; readonly runId: string; readonly revision: number;
  readonly status: WorkflowOperatorStatus;
  readonly nodes: readonly { readonly id: string; readonly kind: WorkflowOperatorNodeKind; readonly dependsOn: readonly string[] }[];
  readonly steps: readonly { readonly id: string; readonly kind: WorkflowOperatorNodeKind; readonly status: WorkflowOperatorStepStatus; readonly childRunId?: string;
    readonly approval?: WorkflowOperatorApproval }[];
}
/**
 * A tool step waiting for approval: the digest to approve and when the request lapses (it is then re-requested with a
 * new digest). Targets that can reconstruct it also show the exact tool call, verified against the digest.
 */
export interface WorkflowOperatorApproval {
  readonly digest: string; readonly expiresAtMs: number;
  readonly subject?: { readonly toolId: string; readonly toolVersion: string; readonly input: JsonValue };
}
export type WorkflowOperatorIndexRecord = Pick<WorkflowOperatorView, 'format' | 'definitionId' | 'definitionVersion' | 'runId' | 'revision' | 'status'>;
/** A run in the settled view: finished, or with an unknown outcome that still needs reconciling. */
export type WorkflowOperatorSettledRecord = WorkflowOperatorIndexRecord & { readonly settledAtMs: number };
export type WorkflowOperatorResult = { readonly status: 'applied'; readonly workflow: WorkflowOperatorView } | { readonly status: 'conflict' } | { readonly status: 'not_found' };
type Result = WorkflowOperatorResult;
export interface WorkflowOperatorControlInput { readonly scope: Scope; readonly agentIds: readonly string[]; readonly actorId: string; readonly runId: string; readonly revision: number; readonly commandId: string; readonly signal: AbortSignal }
type ControlInput = WorkflowOperatorControlInput;

/** One workflow format's operator surface. Build it with `lifecycleOperatorTarget`, `graphOperatorTarget` or `treeOperatorTarget`. */
export interface WorkflowOperatorTarget {
  readonly name: string;
  /** One page of active runs (running, waiting or paused); `after` and `next` are this target's opaque cursor strings. */
  page(after: string | null, limit: number): Promise<{ readonly items: readonly WorkflowOperatorIndexRecord[]; readonly next: string | null }>;
  /** Recently settled runs, when the target keeps them (lifecycle runs do; graph and tree runs do not yet). */
  settledPage?(after: string | null, limit: number): Promise<{ readonly items: readonly WorkflowOperatorSettledRecord[]; readonly next: string | null }>;
  /** The run projected on its pinned definition; null when this target does not own the run or its version is not registered. */
  view(runId: string): Promise<WorkflowOperatorView | null>;
  pause(runId: string): Promise<unknown>;
  resume(runId: string): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
  approve(runId: string, command: { readonly nodeId: string; readonly digest: string; readonly childRunId: string | null; readonly actorId: string }): Promise<unknown>;
  migrate(migration: WorkflowMigration, command: MigrationCommand): Promise<{ readonly plan: MigrationPlan; readonly snapshot?: unknown }>;
  readonly fleet: WorkflowFleetTarget;
}
interface Registered { readonly id: string; readonly version: string; readonly digest: string; readonly nodes: readonly { readonly id: string; readonly kind: string; readonly dependsOn?: readonly string[] }[] }
/** Maps the authenticated operator to the credential the runtime's `verifyHuman` accepts; without it approvals are unavailable. */
export type WorkflowApprovalCredential = (actorId: string) => unknown;

const catalog = <D extends Registered>(definitions: readonly D[]): Map<string, D> => {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 256) throw new MayuraError('INVALID_CONFIG', 'An operator target needs 1–256 registered definitions.');
  return new Map(definitions.map(definition => [definition.digest, definition]));
};
type Subjects = ReadonlyMap<string, NonNullable<WorkflowOperatorApproval['subject']>>;
const project = (format: 3 | 4 | 5, definition: Registered, snapshot: { readonly id: string; readonly version: number; readonly status: string;
  readonly steps: Readonly<Record<string, { readonly status: string; readonly child?: { readonly runId: string } | null;
    readonly approval?: unknown }>> }, subjects: Subjects = new Map()): WorkflowOperatorView => Object.freeze({
  format, definitionId: definition.id, definitionVersion: definition.version, runId: snapshot.id, revision: snapshot.version, status: snapshot.status as WorkflowOperatorStatus,
  nodes: definition.nodes.map(node => ({ id: node.id, kind: node.kind as WorkflowOperatorNodeKind, dependsOn: [...(node.dependsOn ?? [])] })),
  steps: definition.nodes.map(node => { const step = snapshot.steps[node.id]!;
    // Lifecycle and graph tool steps carry their own approval; a tree's approvals live in its child runs.
    const pending = format !== 4 && step.status === 'waiting' && step.approval ? step.approval as { readonly digest: string; readonly expiresAt: number } : null;
    const subject = pending ? subjects.get(node.id) : undefined;
    // A lifecycle step whose condition did not hold shows as skipped: it never ran.
    const status = (step.status === 'bypassed' ? 'skipped' : step.status) as WorkflowOperatorStepStatus;
    return { id: node.id, kind: node.kind as WorkflowOperatorNodeKind, status, ...(step.child?.runId ? { childRunId: step.child.runId } : {}),
      ...(pending ? { approval: { digest: pending.digest, expiresAtMs: pending.expiresAt, ...(subject ? { subject } : {}) } } : {}) }; }),
});
const approval = (credential: WorkflowApprovalCredential | undefined, actorId: string): unknown => {
  if (!credential) throw new MayuraError('UNSUPPORTED_PROFILE', 'Operator approvals need an approval credential mapping.');
  return credential(actorId);
};
const owned = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try { return await read(); } catch (error) { if (isCode(error, 'NOT_FOUND') || isCode(error, 'CONFLICT') || isCode(error, 'INVALID_INPUT')) return null; throw error; }
};

/** Format-5 lifecycle runs through the fleet runtime and its index. */
export function lifecycleOperatorTarget(options: { readonly runtime: WorkflowLifecycleFleetRuntime; readonly store: AggregateStore; readonly scope: Scope;
  readonly definitions: readonly AnyWorkflowLifecycle[]; readonly approvalCredential?: WorkflowApprovalCredential; readonly name?: string }): WorkflowOperatorTarget {
  const { runtime, store, scope } = options; const definitions = catalog(options.definitions);
  const scopeKey = digest('mayura:scope:v1', { principalId: scope.principalId, projectId: scope.projectId });
  return Object.freeze<WorkflowOperatorTarget>({ name: options.name ?? 'lifecycle',
    async page(after, limit) {
      // Cursor string: `<shard>` or `<shard>.<afterId>` over the 256 index shards.
      const match = after === null ? null : /^(\d{1,3})(?:\.([a-f0-9]{64}))?$/.exec(after);
      if (after !== null && (!match || Number(match[1]) > 255)) throw new MayuraError('INVALID_INPUT', 'Invalid lifecycle index cursor.');
      const page = await runtime.scan({ cursor: match ? { format: 1, scope: scopeKey, shard: Number(match[1]), afterId: match[2] ?? '' } : null, limit: Math.min(limit, 128), maxShardReads: 256 });
      const items = page.candidates.flatMap(candidate => { const definition = definitions.get(candidate.definitionHash); return definition
        ? [{ format: 5 as const, definitionId: definition.id, definitionVersion: definition.version, runId: candidate.runId, revision: candidate.version, status: candidate.status }] : []; });
      const next = page.nextCursor ? `${page.nextCursor.shard}${page.nextCursor.afterId ? `.${page.nextCursor.afterId}` : ''}` : null;
      return { items, next };
    },
    async settledPage(after, limit) {
      const match = after === null ? null : /^(\d{1,3})(?:\.([a-f0-9]{64}))?$/.exec(after);
      if (after !== null && (!match || Number(match[1]) > 255)) throw new MayuraError('INVALID_INPUT', 'Invalid lifecycle settled cursor.');
      const page = await runtime.settled({ cursor: match ? { format: 1, scope: scopeKey, shard: Number(match[1]), afterId: match[2] ?? '' } : null, limit: Math.min(limit, 128), maxShardReads: 256 });
      const items = page.entries.flatMap(entry => { const definition = definitions.get(entry.definitionHash); return definition
        ? [{ format: 5 as const, definitionId: definition.id, definitionVersion: definition.version, runId: entry.runId, revision: entry.version, status: entry.status, settledAtMs: entry.settledAtMs }] : []; });
      const next = page.nextCursor ? `${page.nextCursor.shard}${page.nextCursor.afterId ? `.${page.nextCursor.afterId}` : ''}` : null;
      return { items, next };
    },
    async view(runId) {
      const hash = await pinnedDefinitionHash(store, scope, runId); const definition = hash === undefined ? undefined : definitions.get(hash);
      if (!definition) return null; const snapshot = await owned(() => runtime.inspect(runId));
      if (!snapshot) return null;
      // Show each pending approval's exact tool call; the runtime verifies it reproduces the approval digest.
      const subjects = new Map<string, NonNullable<WorkflowOperatorApproval['subject']>>();
      for (const [nodeId, step] of Object.entries(snapshot.steps)) {
        if (step.kind !== 'tool' || step.status !== 'waiting' || !step.approval) continue;
        const request = await owned(() => runtime.approvalRequest(definition, runId, nodeId));
        // A large input is left out rather than truncated; the digest still identifies exactly what is approved.
        if (request && request.digest === step.approval.digest && Buffer.byteLength(JSON.stringify(request.input), 'utf8') <= 8_192) {
          subjects.set(nodeId, { toolId: request.toolId, toolVersion: request.toolVersion, input: request.input });
        }
      }
      return project(5, definition, snapshot, subjects);
    },
    pause: id => runtime.pause(id), resume: id => runtime.resume(id), cancel: id => runtime.cancel(id),
    approve: (id, command) => runtime.approve({ id, nodeId: command.nodeId, digest: command.digest, credential: approval(options.approvalCredential, command.actorId) }),
    migrate: (migration, command) => runtime.migrate(migration as never, command),
    fleet: lifecycleFleetTarget(runtime, options.name ?? 'lifecycle'),
  });
}

/** Format-3 graph runs through discovery and the graph runtime. */
export function graphOperatorTarget(options: { readonly runtime: WorkflowGraphRuntime; readonly discovery: WorkflowGraphDiscovery; readonly store: AggregateStore; readonly scope: Scope;
  readonly definitions: readonly AnyWorkflowGraph[]; readonly approvalCredential?: WorkflowApprovalCredential; readonly name?: string }): WorkflowOperatorTarget {
  const { runtime, discovery, store, scope } = options; const definitions = catalog(options.definitions);
  return Object.freeze<WorkflowOperatorTarget>({ name: options.name ?? 'graphs',
    async page(after, limit) {
      const page = await discovery.scan({ ...(after === null ? {} : { cursor: discovery.cursorAfter(after) }), limit: Math.min(limit, 32) });
      const items = page.candidates.flatMap(candidate => { const definition = definitions.get(candidate.reference.definitionHash); return definition
        ? [{ format: 3 as const, definitionId: definition.id, definitionVersion: definition.version, runId: candidate.reference.runId, revision: candidate.version, status: candidate.status }] : []; });
      return { items, next: page.nextCursor ? page.nextCursor.afterId : null };
    },
    async view(runId) {
      const hash = await pinnedDefinitionHash(store, scope, runId); const definition = hash === undefined ? undefined : definitions.get(hash);
      if (!definition) return null; const snapshot = await owned(() => runtime.inspect(runId));
      return snapshot ? project(3, definition, snapshot) : null;
    },
    pause: id => runtime.pause(id), resume: id => runtime.resume(id), cancel: id => runtime.cancel(id),
    approve: (id, command) => runtime.approve({ id, nodeId: command.nodeId, digest: command.digest, credential: approval(options.approvalCredential, command.actorId) }),
    migrate: (migration, command) => runtime.migrate(migration as never, command),
    fleet: graphFleetTarget(discovery, runtime, options.name ?? 'graphs'),
  });
}

/** Format-4 workflow trees through discovery and the tree runtime. */
export function treeOperatorTarget(options: { readonly runtime: WorkflowTreeRuntime; readonly discovery: WorkflowTreeDiscovery; readonly store: AggregateStore; readonly scope: Scope;
  readonly definitions: readonly AnyWorkflowTree[]; readonly approvalCredential?: WorkflowApprovalCredential; readonly name?: string }): WorkflowOperatorTarget {
  const { runtime, discovery, store, scope } = options; const definitions = catalog(options.definitions);
  return Object.freeze<WorkflowOperatorTarget>({ name: options.name ?? 'trees',
    async page(after, limit) {
      const page = await discovery.scan({ ...(after === null ? {} : { cursor: discovery.cursorAfter(after) }), limit: Math.min(limit, 32) });
      const items = page.candidates.flatMap(candidate => { const definition = definitions.get(candidate.definitionHash); return definition
        ? [{ format: 4 as const, definitionId: definition.id, definitionVersion: definition.version, runId: candidate.rootId, revision: candidate.version, status: candidate.status }] : []; });
      return { items, next: page.nextCursor ? page.nextCursor.afterId : null };
    },
    async view(runId) {
      const hash = await pinnedDefinitionHash(store, scope, runId); const definition = hash === undefined ? undefined : definitions.get(hash);
      if (!definition) return null; const snapshot = await owned(() => runtime.inspect(runId));
      return snapshot ? project(4, definition, snapshot) : null;
    },
    pause: id => runtime.pause(id), resume: id => runtime.resume(id), cancel: id => runtime.cancel(id),
    approve: (id, command) => runtime.approve({ id, ...(command.childRunId ? { childId: command.childRunId } : {}), nodeId: command.nodeId, digest: command.digest,
      credential: approval(options.approvalCredential, command.actorId) }),
    migrate: (migration, command) => runtime.migrate(migration as never, command),
    fleet: treeFleetTarget(discovery, runtime, options.name ?? 'trees'),
  });
}

export interface WorkflowOperatorTransportOptions {
  readonly targets: readonly WorkflowOperatorTarget[];
  readonly journal: WorkflowCommandJournal;
  readonly fleet?: WorkflowFleetControl;
  readonly migrations?: WorkflowMigrationCatalog;
  readonly store: AggregateStore;
  /** The one scope these transports serve. Requests authenticated for any other scope see nothing and change nothing. */
  readonly scope: Scope;
}
type ScopedInput = { readonly scope: Scope };
/** One run's outcome in a fleet sweep page (a structural copy of the server's sweep record). */
export type WorkflowOperatorFleetSweepOutcome =
  | { readonly target: string; readonly runId: string;
      readonly outcome: 'paused' | 'already_paused' | 'terminal' | 'busy' | 'resumed' | 'not_paused' | 'missing' | 'unregistered' }
  | { readonly target: string; readonly runId: string; readonly outcome: 'failed'; readonly code: string };
type FleetSweep = { readonly outcomes: readonly WorkflowOperatorFleetSweepOutcome[]; readonly nextCursor: JsonObject | null };
/** Structurally the agent server's workflow transport options: spread it into the server options. */
export interface WorkflowOperatorTransports {
  readonly workflowIndex: { list(input: ScopedInput & { readonly after: string | null; readonly limit: number; readonly view?: 'settled' }): Promise<{ readonly items: readonly WorkflowOperatorIndexRecord[]; readonly next: string | null }> };
  readonly workflowViews: { inspect(input: ScopedInput & { readonly runId: string }): Promise<WorkflowOperatorView | null> };
  readonly workflowControls: {
    cancel(input: ControlInput): Promise<WorkflowOperatorResult>;
    approve(input: ControlInput & { readonly nodeId: string; readonly approvalDigest: string; readonly childRunId: string | null }): Promise<WorkflowOperatorResult>;
  };
  readonly workflowPauses: { pause(input: ControlInput): Promise<WorkflowOperatorResult> };
  readonly workflowResumes: { resume(input: ControlInput): Promise<WorkflowOperatorResult> };
  readonly workflowFleet?: {
    inspect(input: ScopedInput): Promise<WorkflowFleetHoldState>; hold(input: ScopedInput): Promise<WorkflowFleetHoldState>; release(input: ScopedInput): Promise<WorkflowFleetHoldState>;
    sweep(input: ScopedInput & { readonly phase: 'pause' | 'resume'; readonly cursor: JsonObject | null; readonly limit: number }): Promise<{ readonly status: 'applied'; readonly sweep: FleetSweep } | { readonly status: 'conflict' }>;
  };
  readonly workflowMigrations?: {
    list(input: ScopedInput & { readonly runId: string }): Promise<readonly WorkflowMigrationOfferRecord[] | null>;
    plan(input: ScopedInput & { readonly runId: string; readonly migrationId: string }): Promise<MigrationPlan | null>;
    apply(input: ControlInput & { readonly migrationId: string }): Promise<{ readonly status: 'applied'; readonly plan: MigrationPlan; readonly workflow: WorkflowOperatorView }
      | { readonly status: 'refused'; readonly plan: MigrationPlan } | { readonly status: 'conflict' } | { readonly status: 'not_found' }>;
  };
}
/** Server transports (`workflowIndex`, `workflowViews`, `workflowControls`, `workflowPauses`, `workflowResumes`, and optionally `workflowFleet` and `workflowMigrations`). */
export function createWorkflowOperatorTransports(options: WorkflowOperatorTransportOptions): WorkflowOperatorTransports {
  const { targets, journal } = options;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 16 || new Set(targets.map(target => target.name)).size !== targets.length
    || targets.some(target => !/^[a-z][a-z0-9-]{0,31}$/.test(target.name)) || !journal || typeof journal.run !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'Operator transports need 1–16 uniquely named targets and a command journal.');
  }
  if (!options.store || typeof options.store.read !== 'function' || typeof options.scope?.principalId !== 'string' || typeof options.scope.projectId !== 'string') {
    throw new MayuraError('INVALID_CONFIG', 'Operator transports need the store and the scope they serve.');
  }
  const served = options.scope;
  const inScope = (input: { readonly scope?: Scope }): boolean => input?.scope?.principalId === served.principalId && input.scope.projectId === served.projectId;
  const locate = async (runId: string): Promise<{ target: WorkflowOperatorTarget; view: WorkflowOperatorView } | null> => {
    if (!hashPattern.test(runId)) return null;
    for (const target of targets) { const view = await target.view(runId); if (view) return { target, view }; }
    return null;
  };
  const conflicts = (error: unknown): WorkflowCommandOutcome | undefined => isCode(error, 'CONFLICT') ? 'conflict' : isCode(error, 'NOT_FOUND') ? 'not_found' : undefined;
  /** Revision-checked, journaled command. The runtimes guard state themselves; the revision check is the operator's review point. */
  const command = async (input: ControlInput, action: string, request: JsonValue, observe: (view: WorkflowOperatorView) => boolean,
    operate: (target: WorkflowOperatorTarget) => Promise<unknown>): Promise<Result> => {
    if (!inScope(input)) return { status: 'not_found' };
    const found = await locate(input.runId); if (!found) return { status: 'not_found' };
    const { outcome } = await journal.run({ runId: input.runId, action, commandId: input.commandId, request: { revision: input.revision, request },
      observe: async () => { const current = await found.target.view(input.runId); return current !== null && observe(current); },
      apply: async () => {
        const current = await found.target.view(input.runId); if (!current) return { outcome: 'not_found' };
        if (current.revision !== input.revision) return { outcome: 'conflict' };
        try { await operate(found.target); return { outcome: 'applied' }; } catch (error) { const mapped = conflicts(error); if (mapped) return { outcome: mapped }; throw error; }
      } });
    if (outcome !== 'applied') return { status: outcome };
    const workflow = await found.target.view(input.runId);
    return workflow ? { status: 'applied', workflow } : { status: 'not_found' };
  };
  const decode = (after: string | null): { index: number; inner: string | null } => {
    if (after === null) return { index: 0, inner: null };
    const match = /^(\d{1,2}):(-|[A-Za-z0-9.]{1,124})$/.exec(after);
    if (!match || Number(match[1]) >= targets.length) throw new MayuraError('INVALID_INPUT', 'Invalid workflow index cursor.');
    return { index: Number(match[1]), inner: match[2] === '-' ? null : match[2]! };
  };
  const transports = {
    workflowIndex: { list: async (input: { readonly scope: Scope; readonly after: string | null; readonly limit: number; readonly view?: 'settled' }) => {
      if (!inScope(input)) return { items: [], next: null };
      // One target per page: a short page is normal and the cursor moves on to the next format. The settled view
      // reads only targets that keep settled runs.
      const settled = input.view === 'settled'; const { index, inner } = decode(input.after); const target = targets[index]!;
      const page = !settled ? await target.page(inner, input.limit) : target.settledPage ? await target.settledPage(inner, input.limit) : { items: [], next: null };
      const following = targets.findIndex((candidate, position) => position > index && (!settled || candidate.settledPage !== undefined));
      const next = page.next !== null ? `${index}:${page.next}` : following >= 0 ? `${following}:-` : null;
      return { items: page.items.slice(0, input.limit), next };
    } },
    workflowViews: { inspect: async (input: { readonly scope: Scope; readonly runId: string }) => inScope(input) ? (await locate(input.runId))?.view ?? null : null },
    workflowControls: {
      cancel: (input: ControlInput) => command(input, 'cancel', null, view => view.status === 'cancelled', target => target.cancel(input.runId)),
      approve: (input: ControlInput & { readonly nodeId: string; readonly approvalDigest: string; readonly childRunId: string | null }) =>
        command(input, 'approve', { nodeId: input.nodeId, approvalDigest: input.approvalDigest, childRunId: input.childRunId },
          // A child's approval is not visible on the root view; re-applying it is safe because approvals are digest-bound.
          view => input.childRunId === null && !['pending', 'waiting'].includes(view.steps.find(step => step.id === input.nodeId)?.status ?? 'pending'),
          target => target.approve(input.runId, { nodeId: input.nodeId, digest: input.approvalDigest, childRunId: input.childRunId, actorId: input.actorId })),
    },
    workflowPauses: { pause: (input: ControlInput) => command(input, 'pause', null, view => view.status === 'paused', target => target.pause(input.runId)) },
    workflowResumes: { resume: (input: ControlInput) => command(input, 'resume', null, view => view.status !== 'paused',
      async target => { if ((await target.view(input.runId))?.status === 'paused') await target.resume(input.runId); }) },
    ...(options.fleet ? { workflowFleet: fleetTransport(options.fleet, targets.map(target => target.fleet), inScope) } : {}),
    ...(options.migrations ? { workflowMigrations: migrationTransport(options.migrations, options.store, served, locate, journal, inScope) } : {}),
  };
  return Object.freeze(transports);
}

function fleetTransport(fleet: WorkflowFleetControl, targets: readonly WorkflowFleetTarget[], inScope: (input: { readonly scope?: Scope }) => boolean) {
  const guard = (input: { readonly scope?: Scope }): void => { if (!inScope(input)) throw new MayuraError('PERMISSION_DENIED', 'This fleet belongs to another scope.'); };
  return {
    inspect: async (input: { readonly scope: Scope }) => { guard(input); return fleet.inspect(); },
    hold: async (input: { readonly scope: Scope }) => { guard(input); return fleet.hold(); },
    release: async (input: { readonly scope: Scope }) => { guard(input); return fleet.release(); },
    sweep: async (input: { readonly scope: Scope; readonly phase: 'pause' | 'resume'; readonly cursor: JsonObject | null; readonly limit: number }) => {
      guard(input);
      try {
        const sweep = input.phase === 'pause' ? await fleet.sweepPause(targets, { cursor: input.cursor as never, limit: input.limit })
          : await fleet.sweepResume(targets, { cursor: input.cursor as never, limit: input.limit });
        return { status: 'applied' as const, sweep: sweep as unknown as FleetSweep };
      } catch (error) { if (isCode(error, 'CONFLICT')) return { status: 'conflict' as const }; throw error; }
    },
  };
}

function migrationTransport(catalogue: WorkflowMigrationCatalog, store: AggregateStore, scope: Scope,
  locate: (runId: string) => Promise<{ target: WorkflowOperatorTarget; view: WorkflowOperatorView } | null>, journal: WorkflowCommandJournal,
  inScope: (input: { readonly scope?: Scope }) => boolean) {
  const service = async (runId: string) => {
    const found = await locate(runId); if (!found) return null;
    return { found, service: createWorkflowMigrationService({ catalog: catalogue, pinned: id => pinnedDefinitionHash(store, scope, id),
      inspect: async id => ({ version: (await found.target.view(id))?.revision ?? -1 }), migrate: (migration, command) => found.target.migrate(migration, command) as never }) };
  };
  return {
    list: async (input: { readonly scope: Scope; readonly runId: string }): Promise<readonly WorkflowMigrationOfferRecord[] | null> =>
      inScope(input) ? (await service(input.runId))?.service.list(input.runId) ?? null : null,
    plan: async (input: { readonly scope: Scope; readonly runId: string; readonly migrationId: string }): Promise<MigrationPlan | null> =>
      inScope(input) ? (await service(input.runId))?.service.plan(input.runId, input.migrationId) ?? null : null,
    apply: async (input: ControlInput & { readonly migrationId: string }) => {
      const resolved = inScope(input) ? await service(input.runId) : null; if (!resolved) return { status: 'not_found' as const };
      let refused: MigrationPlan | undefined;
      const target = (catalogue.get(input.migrationId)?.to as { readonly digest?: string } | undefined)?.digest;
      const result = await journal.run({ runId: input.runId, action: 'migrate', commandId: input.commandId, request: { revision: input.revision, migrationId: input.migrationId },
        observe: async () => target !== undefined && (await pinnedDefinitionHash(store, scope, input.runId)) === target,
        apply: async () => {
          const applied = await resolved.service.apply(input.runId, input.migrationId, { revision: input.revision, actorId: input.actorId, commandId: input.commandId });
          if (applied.status === 'refused') { refused = applied.plan; return { outcome: 'conflict' }; }
          // The applied plan is recorded with the command, so a retry reports the same plan.
          return applied.status === 'applied' ? { outcome: 'applied', detail: applied.plan as unknown as JsonValue } : { outcome: applied.status };
        } });
      if (refused) return { status: 'refused' as const, plan: refused };
      if (result.outcome !== 'applied') return { status: result.outcome };
      const workflow = (await locate(input.runId))?.view;
      // Recovered after a crash without a recorded plan: the migration applied, but the operator must re-read the run.
      return workflow && result.detail ? { status: 'applied' as const, plan: result.detail as unknown as MigrationPlan, workflow } : { status: 'conflict' as const };
    },
  };
}
