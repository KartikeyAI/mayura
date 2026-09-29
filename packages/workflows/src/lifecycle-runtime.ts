import { Budget, MayuraError, assertPositiveInteger, freezeJson, jsonValue, validate,
  type ExecutionReceipt, type JsonObject, type JsonValue, type Permissions, type Scope } from '@mayura/core';
import { invokeTool } from '@mayura/tools';
import { abandoned, dispatchedAt } from './abandoned.js';
import { createWorkflowDrainGate, type WorkflowDrainOptions, type WorkflowDrainReport } from './drain.js';
import { StorageError, assertWorkflowLifecycleStateMatchesManifest, initialWorkflowLifecycleState,
  mergeWorkflowReceipt, workflowLifecycleOutputs, workflowLifecycleState,
  type AggregateStore, type StoredRecord, type WorkflowLifecycleState as State,
  type WorkflowLifecycleStatus, type WorkflowLifecycleStep } from '@mayura/storage-contracts';
import { charged, digest, resolveBinding, type Binding } from './definition.js';
import { assertWorkflowLifecycle, lifecycleManifest, type AnyWorkflowLifecycle,
  type WorkflowLifecycleNode } from './lifecycle-definition.js';
import type { VerifiedHuman } from './runtime.js';
import { createSubmission, workflowStorageFailure } from './storage-failure.js';
import { assertMigrationAllowed, assertWorkflowMigration, migrationCommand, migrationEvent, nodeEvidence, nodeFingerprint, planWorkflowMigration,
  type MigrationBlocker, type MigrationCommand, type WorkflowMigration, type WorkflowMigrationResult } from './migration.js';
export type { WorkflowMigrationResult } from './migration.js';

export interface WorkflowLifecycleSnapshot {
  readonly id: string;
  readonly version: number;
  readonly status: WorkflowLifecycleStatus;
  readonly steps: Readonly<Record<string, Readonly<WorkflowLifecycleStep>>>;
  readonly output: JsonValue;
  readonly nextWakeAtMs: number | null;
  readonly budget: { readonly spentMicros: number; readonly reservedMicros: number; readonly maxCostMicros: number };
}

export interface WorkflowLifecycleHumanRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly status: 'waiting' | 'succeeded' | 'timed_out';
  readonly kind: 'information' | 'correction' | 'plan_selection';
  readonly schemaId: string;
  readonly schemaDigest: string;
  readonly prompt: string;
  readonly digest: string;
  readonly context: JsonValue | null;
  readonly subjectDigest: string | null;
  readonly deadlineAtMs: number | null;
}

/**
 * A signal for a waiting (or not yet started) `signal` step. `signalId` makes delivery idempotent: the same id with the
 * same payload is accepted once and every repeat returns the run unchanged; the same id with another payload, or a
 * second signal for a step that already has one, is refused with CONFLICT.
 */
export interface WorkflowLifecycleSignalCommand {
  readonly id: string;
  /** The signal node's `name` (its id unless it names one). */
  readonly name: string;
  /** 1–128 letters, digits, `.`, `_`, `/` or `-`, starting with a letter or digit. */
  readonly signalId: string;
  readonly payload: unknown;
  /** Who sent it, recorded in the run's event log. */
  readonly actorId?: string;
}

/** What an operator approves: the exact tool call the approval digest binds, reconstructed and digest-verified. */
export interface WorkflowLifecycleApprovalRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly status: 'waiting' | 'approved';
  readonly toolId: string;
  readonly toolVersion: string;
  /** The validated tool input that runs once approved. */
  readonly input: JsonValue;
  readonly digest: string;
  readonly expiresAtMs: number;
}

/**
 * Runtime settings a run may have been started with (same scope as the runtime). Defaults match the runtime's own.
 * A run started under a listed policy continues under exactly those settings; it never gains the current ones.
 */
export interface WorkflowLifecyclePolicy {
  readonly permissions: Permissions;
  readonly policyVersion: string;
  readonly maxCostMicros: number;
  readonly maxOutputBytes?: number;
  readonly approvalTtlMs?: number;
}

export interface WorkflowLifecycleRuntimeOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  readonly permissions: Permissions;
  readonly policyVersion: string;
  readonly maxCostMicros: number;
  readonly approvalTtlMs?: number;
  readonly maxOutputBytes?: number;
  /**
   * Settings of earlier deployments (at most 16). Runs started under one of them continue under it instead of
   * failing with CONFLICT; new runs always use the current settings, and `migrate` moves a run onto them.
   */
  readonly previousPolicies?: readonly WorkflowLifecyclePolicy[];
  readonly callbackTimeoutMs?: number;
  readonly maxPendingCallbacks?: number;
  /** Trusted synchronized clock; never accepted from workflow input. */
  readonly now?: () => number;
  /** Trusted identity boundary. Credentials and verifier diagnostics are never persisted. */
  readonly verifyHuman?: (credential: unknown) => Promise<VerifiedHuman>;
}

/** Trusted host assertion. Never deserialize this shape directly from an unauthenticated request. */
export interface WorkflowLifecycleVerifiedActor { readonly id: string; readonly projectId: string }

export interface WorkflowLifecycleRuntime {
  readonly profile: 'lifecycle-v1';
  submit(definition: AnyWorkflowLifecycle, command: { readonly input: unknown; readonly idempotencyKey: string }): Promise<WorkflowLifecycleSnapshot>;
  inspect(id: string): Promise<WorkflowLifecycleSnapshot>;
  humanRequest(definition: AnyWorkflowLifecycle, id: string, nodeId: string): Promise<WorkflowLifecycleHumanRequest | undefined>;
  /** The pending (or approved, not yet dispatched) approval of one tool node; undefined when none is outstanding. */
  approvalRequest(definition: AnyWorkflowLifecycle, id: string, nodeId: string): Promise<WorkflowLifecycleApprovalRequest | undefined>;
  events(id: string, after?: number): ReturnType<AggregateStore['events']>;
  runUntilSettled(definition: AnyWorkflowLifecycle, id: string): Promise<WorkflowLifecycleSnapshot>;
  approve(command: { readonly id: string; readonly nodeId: string; readonly digest: string; readonly credential: unknown }): Promise<WorkflowLifecycleSnapshot>;
  respond(definition: AnyWorkflowLifecycle, command: { readonly id: string; readonly nodeId: string;
    readonly requestDigest: string; readonly commandId: string; readonly credential: unknown; readonly value: unknown }): Promise<WorkflowLifecycleSnapshot>;
  respondVerified(definition: AnyWorkflowLifecycle, command: { readonly id: string; readonly nodeId: string;
    readonly requestDigest: string; readonly commandId: string; readonly actor: WorkflowLifecycleVerifiedActor; readonly value: unknown }): Promise<WorkflowLifecycleSnapshot>;
  /**
   * Deliver a signal to the run's `signal` step named `command.name`. The payload is validated with the step's
   * `payload` schema (INVALID_INPUT otherwise). The run continues on its next `runUntilSettled`, as after a response.
   */
  signal(definition: AnyWorkflowLifecycle, command: WorkflowLifecycleSignalCommand): Promise<WorkflowLifecycleSnapshot>;
  pause(id: string): Promise<WorkflowLifecycleSnapshot>;
  resume(id: string): Promise<WorkflowLifecycleSnapshot>;
  /**
   * Plan (dryRun) or apply a reviewed migration of a paused run from `migration.from` to `migration.to`. The run stays
   * paused afterwards; resume it once the result is reviewed. Waiting human requests are re-issued with new digests.
   */
  migrate(migration: WorkflowMigration<AnyWorkflowLifecycle, AnyWorkflowLifecycle>, command: MigrationCommand): Promise<WorkflowMigrationResult<WorkflowLifecycleSnapshot>>;
  cancel(id: string): Promise<WorkflowLifecycleSnapshot>;
  recoverAbandoned(id: string): Promise<WorkflowLifecycleSnapshot>;
  close(): void;
  /** Admit no new wave, let admitted effects and receipts settle within the deadline, then close. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
}

const finalRunStatuses = new Set<WorkflowLifecycleStatus>(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const terminalStepStatuses = new Set(['succeeded', 'failed', 'blocked', 'unknown', 'timed_out', 'skipped', 'bypassed']);
/** Statuses a dependent step may build on: success, or a condition that did not hold. */
const satisfiedStepStatuses = new Set(['succeeded', 'bypassed']);
const hashPattern = /^[a-f0-9]{64}$/;
const nodePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const signalPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

async function bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MayuraError('TIMEOUT', 'Lifecycle validation or identity verification timed out.')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw workflowStorageFailure(error, 'workflow lifecycle run'); }
}

function stateFrom(record: StoredRecord): State {
  try { return workflowLifecycleState(record); }
  catch { throw new MayuraError('CONFLICT', 'Stored workflow lifecycle state failed integrity validation.'); }
}

function outputs(state: State): Record<string, JsonValue> {
  try { return workflowLifecycleOutputs(state); }
  catch { throw new MayuraError('CONFLICT', 'Stored workflow lifecycle output failed integrity validation.'); }
}

function receipt(previous: ExecutionReceipt | null, incoming: ExecutionReceipt): ExecutionReceipt {
  try { return mergeWorkflowReceipt(previous, incoming); }
  catch { throw new MayuraError('CONFLICT', 'Conflicting known execution evidence requires reconciliation.'); }
}

function nextWake(state: State): number | null {
  const deadlines = Object.values(state.steps).flatMap(step => step.kind === 'timer' && step.status === 'waiting' && step.fireAtMs !== null
    ? [step.fireAtMs] : (step.kind === 'human' || step.kind === 'signal') && step.status === 'waiting' && step.deadlineAtMs !== null
      ? [step.deadlineAtMs] : step.kind === 'tool' && step.status === 'waiting' && step.approval !== null ? [step.approval.expiresAt] : []);
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

function publicSnapshot(record: StoredRecord): WorkflowLifecycleSnapshot {
  const state = stateFrom(record);
  return freezeJson(jsonValue({ id: record.id, version: record.version, status: state.status, steps: state.steps,
    output: state.output, nextWakeAtMs: nextWake(state), budget: { spentMicros: state.spentMicros,
      reservedMicros: state.reservedMicros, maxCostMicros: state.maxCostMicros } })) as unknown as WorkflowLifecycleSnapshot;
}

function exactTimestamp(value: JsonValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_INPUT', 'Lifecycle time binding must resolve to an absolute Unix epoch millisecond timestamp.');
  return value;
}

function exactDigest(value: JsonValue): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new MayuraError('INVALID_INPUT', 'Correction subject binding must resolve to a SHA-256 digest.');
  return value;
}

/** @internal A validated policy with its defaults applied. */
export interface WorkflowPolicySettings {
  readonly permissions: Permissions; readonly policyVersion: string; readonly maxCostMicros: number;
  readonly maxOutputBytes: number; readonly approvalTtlMs: number;
}

/**
 * @internal The runtime's own settings first, then each previous policy, validated and defaulted alike, so index `n`
 * means the same settings to every runtime built from one options object.
 */
export function workflowPolicySettings(options: WorkflowLifecyclePolicy & { readonly previousPolicies?: readonly WorkflowLifecyclePolicy[] }): readonly WorkflowPolicySettings[] {
  const previous: unknown = options.previousPolicies ?? [];
  if (!Array.isArray(previous) || previous.length > 16) throw new MayuraError('INVALID_CONFIG', 'previousPolicies must list at most 16 policies.');
  return Object.freeze([options, ...previous as unknown[]].map(value => {
    if (value === null || typeof value !== 'object') throw new MayuraError('INVALID_CONFIG', 'Each previous policy must be an explicit settings object.');
    const policy = value as WorkflowLifecyclePolicy;
    if (typeof policy.policyVersion !== 'string' || policy.policyVersion.length < 1 || policy.policyVersion.length > 128) {
      throw new MayuraError('INVALID_CONFIG', 'Workflow lifecycle policy version is required.');
    }
    if (!Array.isArray(policy.permissions?.allow) || policy.permissions.allow.length > 4_096
      || policy.permissions.allow.some(grant => typeof grant !== 'string' || grant.length < 1 || grant.length > 256)) {
      throw new MayuraError('INVALID_CONFIG', 'Workflow lifecycle permissions must be bounded explicit grants.');
    }
    if (!Number.isSafeInteger(policy.maxCostMicros) || policy.maxCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'A bounded lifecycle cost is required.');
    const maxOutputBytes = policy.maxOutputBytes ?? 1_048_576; const approvalTtlMs = policy.approvalTtlMs ?? 3_600_000;
    assertPositiveInteger(approvalTtlMs, 'approvalTtlMs'); assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');
    return Object.freeze({ permissions: Object.freeze({ allow: Object.freeze([...policy.permissions.allow]) }),
      policyVersion: policy.policyVersion, maxCostMicros: policy.maxCostMicros, maxOutputBytes, approvalTtlMs });
  }));
}

/** @internal The digest a run records for its settings; each runtime kind has its own domain tag. */
export function workflowPolicyDigest(tag: string, scope: Scope, settings: WorkflowPolicySettings): string {
  return digest(tag, { scope, permissions: [...settings.permissions.allow].sort(), policyVersion: settings.policyVersion,
    maxCostMicros: settings.maxCostMicros, maxOutputBytes: settings.maxOutputBytes, approvalTtlMs: settings.approvalTtlMs });
}

/** @internal */
export function unknownWorkflowPolicy(): MayuraError {
  return new MayuraError('CONFLICT', 'This run was started under different runtime settings (permissions, policyVersion or limits). '
    + 'List those settings in previousPolicies to let it continue, or migrate it.');
}

type LifecycleSubmission = Parameters<WorkflowLifecycleRuntime['submit']>;
const pinnedSubmissions = new WeakMap<WorkflowLifecycleRuntime, (policy: number, ...submission: LifecycleSubmission) => Promise<WorkflowLifecycleSnapshot>>();

/**
 * @internal Submit under the runtime's policy at `policy` (0: current, n: `previousPolicies[n - 1]`), so the later
 * children of a pinned saga or loop keep the parent's settings instead of gaining the current ones.
 */
export function submitWorkflowLifecycleUnder(runtime: WorkflowLifecycleRuntime, policy: number, ...submission: LifecycleSubmission): Promise<WorkflowLifecycleSnapshot> {
  const submit = pinnedSubmissions.get(runtime);
  if (!submit) throw new MayuraError('INVALID_CONFIG', 'A genuine workflow lifecycle runtime is required.');
  return submit(policy, ...submission);
}

/** Conservative durable lifecycle driver. Waiting nodes never retain a callback, worker, or timer handle. */
export function createWorkflowLifecycleRuntime(options: WorkflowLifecycleRuntimeOptions): WorkflowLifecycleRuntime {
  const store = options.store;
  const scope = Object.freeze({ principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  if ([scope.principalId, scope.projectId, options.policyVersion].some(value => typeof value !== 'string' || value.length < 1 || value.length > 128)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow lifecycle scope and policy version are required.');
  }
  const settings = workflowPolicySettings(options);
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 30_000;
  const maxPendingCallbacks = options.maxPendingCallbacks ?? 32;
  assertPositiveInteger(callbackTimeoutMs, 'callbackTimeoutMs');
  assertPositiveInteger(maxPendingCallbacks, 'maxPendingCallbacks');
  if (maxPendingCallbacks > 128) throw new MayuraError('INVALID_CONFIG', 'maxPendingCallbacks must not exceed 128.');
  let pendingCallbacks = 0;
  const controlled = async <T>(operation: () => Promise<T>, timeoutMs = callbackTimeoutMs): Promise<T> => {
    if (pendingCallbacks >= maxPendingCallbacks) throw new MayuraError('LIMIT_EXCEEDED', 'Lifecycle callback capacity is full.');
    pendingCallbacks += 1;
    let released = false;
    const release = (): void => { if (!released) { released = true; pendingCallbacks -= 1; } };
    const pending = Promise.resolve().then(operation);
    void pending.then(release, release);
    return bounded(() => pending, timeoutMs);
  };
  const now = (): number => {
    let value: unknown;
    try { value = (options.now ?? Date.now)(); }
    catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted lifecycle clock is unavailable.'); }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'The trusted lifecycle clock returned an invalid timestamp.');
    return value;
  };
  const scopeKey = digest('mayura:scope:v1', scope);
  type Pinned = WorkflowPolicySettings & { readonly digest: string };
  const policies: readonly Pinned[] = settings.map(entry =>
    Object.freeze({ ...entry, digest: workflowPolicyDigest('mayura:workflow-lifecycle-policy:v1', scope, entry) }));
  const currentPolicy = policies[0]!; const policy = currentPolicy.digest; const maxCostMicros = currentPolicy.maxCostMicros;
  /** The settings a stored run was started with; undefined when they are neither current nor listed. */
  const pinnedTo = (state: State): Pinned | undefined => policies.find(entry => entry.digest === state.policy);
  const active = new Map<string, AbortController>(); let closed = false; const gate = createWorkflowDrainGate();
  const ensureOpen = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Workflow lifecycle runtime is closed.'); };
  const load = async (id: string, allowClosed = false): Promise<StoredRecord> => {
    if (!allowClosed) ensureOpen();
    if (typeof id !== 'string' || !hashPattern.test(id)) throw new MayuraError('INVALID_INPUT', 'A workflow lifecycle run ID is required.');
    const record = await storageCall(() => store.read(scopeKey, id));
    if (!record) throw new MayuraError('NOT_FOUND', 'Workflow lifecycle run was not found in this scope.');
    if (record.scope !== scopeKey || record.id !== id) throw new MayuraError('CONFLICT', 'Stored lifecycle identity does not match its requested scope.');
    stateFrom(record); return record;
  };
  const save = (record: StoredRecord, state: State, type: string, data: JsonObject = {}): Promise<StoredRecord> =>
    storageCall(() => store.update({ scope: scopeKey, id: record.id, expectedVersion: record.version,
      state: jsonValue(state) as JsonObject, events: [{ type, data }] }));
  const mutate = async (id: string, transition: (state: State) => boolean, type: string,
    data: JsonObject = {}, allowClosed = false): Promise<StoredRecord> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const record = await load(id, allowClosed); const state = stateFrom(record);
      if (!transition(state)) return record;
      try { return await save(record, state, type, data); }
      catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
    }
    throw new MayuraError('CONFLICT', 'Workflow lifecycle contention exceeded the bounded retry limit.');
  };
  const checkedHuman = async (credential: unknown, approval: boolean): Promise<VerifiedHuman> => {
    if (!options.verifyHuman) throw new MayuraError('PERMISSION_DENIED', 'A trusted human identity verifier is required.');
    try {
      const verified = await controlled(() => options.verifyHuman!(credential));
      const human = { id: verified.id, projectId: verified.projectId, canApprove: verified.canApprove };
      if (typeof human.id !== 'string' || human.id.length < 1 || human.id.length > 256
        || human.projectId !== scope.projectId || (approval && human.canApprove !== true)) throw new Error();
      return Object.freeze(human);
    } catch { throw new MayuraError('PERMISSION_DENIED', 'Human identity verification failed.'); }
  };
  // Bound to the run's own policy, so an approval issued before an upgrade stays valid for the run it was issued to.
  const approvalCandidate = (node: Extract<WorkflowLifecycleNode, { kind: 'tool' }>, input: JsonValue,
    runId: string, expiresAt: number | null, policy: string): string => digest('mayura:approval:v1', { runId, nodeId: node.id,
      tool: node.tool.id, toolVersion: node.tool.version, input, policy, expiresAt });

  const schedulable = (state: State): boolean => state.status !== 'paused' && state.status !== 'cancelled';

  const skip = (step: WorkflowLifecycleStep): boolean => {
    if (terminalStepStatuses.has(step.status)) return false;
    if (step.kind === 'tool') { step.status = 'skipped'; step.costReserved = 0; }
    else if (step.kind === 'human') {
      step.status = 'skipped'; step.output = null; step.requestDigest = null; step.responseDigest = null;
      step.actorId = null; step.deadlineAtMs = null;
    } else if (step.kind === 'timer') {
      step.status = 'skipped'; step.output = null; step.fireAtMs = null; step.firedAtMs = null;
    } else if (step.kind === 'signal') {
      step.status = 'skipped'; clearSignal(step); step.deadlineAtMs = null;
    } else step.status = 'skipped';
    return true;
  };
  // A signal kept for a step that never runs is dropped with it.
  const clearSignal = (step: Extract<WorkflowLifecycleStep, { kind: 'signal' }>): void => {
    step.output = null; step.signalId = null; step.payloadDigest = null; step.receivedAtMs = null;
  };

  const bypass = (step: WorkflowLifecycleStep): boolean => {
    if (step.status !== 'pending') return false;
    if (step.kind === 'signal') clearSignal(step);
    step.status = 'bypassed'; return true;
  };
  /** Whether a `when` binding holds: it resolves to something other than `null` or `false`. */
  const applies = (condition: Binding, state: State): boolean => {
    let value: JsonValue;
    try { value = resolveBinding(condition, state.input, outputs(state)); } catch (error) {
      if (error instanceof MayuraError && error.code === 'INVALID_INPUT') return false; throw error;
    }
    return value !== null && value !== false;
  };

  async function executeNode(id: string, definition: AnyWorkflowLifecycle, node: WorkflowLifecycleNode, claimRetries = 0): Promise<void> {
    const record = await load(id); const state = stateFrom(record); const step = state.steps[node.id];
    // Every limit and grant below comes from the run's own policy, never from the current one.
    const run = pinnedTo(state);
    if (!step || step.kind !== node.kind || !run || !schedulable(state)) return;
    const { permissions, maxOutputBytes, approvalTtlMs } = run;
    // A pause or cancellation may commit after this read; every scheduling transition rechecks the latest state.
    const advance = (transition: (current: State) => boolean, type: string, data: JsonObject): Promise<StoredRecord> =>
      mutate(id, current => schedulable(current) && transition(current), type, data);
    // A dispatching step that no call in this process owns may belong to a process that stopped (killed, or frozen
    // past its limit). Once the tool's timeout and a margin have passed since the dispatch, no live process can still
    // settle it, so it is settled as recoverAbandoned would: unknown, or blocked when a receipt shows it succeeded. The
    // effect is never run again.
    if (node.kind === 'tool' && step.kind === 'tool' && step.status === 'dispatching') {
      if (active.has(`${id}/${node.id}`)) return;
      const dispatchedAtMs = await storageCall(() => dispatchedAt(store, scopeKey, id, 'lifecycle.step.dispatching', node.id));
      if (!abandoned(dispatchedAtMs, node.tool.timeoutMs, now())) return;
      await advance(current => {
        const target = current.steps[node.id];
        if (!target || target.kind !== 'tool' || target.status !== 'dispatching' || active.has(`${id}/${node.id}`)) return false;
        target.status = target.receipt?.execution === 'succeeded' ? 'blocked' : 'unknown'; current.status = 'running'; return true;
      }, 'lifecycle.step.abandoned', { nodeId: node.id });
      return;
    }
    const dependencies = (node.dependsOn ?? []).map(key => state.steps[key]!);
    if (dependencies.some(item => terminalStepStatuses.has(item.status) && !satisfiedStepStatuses.has(item.status))) {
      await advance(current => skip(current.steps[node.id]!), 'lifecycle.step.skipped', { nodeId: node.id }); return;
    }
    if (dependencies.some(item => !satisfiedStepStatuses.has(item.status))) return;
    // A condition is decided once, before the step starts; a started step is never re-evaluated.
    if (node.when !== undefined && step.status === 'pending' && !applies(node.when, state)) {
      await advance(current => bypass(current.steps[node.id]!), 'lifecycle.step.bypassed', { nodeId: node.id }); return;
    }

    if (node.kind === 'human') {
      if (step.kind !== 'human' || !['pending', 'waiting'].includes(step.status)) return;
      if (step.status === 'waiting') {
        const observedAtMs = now();
        if (step.deadlineAtMs === null || observedAtMs < step.deadlineAtMs) return;
        await advance(current => {
          const target = current.steps[node.id];
          if (!target || target.kind !== 'human' || target.status !== 'waiting' || target.deadlineAtMs === null || observedAtMs < target.deadlineAtMs) return false;
          target.status = 'timed_out'; current.status = 'running'; return true;
        }, 'lifecycle.human.timed_out', { nodeId: node.id, observedAtMs });
        return;
      }
      let context: JsonValue | null = null; let subjectDigest: string | null = null; let deadlineAtMs: number | null = null;
      try {
        if (node.request.context) context = resolveBinding(node.request.context, state.input, outputs(state));
        if (node.request.subjectDigest) subjectDigest = exactDigest(resolveBinding(node.request.subjectDigest, state.input, outputs(state)));
        if (node.request.deadlineAtMs) deadlineAtMs = exactTimestamp(resolveBinding(node.request.deadlineAtMs, state.input, outputs(state)));
      } catch {
        await advance(current => skip(current.steps[node.id]!), 'lifecycle.human.invalid', { nodeId: node.id }); return;
      }
      const requestDigest = digest('mayura:human-request:v1', { format: 1, runId: id, nodeId: node.id,
        definitionHash: definition.digest, kind: node.request.kind, schemaId: node.request.schemaId,
        schemaDigest: node.request.schemaDigest, prompt: node.request.prompt, context, subjectDigest, deadlineAtMs });
      const observedAtMs = now();
      await advance(current => {
        const target = current.steps[node.id]; if (!target || target.kind !== 'human' || target.status !== 'pending') return false;
        target.requestDigest = requestDigest; target.deadlineAtMs = deadlineAtMs;
        target.status = deadlineAtMs !== null && observedAtMs >= deadlineAtMs ? 'timed_out' : 'waiting';
        current.status = target.status === 'waiting' ? 'waiting' : 'running'; return true;
      }, deadlineAtMs !== null && observedAtMs >= deadlineAtMs ? 'lifecycle.human.timed_out' : 'lifecycle.human.requested',
      { nodeId: node.id, requestDigest });
      return;
    }

    if (node.kind === 'signal') {
      if (step.kind !== 'signal' || !['pending', 'waiting'].includes(step.status)) return;
      if (step.status === 'waiting') {
        const observedAtMs = now();
        if (step.deadlineAtMs === null || observedAtMs < step.deadlineAtMs) return;
        await advance(current => {
          const target = current.steps[node.id];
          if (!target || target.kind !== 'signal' || target.status !== 'waiting' || target.deadlineAtMs === null || observedAtMs < target.deadlineAtMs) return false;
          target.status = 'timed_out'; current.status = 'running'; return true;
        }, 'lifecycle.signal.timed_out', { nodeId: node.id, observedAtMs });
        return;
      }
      let deadlineAtMs: number | null = null;
      try { if (node.deadlineAtMs) deadlineAtMs = exactTimestamp(resolveBinding(node.deadlineAtMs, state.input, outputs(state))); }
      catch { await advance(current => skip(current.steps[node.id]!), 'lifecycle.signal.invalid', { nodeId: node.id }); return; }
      const observedAtMs = now();
      // A signal kept from before the step started counts if it arrived before the deadline.
      const decide = (target: Extract<WorkflowLifecycleStep, { kind: 'signal' }>): 'succeeded' | 'timed_out' | 'waiting' =>
        target.signalId !== null ? (deadlineAtMs === null || target.receivedAtMs! < deadlineAtMs ? 'succeeded' : 'timed_out')
          : deadlineAtMs !== null && observedAtMs >= deadlineAtMs ? 'timed_out' : 'waiting';
      const next = decide(step);
      await advance(current => {
        const target = current.steps[node.id];
        // A signal delivered since the read changes the decision: leave it to the next wave.
        if (!target || target.kind !== 'signal' || target.status !== 'pending' || decide(target) !== next) return false;
        target.deadlineAtMs = deadlineAtMs; target.status = next;
        if (next === 'timed_out') clearSignal(target);
        current.status = next === 'waiting' ? 'waiting' : 'running'; return true;
      }, next === 'succeeded' ? 'lifecycle.signal.received' : `lifecycle.signal.${next}`, { nodeId: node.id });
      return;
    }

    if (node.kind === 'timer') {
      if (step.kind !== 'timer' || !['pending', 'waiting'].includes(step.status)) return;
      let fireAtMs: number;
      try { fireAtMs = step.fireAtMs ?? exactTimestamp(resolveBinding(node.fireAtMs, state.input, outputs(state))); }
      catch {
        await advance(current => skip(current.steps[node.id]!), 'lifecycle.timer.invalid', { nodeId: node.id }); return;
      }
      const observedAtMs = now();
      await advance(current => {
        const target = current.steps[node.id]; if (!target || target.kind !== 'timer' || !['pending', 'waiting'].includes(target.status)) return false;
        if (target.fireAtMs !== null && target.fireAtMs !== fireAtMs) throw new MayuraError('CONFLICT', 'Persisted timer deadline does not match its pinned binding.');
        target.fireAtMs = fireAtMs;
        if (observedAtMs >= fireAtMs) {
          target.status = 'succeeded'; target.firedAtMs = observedAtMs; target.output = { fireAtMs, firedAtMs: observedAtMs }; current.status = 'running';
        } else { target.status = 'waiting'; current.status = 'waiting'; }
        return true;
      }, observedAtMs >= fireAtMs ? 'lifecycle.timer.fired' : 'lifecycle.timer.scheduled', { nodeId: node.id, fireAtMs });
      return;
    }

    if (node.kind === 'tool' && step.kind === 'tool' && step.status === 'waiting') {
      if (!step.approval || step.approval.expiresAt > now()) return;
      await advance(current => {
        const target = current.steps[node.id];
        if (!target || target.kind !== 'tool' || target.status !== 'waiting' || !target.approval || target.approval.expiresAt > now()) return false;
        target.status = 'pending'; target.approval = null; current.status = 'running'; return true;
      }, 'lifecycle.approval.expired', { nodeId: node.id }); return;
    }
    if (!['pending', 'approved'].includes(step.status)) return;
    if (node.kind === 'join') {
      step.output = dependencies.map(item => item.output); step.status = 'succeeded';
      try { await save(record, state, 'lifecycle.step.completed', { nodeId: node.id }); }
      catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
      return;
    }
    if (step.kind !== 'tool') return;
    const required = [`tool:${node.tool.id}`, ...node.tool.capabilities,
      ...(node.tool.effects === 'none' ? [] : [`effect:${node.tool.effects}`])];
    if (required.some(grant => !permissions.allow.includes(grant))) {
      step.status = 'blocked';
      try { await save(record, state, 'lifecycle.step.blocked', { nodeId: node.id, code: 'PERMISSION_DENIED' }); }
      catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
      return;
    }
    let input: JsonValue;
    try { input = jsonValue(await controlled(() => validate(node.tool.input,
      resolveBinding(node.input, state.input, outputs(state)), 'input'), node.tool.timeoutMs), { maxBytes: maxOutputBytes }); }
    catch {
      step.status = 'failed';
      try { await save(record, state, 'lifecycle.step.failed', { nodeId: node.id, code: 'INVALID_INPUT' }); }
      catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
      return;
    }
    const observedAtMs = now(); const previousExpiry = step.approval?.expiresAt ?? 0;
    const reviewExpiry = node.approval ? (previousExpiry > observedAtMs ? previousExpiry : observedAtMs + approvalTtlMs) : null;
    const candidateHash = approvalCandidate(node, input, id, reviewExpiry, run.digest);
    if (node.approval && (step.status !== 'approved' || step.approval?.digest !== candidateHash || step.approval.expiresAt <= observedAtMs)) {
      step.status = 'waiting'; step.approval = { digest: candidateHash, expiresAt: reviewExpiry!, humanId: null }; state.status = 'waiting';
      try { await save(record, state, 'lifecycle.approval.requested', { nodeId: node.id, digest: candidateHash }); }
      catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
      return;
    }
    const affordable = (current: State): boolean => node.tool.costMicros <= current.maxCostMicros - current.spentMicros - current.reservedMicros;
    if (!affordable(state)) {
      // Decided again on the latest state, so a concurrent write cannot drop the block while a sibling holds the budget;
      // if the budget has been released meanwhile, the step stays pending for the next wave.
      await advance(current => {
        const target = current.steps[node.id];
        if (!target || target.kind !== 'tool' || target.status !== step.status || affordable(current)) return false;
        target.status = 'blocked'; return true;
      }, 'lifecycle.step.blocked', { nodeId: node.id, code: 'BUDGET_EXCEEDED' });
      return;
    }
    step.status = 'dispatching'; step.candidateHash = candidateHash; step.costReserved = node.tool.costMicros;
    state.reservedMicros += node.tool.costMicros; state.status = 'running';
    try { await save(record, state, 'lifecycle.step.dispatching', { nodeId: node.id, callId: step.callId }); }
    catch (error) {
      if (error instanceof StorageError && error.storageCode === 'CONFLICT' && claimRetries < 32) return executeNode(id, definition, node, claimRetries + 1);
      throw error;
    }
    const controller = new AbortController(); const activeKey = `${id}/${node.id}`; active.set(activeKey, controller);
    try {
      const result = await invokeTool(node.tool, resolveBinding(node.input, state.input, outputs(state)), {
        runId: id, callId: `${id}/${step.callId}`, scope, signal: controller.signal, permissions,
        budget: new Budget(node.tool.costMicros, 1), maxOutputBytes,
        beforeDispatch: async processed => {
          const current = stateFrom(await load(id)); const target = current.steps[node.id];
          if (!target || target.kind !== 'tool' || current.status !== 'running' || current.policy !== run.digest
            || target.status !== 'dispatching' || approvalCandidate(node, processed, id,
              node.approval ? target.approval!.expiresAt : null, run.digest) !== candidateHash) throw new MayuraError('CONFLICT', 'Lifecycle dispatch candidate is no longer authorized.');
          if (node.approval && target.approval!.expiresAt <= now()) throw new MayuraError('PERMISSION_DENIED', 'Approval expired before dispatch.');
        },
        onExecutionReceipt: async (evidence, settlement) => {
          await mutate(id, current => {
            const target = current.steps[node.id]; if (!target || target.kind !== 'tool') return false;
            target.receipt = receipt(target.receipt, evidence);
            if (evidence.execution !== 'unknown' && target.costReserved > 0) {
              current.reservedMicros -= target.costReserved;
              // Charge what the tool reported (known plus unknown usage), never more than its reservation. A tool that
              // reports nothing is charged its declared cost.
              if (evidence.execution !== 'not_started') current.spentMicros += charged(settlement, target.costReserved);
              target.costReserved = 0;
            }
            return true;
          }, 'lifecycle.effect.receipt', { nodeId: node.id, execution: evidence.execution }, true);
        },
      });
      await mutate(id, current => {
        const target = current.steps[node.id]; if (!target || target.kind !== 'tool' || target.status !== 'dispatching') return false;
        if (result.receipt) target.receipt = receipt(target.receipt, result.receipt);
        if (result.status === 'succeeded') { target.status = 'succeeded'; target.output = jsonValue(result.output, { maxBytes: maxOutputBytes }); }
        else target.status = result.status === 'outcome_unknown' ? 'unknown' : result.status === 'blocked' ? 'blocked' : 'failed';
        if (result.receipt?.execution === 'not_started' && target.costReserved > 0) { current.reservedMicros -= target.costReserved; target.costReserved = 0; }
        return true;
      }, 'lifecycle.step.completed', { nodeId: node.id, outcome: result.status });
    } finally { active.delete(activeKey); }
  }

  /** The exact request a waiting human step shows, bound to the definition digest that issued it. */
  const humanEvidence = (definition: AnyWorkflowLifecycle, node: Extract<WorkflowLifecycleNode, { kind: 'human' }>, id: string, state: State):
    { readonly requestDigest: string; readonly deadlineAtMs: number | null; readonly context: JsonValue | null; readonly subjectDigest: string | null } => {
    let context: JsonValue | null = null; let subjectDigest: string | null = null; let deadlineAtMs: number | null = null;
    try {
      if (node.request.context) context = resolveBinding(node.request.context, state.input, outputs(state));
      if (node.request.subjectDigest) subjectDigest = exactDigest(resolveBinding(node.request.subjectDigest, state.input, outputs(state)));
      if (node.request.deadlineAtMs) deadlineAtMs = exactTimestamp(resolveBinding(node.request.deadlineAtMs, state.input, outputs(state)));
    } catch { throw new MayuraError('CONFLICT', 'Persisted human request bindings no longer resolve.'); }
    const requestDigest = digest('mayura:human-request:v1', { format: 1, runId: id, nodeId: node.id,
      definitionHash: definition.digest, kind: node.request.kind, schemaId: node.request.schemaId,
      schemaDigest: node.request.schemaDigest, prompt: node.request.prompt, context, subjectDigest, deadlineAtMs });
    return { requestDigest, deadlineAtMs, context, subjectDigest };
  };

  /** Checks the pinned definition and returns the settings the run was started with. */
  function verifyDefinition(definition: AnyWorkflowLifecycle, record: StoredRecord, state: State): Pinned;
  function verifyDefinition(definition: AnyWorkflowLifecycle, record: StoredRecord, state: State, anyPolicy: true): Pinned | undefined;
  function verifyDefinition(definition: AnyWorkflowLifecycle, record: StoredRecord, state: State, anyPolicy = false): Pinned | undefined {
    assertWorkflowLifecycle(definition);
    if (record.definitionHash !== definition.digest || state.definition !== definition.digest) {
      throw new MayuraError('CONFLICT', 'Lifecycle definition changed; explicit migration/review is required.');
    }
    const run = pinnedTo(state);
    if (run ? state.maxCostMicros !== run.maxCostMicros : !anyPolicy) throw unknownWorkflowPolicy();
    try { assertWorkflowLifecycleStateMatchesManifest(state, lifecycleManifest(definition)); }
    catch { throw new MayuraError('CONFLICT', 'Stored lifecycle steps do not match the pinned definition.'); }
    return run;
  }

  const respondAs = async (definition: AnyWorkflowLifecycle, command: { readonly id: string; readonly nodeId: string;
    readonly requestDigest: string; readonly commandId: string; readonly value: unknown }, actor: WorkflowLifecycleVerifiedActor): Promise<WorkflowLifecycleSnapshot> => {
    ensureOpen(); assertWorkflowLifecycle(definition);
    if (!hashPattern.test(command.id) || !nodePattern.test(command.nodeId) || !hashPattern.test(command.requestDigest)
      || typeof command.commandId !== 'string' || command.commandId.length < 1 || command.commandId.length > 128) {
      throw new MayuraError('INVALID_INPUT', 'Human response requires exact run, node, request and command identifiers.');
    }
    if (!actor || typeof actor.id !== 'string' || actor.id.length < 1 || actor.id.length > 256 || actor.projectId !== scope.projectId) {
      throw new MayuraError('PERMISSION_DENIED', 'Verified human actor does not belong to this lifecycle project.');
    }
    const node = definition.nodes.find(candidate => candidate.id === command.nodeId);
    if (!node || node.kind !== 'human') throw new MayuraError('INVALID_INPUT', 'Human response node is not part of the lifecycle definition.');
    const before = await load(command.id); const run = verifyDefinition(definition, before, stateFrom(before));
    const value = jsonValue(await controlled(() => validate(node.request.response, command.value, 'input')), { maxBytes: run.maxOutputBytes });
    const responseDigest = digest('mayura:human-response:v1', { requestDigest: command.requestDigest,
      commandId: command.commandId, actorId: actor.id, value });
    const observedAtMs = now();
    return publicSnapshot(await mutate(command.id, state => {
      const step = state.steps[command.nodeId];
      if (!step || step.kind !== 'human' || state.policy !== run.digest || step.requestDigest !== command.requestDigest) {
        throw new MayuraError('CONFLICT', 'Human request is stale or mismatched.');
      }
      if (step.status === 'succeeded') {
        if (step.responseDigest !== responseDigest) throw new MayuraError('CONFLICT', 'Human request already has a different response.');
        return false;
      }
      if (step.status !== 'waiting' || (step.deadlineAtMs !== null && observedAtMs >= step.deadlineAtMs)) {
        throw new MayuraError('CONFLICT', 'Human request is no longer accepting responses.');
      }
      step.status = 'succeeded'; step.responseDigest = responseDigest; step.actorId = actor.id; step.output = value;
      if (state.status !== 'paused') state.status = 'running'; return true;
    }, 'lifecycle.human.responded', { nodeId: command.nodeId, requestDigest: command.requestDigest,
      responseDigest, actorId: actor.id }));
  };

  const submitUnder = async (under: Pinned, definition: AnyWorkflowLifecycle, command: LifecycleSubmission[1]): Promise<WorkflowLifecycleSnapshot> => {
    ensureOpen(); assertWorkflowLifecycle(definition);
    if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 128) {
      throw new MayuraError('INVALID_INPUT', 'A bounded lifecycle submission key is required.');
    }
    const inputSnapshot = freezeJson(jsonValue(command.input, { maxBytes: under.maxOutputBytes }));
    const input = jsonValue(await controlled(() => validate(definition.input, inputSnapshot, 'input')), { maxBytes: under.maxOutputBytes });
    const state = initialWorkflowLifecycleState(lifecycleManifest(definition), input, definition.digest, under.digest, under.maxCostMicros);
    const id = digest('mayura:workflow-lifecycle-run-id:v1', { scope: scopeKey, submissionKey: command.idempotencyKey });
    const created = await createSubmission(() => store.create({ scope: scopeKey, id, idempotencyKey: `lifecycle:${command.idempotencyKey}`,
      definitionHash: definition.digest, state: jsonValue(state) as JsonObject, events: [{ type: 'lifecycle.run.created', data: {} }] }), 'workflow lifecycle run');
    verifyDefinition(definition, created.record, stateFrom(created.record)); return publicSnapshot(created.record);
  };

  const runtime = Object.freeze<WorkflowLifecycleRuntime>({
    profile: 'lifecycle-v1',
    // New runs always use the current settings.
    submit: (definition, command) => submitUnder(currentPolicy, definition, command),
    inspect: async id => publicSnapshot(await load(id)),
    humanRequest: async (definition, id, nodeId) => {
      ensureOpen(); assertWorkflowLifecycle(definition);
      if (!nodePattern.test(nodeId)) throw new MayuraError('INVALID_INPUT', 'A lifecycle human node ID is required.');
      const record = await load(id); const state = stateFrom(record); verifyDefinition(definition, record, state);
      const node = definition.nodes.find(candidate => candidate.id === nodeId);
      const step = state.steps[nodeId];
      if (!node || node.kind !== 'human' || !step || step.kind !== 'human') throw new MayuraError('NOT_FOUND', 'Lifecycle human request was not found.');
      if (step.status === 'pending' || step.status === 'skipped' || step.status === 'bypassed') return undefined;
      const { requestDigest, deadlineAtMs, context, subjectDigest } = humanEvidence(definition, node, id, state);
      if (step.requestDigest !== requestDigest || step.deadlineAtMs !== deadlineAtMs) throw new MayuraError('CONFLICT', 'Persisted human request evidence does not match its definition.');
      return freezeJson(jsonValue({ runId: id, nodeId, status: step.status, kind: node.request.kind,
        schemaId: node.request.schemaId, schemaDigest: node.request.schemaDigest, prompt: node.request.prompt,
        digest: requestDigest, context, subjectDigest, deadlineAtMs })) as unknown as WorkflowLifecycleHumanRequest;
    },
    approvalRequest: async (definition, id, nodeId) => {
      ensureOpen(); assertWorkflowLifecycle(definition);
      if (!nodePattern.test(nodeId)) throw new MayuraError('INVALID_INPUT', 'A lifecycle tool node ID is required.');
      const record = await load(id); const state = stateFrom(record); const run = verifyDefinition(definition, record, state);
      const node = definition.nodes.find(candidate => candidate.id === nodeId);
      const step = state.steps[nodeId];
      if (!node || node.kind !== 'tool' || !step || step.kind !== 'tool') throw new MayuraError('NOT_FOUND', 'Lifecycle tool node was not found.');
      if (!node.approval || !step.approval || (step.status !== 'waiting' && step.status !== 'approved')) return undefined;
      // Rebuild the input exactly as preparation did; it must reproduce the persisted digest, or the evidence is refused.
      const input = jsonValue(await controlled(() => validate(node.tool.input, resolveBinding(node.input, state.input, outputs(state)), 'input'),
        node.tool.timeoutMs), { maxBytes: run.maxOutputBytes });
      if (approvalCandidate(node, input, id, step.approval.expiresAt, run.digest) !== step.approval.digest) {
        throw new MayuraError('CONFLICT', 'Persisted approval evidence does not match its definition.');
      }
      return freezeJson(jsonValue({ runId: id, nodeId, status: step.status, toolId: node.tool.id, toolVersion: node.tool.version, input,
        digest: step.approval.digest, expiresAtMs: step.approval.expiresAt })) as unknown as WorkflowLifecycleApprovalRequest;
    },
    events: (id, after = 0) => { ensureOpen(); return storageCall(() => store.events(scopeKey, id, after)); },
    runUntilSettled: async (definition, id) => {
      ensureOpen(); if (gate.draining) throw new MayuraError('CANCELLED', 'Workflow lifecycle runtime is draining.'); assertWorkflowLifecycle(definition);
      for (let wave = 0; wave <= definition.nodes.length + 2; wave++) {
        const before = await load(id); const state = stateFrom(before); verifyDefinition(definition, before, state);
        if (state.status === 'paused' || finalRunStatuses.has(state.status)) return publicSnapshot(before);
        // Each wave holds one drain admission until its effects and receipts settle.
        const release = gate.enter(); if (!release) return publicSnapshot(before);
        try { await Promise.all(definition.nodes.map(node => executeNode(id, definition, node))); } finally { release(); }
        let after = await load(id); const next = stateFrom(after); const run = verifyDefinition(definition, after, next);
        const steps = Object.values(next.steps);
        if (!schedulable(next)) return publicSnapshot(after);
        if (steps.every(step => terminalStepStatuses.has(step.status))) {
          if (steps.every(step => satisfiedStepStatuses.has(step.status))) {
            try { next.output = jsonValue(await controlled(() => validate(definition.output,
              resolveBinding(definition.result, next.input, outputs(next)), 'output')), { maxBytes: run.maxOutputBytes }); next.status = 'succeeded'; }
            catch { next.status = 'failed'; }
          } else next.status = steps.some(step => step.status === 'unknown') ? 'outcome_unknown'
            : steps.some(step => step.status === 'blocked') ? 'blocked' : 'failed';
          try { after = await save(after, next, 'lifecycle.run.completed', { status: next.status }); }
          catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; after = await load(id); }
          return publicSnapshot(after);
        }
        if (after.version === before.version) {
          const waiting = steps.some(step => step.status === 'waiting');
          if (waiting && next.status !== 'waiting') {
            next.status = 'waiting';
            try { after = await save(after, next, 'lifecycle.run.waiting'); }
            catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; after = await load(id); }
          }
          return publicSnapshot(after);
        }
      }
      return publicSnapshot(await load(id));
    },
    approve: async command => {
      ensureOpen();
      if (!hashPattern.test(command.id) || !nodePattern.test(command.nodeId) || !hashPattern.test(command.digest)) {
        throw new MayuraError('INVALID_INPUT', 'Approval requires exact run, node and candidate identifiers.');
      }
      const human = await checkedHuman(command.credential, true); const observedAtMs = now();
      return publicSnapshot(await mutate(command.id, state => {
        const step = state.steps[command.nodeId];
        // The digest binds the run's own policy; a run under an unlisted policy has nothing approvable.
        if (!step || step.kind !== 'tool' || !pinnedTo(state) || !step.approval || step.approval.digest !== command.digest) {
          throw new MayuraError('CONFLICT', 'Approval request is stale, expired or mismatched.');
        }
        if (step.status !== 'waiting' && step.approval.humanId === human.id) return false;
        if (state.status === 'cancelled' || step.status !== 'waiting' || step.approval.expiresAt <= observedAtMs) {
          throw new MayuraError('CONFLICT', 'Approval request is stale, expired or mismatched.');
        }
        step.approval.humanId = human.id; step.status = 'approved'; if (state.status !== 'paused') state.status = 'running'; return true;
      }, 'lifecycle.approval.resolved', { nodeId: command.nodeId, humanId: human.id }));
    },
    respond: async (definition, command) => {
      if (!hashPattern.test(command.id) || !nodePattern.test(command.nodeId) || !hashPattern.test(command.requestDigest)
        || typeof command.commandId !== 'string' || command.commandId.length < 1 || command.commandId.length > 128) {
        throw new MayuraError('INVALID_INPUT', 'Human response requires exact run, node, request and command identifiers.');
      }
      const human = await checkedHuman(command.credential, false);
      return respondAs(definition, command, { id: human.id, projectId: human.projectId });
    },
    respondVerified: (definition, command) => respondAs(definition, command, command.actor),
    signal: async (definition, command) => {
      ensureOpen(); assertWorkflowLifecycle(definition);
      if (!command || typeof command.id !== 'string' || !hashPattern.test(command.id) || typeof command.name !== 'string' || !signalPattern.test(command.name)
        || typeof command.signalId !== 'string' || !signalPattern.test(command.signalId)
        || (command.actorId !== undefined && (typeof command.actorId !== 'string' || command.actorId.length < 1 || command.actorId.length > 256))) {
        throw new MayuraError('INVALID_INPUT', 'A signal needs a run id, a signal name and a signal id (1–128 letters, digits, ".", "_", "/" or "-").');
      }
      const node = definition.nodes.find(candidate => candidate.kind === 'signal' && candidate.name === command.name);
      if (!node || node.kind !== 'signal') throw new MayuraError('NOT_FOUND', `This workflow has no signal step named "${command.name}".`);
      const before = await load(command.id); const run = verifyDefinition(definition, before, stateFrom(before));
      let payload: JsonValue;
      try { payload = jsonValue(await controlled(() => validate(node.payload, command.payload, 'input')), { maxBytes: run.maxOutputBytes }); }
      catch (error) {
        if (error instanceof MayuraError && ['TIMEOUT', 'LIMIT_EXCEEDED'].includes(error.code)) throw error;
        throw new MayuraError('INVALID_INPUT', `The payload of signal "${command.name}" does not match the step's payload schema.`);
      }
      const payloadDigest = digest('mayura:workflow-signal:v1', { runId: command.id, nodeId: node.id, signalId: command.signalId, payload });
      const receivedAtMs = now();
      return publicSnapshot(await mutate(command.id, state => {
        const step = state.steps[node.id];
        if (!step || step.kind !== 'signal') throw new MayuraError('CONFLICT', 'Stored lifecycle steps do not match the pinned definition.');
        if (step.signalId !== null) {
          // Idempotent on the signal id: the same signal again changes nothing.
          if (step.signalId === command.signalId && step.payloadDigest === payloadDigest) return false;
          throw new MayuraError('CONFLICT', step.signalId === command.signalId
            ? `Signal "${command.signalId}" was already delivered with a different payload.`
            : `Signal step "${node.id}" already received signal "${step.signalId}"; a signal step accepts one signal.`);
        }
        if (finalRunStatuses.has(state.status)) throw new MayuraError('CONFLICT', `The run is ${state.status}; it no longer accepts signals.`);
        if (step.status !== 'pending' && step.status !== 'waiting') {
          throw new MayuraError('CONFLICT', `Signal step "${node.id}" is ${step.status}; it no longer accepts signals.`);
        }
        if (step.status === 'waiting' && step.deadlineAtMs !== null && receivedAtMs >= step.deadlineAtMs) {
          throw new MayuraError('CONFLICT', `Signal step "${node.id}" passed its deadline; it no longer accepts signals.`);
        }
        step.signalId = command.signalId; step.payloadDigest = payloadDigest; step.receivedAtMs = receivedAtMs; step.output = payload;
        // A step that has not started keeps the signal until it starts.
        if (step.status === 'waiting') { step.status = 'succeeded'; if (state.status !== 'paused') state.status = 'running'; }
        return true;
      }, 'lifecycle.signal.delivered', { nodeId: node.id, signalId: command.signalId, payloadDigest,
        ...(command.actorId === undefined ? {} : { actorId: command.actorId }) }));
    },
    pause: async id => publicSnapshot(await mutate(id, state => {
      if (state.status === 'paused') return false;
      if (finalRunStatuses.has(state.status)) throw new MayuraError('CONFLICT', 'A terminal lifecycle workflow cannot be paused.');
      if (Object.values(state.steps).some(step => step.kind === 'tool' && step.status === 'dispatching')) {
        throw new MayuraError('CONFLICT', 'A lifecycle workflow with an in-flight effect cannot enter the quiescent paused state.');
      }
      state.status = 'paused'; return true;
    }, 'lifecycle.run.paused')),
    migrate: async (migration, command) => {
      ensureOpen(); assertWorkflowMigration(migration); assertWorkflowLifecycle(migration.from); assertWorkflowLifecycle(migration.to);
      const { id, actorId, commandId, dryRun = false } = migrationCommand(command);
      // A reviewed migration is the explicit way to move a run onto the current settings, whichever it started under.
      const record = await load(id); const state = stateFrom(record); verifyDefinition(migration.from, record, state, true);
      const nodes = (definition: AnyWorkflowLifecycle) => lifecycleManifest(definition).graph.map(node =>
        ({ id: node.id, kind: node.kind, dependsOn: node.dependsOn, fingerprint: nodeFingerprint(node as unknown as Record<string, unknown>),
          ...(nodeEvidence(node) ? { evidence: nodeEvidence(node)! } : {}) }));
      const preconditions: MigrationBlocker[] = [];
      if (state.status !== 'paused') preconditions.push({ node: '*', reason: `The run is ${state.status}; pause it before migrating.` });
      if (state.spentMicros > maxCostMicros) preconditions.push({ node: '*', reason: 'The run already spent more than the current maxCostMicros.' });
      const plan = planWorkflowMigration({ migration, format: 'lifecycle-v1', runId: id, fromDigest: migration.from.digest, toDigest: migration.to.digest,
        from: nodes(migration.from), to: nodes(migration.to), steps: Object.entries(state.steps).map(([step, value]) => ({ id: step, status: value.status })), preconditions });
      if (dryRun) return freezeJson(jsonValue({ plan })) as unknown as WorkflowMigrationResult<WorkflowLifecycleSnapshot>;
      assertMigrationAllowed(plan);
      const fresh = initialWorkflowLifecycleState(lifecycleManifest(migration.to), state.input, migration.to.digest, policy, maxCostMicros);
      const steps: Record<string, WorkflowLifecycleStep> = {};
      for (const entry of plan.entries) {
        if (!entry.target) continue;
        const source = entry.source === undefined ? undefined : state.steps[entry.source];
        steps[entry.target] = entry.action === 'keep' || entry.action === 'accept'
          || (entry.action === 'update' && source?.kind === 'signal' && fresh.steps[entry.target]!.kind === 'signal') ? source! : fresh.steps[entry.target]!;
      }
      const next: State = { ...state, definition: migration.to.digest, policy, maxCostMicros,
        steps: Object.fromEntries(migration.to.nodes.map(node => [node.id, steps[node.id]!])) };
      // Released holds: only carried tool steps keep reserved cost.
      next.reservedMicros = Object.values(next.steps).reduce((sum, step) => sum + (step.kind === 'tool' ? step.costReserved : 0), 0);
      for (const node of migration.to.nodes) {
        const step = next.steps[node.id]!;
        if (node.kind === 'human' && step.kind === 'human' && step.status === 'waiting') {
          const evidence = humanEvidence(migration.to, node, id, next); step.requestDigest = evidence.requestDigest; step.deadlineAtMs = evidence.deadlineAtMs;
        }
      }
      try { assertWorkflowLifecycleStateMatchesManifest(workflowLifecycleState({ id, state: jsonValue(next) as JsonObject }), lifecycleManifest(migration.to)); }
      catch { throw new MayuraError('CONFLICT', 'Migration refused: the migrated state does not satisfy the new definition.'); }
      if (typeof store.migrate !== 'function') throw new MayuraError('UNSUPPORTED_PROFILE', 'This store cannot migrate in-flight workflow runs.');
      const migrated = await storageCall(() => store.migrate!({ scope: scopeKey, id, expectedVersion: record.version, expectedDefinitionHash: migration.from.digest,
        definitionHash: migration.to.digest, state: jsonValue(next) as JsonObject, events: [migrationEvent(plan, actorId, commandId) as { type: string; data: JsonObject }] }));
      verifyDefinition(migration.to, migrated, stateFrom(migrated));
      return freezeJson(jsonValue({ plan, snapshot: publicSnapshot(migrated) })) as unknown as WorkflowMigrationResult<WorkflowLifecycleSnapshot>;
    },
    resume: async id => publicSnapshot(await mutate(id, state => {
      if (state.status !== 'paused') throw new MayuraError('CONFLICT', 'Only a paused lifecycle workflow can be resumed.');
      state.status = Object.values(state.steps).some(step => step.status === 'waiting') ? 'waiting' : 'running'; return true;
    }, 'lifecycle.run.resumed')),
    cancel: async id => {
      const record = await mutate(id, state => {
        if (finalRunStatuses.has(state.status)) return false;
        for (const step of Object.values(state.steps)) if (step.status !== 'dispatching') skip(step);
        state.status = 'cancelled'; return true;
      }, 'lifecycle.run.cancelled');
      for (const [key, controller] of active) if (key.startsWith(`${id}/`)) controller.abort();
      return publicSnapshot(record);
    },
    recoverAbandoned: async id => publicSnapshot(await mutate(id, state => {
      let changed = false;
      for (const step of Object.values(state.steps)) if (step.kind === 'tool' && step.status === 'dispatching') {
        step.status = step.receipt?.execution === 'succeeded' ? 'blocked' : 'unknown'; changed = true;
      }
      if (changed && state.status !== 'cancelled') state.status = 'running'; return changed;
    }, 'lifecycle.run.recovery_required')),
    close: () => { closed = true; for (const controller of active.values()) controller.abort(); },
    drain: options => gate.drain(options, () => { closed = true; for (const controller of active.values()) controller.abort(); }),
  });
  pinnedSubmissions.set(runtime, (index, definition, command) => {
    const under = policies[index];
    if (!Number.isSafeInteger(index) || !under) throw new MayuraError('INVALID_INPUT', 'The requested lifecycle policy is not configured.');
    return submitUnder(under, definition, command);
  });
  return runtime;
}
