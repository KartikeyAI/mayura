import { Budget, MayuraError, assertPositiveInteger, freezeJson, jsonValue, validate,
  type ExecutionReceipt, type JsonObject, type JsonValue, type Permissions, type Scope } from '@mayura/core';
import { invokeTool } from '@mayura/tools';
import { StorageError, assertWorkflowLifecycleStateMatchesManifest, initialWorkflowLifecycleState,
  mergeWorkflowReceipt, workflowLifecycleOutputs, workflowLifecycleState,
  type AggregateStore, type StoredRecord, type WorkflowLifecycleState as State,
  type WorkflowLifecycleStatus, type WorkflowLifecycleStep } from '@mayura/storage-contracts';
import { digest, resolveBinding } from './definition.js';
import { assertWorkflowLifecycle, lifecycleManifest, type AnyWorkflowLifecycle,
  type WorkflowLifecycleNode } from './lifecycle-definition.js';
import type { VerifiedHuman } from './runtime.js';

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

export interface WorkflowLifecycleRuntimeOptions {
  readonly store: AggregateStore;
  readonly scope: Scope;
  readonly permissions: Permissions;
  readonly policyVersion: string;
  readonly maxCostMicros: number;
  readonly approvalTtlMs?: number;
  readonly maxOutputBytes?: number;
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
  events(id: string, after?: number): ReturnType<AggregateStore['events']>;
  runUntilSettled(definition: AnyWorkflowLifecycle, id: string): Promise<WorkflowLifecycleSnapshot>;
  approve(command: { readonly id: string; readonly nodeId: string; readonly digest: string; readonly credential: unknown }): Promise<WorkflowLifecycleSnapshot>;
  respond(definition: AnyWorkflowLifecycle, command: { readonly id: string; readonly nodeId: string;
    readonly requestDigest: string; readonly commandId: string; readonly credential: unknown; readonly value: unknown }): Promise<WorkflowLifecycleSnapshot>;
  respondVerified(definition: AnyWorkflowLifecycle, command: { readonly id: string; readonly nodeId: string;
    readonly requestDigest: string; readonly commandId: string; readonly actor: WorkflowLifecycleVerifiedActor; readonly value: unknown }): Promise<WorkflowLifecycleSnapshot>;
  pause(id: string): Promise<WorkflowLifecycleSnapshot>;
  resume(id: string): Promise<WorkflowLifecycleSnapshot>;
  cancel(id: string): Promise<WorkflowLifecycleSnapshot>;
  recoverAbandoned(id: string): Promise<WorkflowLifecycleSnapshot>;
  close(): void;
}

const finalRunStatuses = new Set<WorkflowLifecycleStatus>(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const terminalStepStatuses = new Set(['succeeded', 'failed', 'blocked', 'unknown', 'timed_out', 'skipped']);
const hashPattern = /^[a-f0-9]{64}$/;
const nodePattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

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
  catch (error) {
    if (error instanceof StorageError && error.code === 'CONFLICT') throw new StorageError('CONFLICT', 'Workflow lifecycle storage version changed.');
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow lifecycle storage is unavailable; reconcile uncertain actions before retrying.');
  }
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
    ? [step.fireAtMs] : step.kind === 'human' && step.status === 'waiting' && step.deadlineAtMs !== null
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

/** Conservative durable lifecycle driver. Waiting nodes never retain a callback, worker, or timer handle. */
export function createWorkflowLifecycleRuntime(options: WorkflowLifecycleRuntimeOptions): WorkflowLifecycleRuntime {
  const store = options.store;
  const scope = Object.freeze({ principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  if ([scope.principalId, scope.projectId, options.policyVersion].some(value => typeof value !== 'string' || value.length < 1 || value.length > 128)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow lifecycle scope and policy version are required.');
  }
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4_096
    || options.permissions.allow.some(grant => typeof grant !== 'string' || grant.length < 1 || grant.length > 256)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow lifecycle permissions must be bounded explicit grants.');
  }
  if (!Number.isSafeInteger(options.maxCostMicros) || options.maxCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'A bounded lifecycle cost is required.');
  const permissions = Object.freeze({ allow: Object.freeze([...options.permissions.allow]) });
  const maxCostMicros = options.maxCostMicros;
  const approvalTtlMs = options.approvalTtlMs ?? 3_600_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 30_000;
  const maxPendingCallbacks = options.maxPendingCallbacks ?? 32;
  assertPositiveInteger(approvalTtlMs, 'approvalTtlMs'); assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');
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
  const policy = digest('mayura:workflow-lifecycle-policy:v1', { scope, permissions: [...permissions.allow].sort(),
    policyVersion: options.policyVersion, maxCostMicros, maxOutputBytes, approvalTtlMs });
  const active = new Map<string, AbortController>(); let closed = false;
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
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
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
  const approvalCandidate = (node: Extract<WorkflowLifecycleNode, { kind: 'tool' }>, input: JsonValue,
    runId: string, expiresAt: number | null): string => digest('mayura:approval:v1', { runId, nodeId: node.id,
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
    } else step.status = 'skipped';
    return true;
  };

  async function executeNode(id: string, definition: AnyWorkflowLifecycle, node: WorkflowLifecycleNode, claimRetries = 0): Promise<void> {
    const record = await load(id); const state = stateFrom(record); const step = state.steps[node.id];
    if (!step || step.kind !== node.kind || state.policy !== policy || !schedulable(state)) return;
    // A pause or cancellation may commit after this read; every scheduling transition rechecks the latest state.
    const advance = (transition: (current: State) => boolean, type: string, data: JsonObject): Promise<StoredRecord> =>
      mutate(id, current => schedulable(current) && transition(current), type, data);
    const dependencies = (node.dependsOn ?? []).map(key => state.steps[key]!);
    if (dependencies.some(item => terminalStepStatuses.has(item.status) && item.status !== 'succeeded')) {
      await advance(current => skip(current.steps[node.id]!), 'lifecycle.step.skipped', { nodeId: node.id }); return;
    }
    if (dependencies.some(item => item.status !== 'succeeded')) return;

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
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    if (step.kind !== 'tool') return;
    const required = [`tool:${node.tool.id}`, ...node.tool.capabilities,
      ...(node.tool.effects === 'none' ? [] : [`effect:${node.tool.effects}`])];
    if (required.some(grant => !permissions.allow.includes(grant))) {
      step.status = 'blocked';
      try { await save(record, state, 'lifecycle.step.blocked', { nodeId: node.id, code: 'PERMISSION_DENIED' }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    let input: JsonValue;
    try { input = jsonValue(await controlled(() => validate(node.tool.input,
      resolveBinding(node.input, state.input, outputs(state)), 'input'), node.tool.timeoutMs), { maxBytes: maxOutputBytes }); }
    catch {
      step.status = 'failed';
      try { await save(record, state, 'lifecycle.step.failed', { nodeId: node.id, code: 'INVALID_INPUT' }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    const observedAtMs = now(); const previousExpiry = step.approval?.expiresAt ?? 0;
    const reviewExpiry = node.approval ? (previousExpiry > observedAtMs ? previousExpiry : observedAtMs + approvalTtlMs) : null;
    const candidateHash = approvalCandidate(node, input, id, reviewExpiry);
    if (node.approval && (step.status !== 'approved' || step.approval?.digest !== candidateHash || step.approval.expiresAt <= observedAtMs)) {
      step.status = 'waiting'; step.approval = { digest: candidateHash, expiresAt: reviewExpiry!, humanId: null }; state.status = 'waiting';
      try { await save(record, state, 'lifecycle.approval.requested', { nodeId: node.id, digest: candidateHash }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    if (node.tool.costMicros > state.maxCostMicros - state.spentMicros - state.reservedMicros) {
      step.status = 'blocked';
      try { await save(record, state, 'lifecycle.step.blocked', { nodeId: node.id, code: 'BUDGET_EXCEEDED' }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    step.status = 'dispatching'; step.candidateHash = candidateHash; step.costReserved = node.tool.costMicros;
    state.reservedMicros += node.tool.costMicros; state.status = 'running';
    try { await save(record, state, 'lifecycle.step.dispatching', { nodeId: node.id, callId: step.callId }); }
    catch (error) {
      if (error instanceof StorageError && error.code === 'CONFLICT' && claimRetries < 32) return executeNode(id, definition, node, claimRetries + 1);
      throw error;
    }
    const controller = new AbortController(); const activeKey = `${id}/${node.id}`; active.set(activeKey, controller);
    try {
      const result = await invokeTool(node.tool, resolveBinding(node.input, state.input, outputs(state)), {
        runId: id, callId: `${id}/${step.callId}`, scope, signal: controller.signal, permissions,
        budget: new Budget(node.tool.costMicros, 1), maxOutputBytes,
        beforeDispatch: async processed => {
          const current = stateFrom(await load(id)); const target = current.steps[node.id];
          if (!target || target.kind !== 'tool' || current.status !== 'running' || current.policy !== policy
            || target.status !== 'dispatching' || approvalCandidate(node, processed, id,
              node.approval ? target.approval!.expiresAt : null) !== candidateHash) throw new MayuraError('CONFLICT', 'Lifecycle dispatch candidate is no longer authorized.');
          if (node.approval && target.approval!.expiresAt <= now()) throw new MayuraError('PERMISSION_DENIED', 'Approval expired before dispatch.');
        },
        onExecutionReceipt: async evidence => {
          await mutate(id, current => {
            const target = current.steps[node.id]; if (!target || target.kind !== 'tool') return false;
            target.receipt = receipt(target.receipt, evidence);
            if (evidence.execution !== 'unknown' && target.costReserved > 0) {
              current.reservedMicros -= target.costReserved;
              if (evidence.execution !== 'not_started') current.spentMicros += target.costReserved;
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

  const verifyDefinition = (definition: AnyWorkflowLifecycle, record: StoredRecord, state: State): void => {
    assertWorkflowLifecycle(definition);
    if (record.definitionHash !== definition.digest || state.definition !== definition.digest || state.policy !== policy
      || state.maxCostMicros !== maxCostMicros) throw new MayuraError('CONFLICT', 'Lifecycle definition or policy changed; explicit migration/review is required.');
    try { assertWorkflowLifecycleStateMatchesManifest(state, lifecycleManifest(definition)); }
    catch { throw new MayuraError('CONFLICT', 'Stored lifecycle steps do not match the pinned definition.'); }
  };

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
    const before = await load(command.id); verifyDefinition(definition, before, stateFrom(before));
    const value = jsonValue(await controlled(() => validate(node.request.response, command.value, 'input')), { maxBytes: maxOutputBytes });
    const responseDigest = digest('mayura:human-response:v1', { requestDigest: command.requestDigest,
      commandId: command.commandId, actorId: actor.id, value });
    const observedAtMs = now();
    return publicSnapshot(await mutate(command.id, state => {
      const step = state.steps[command.nodeId];
      if (!step || step.kind !== 'human' || state.policy !== policy || step.requestDigest !== command.requestDigest) {
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

  return Object.freeze<WorkflowLifecycleRuntime>({
    profile: 'lifecycle-v1',
    submit: async (definition, command) => {
      ensureOpen(); assertWorkflowLifecycle(definition);
      if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 128) {
        throw new MayuraError('INVALID_INPUT', 'A bounded lifecycle submission key is required.');
      }
      const inputSnapshot = freezeJson(jsonValue(command.input, { maxBytes: maxOutputBytes }));
      const input = jsonValue(await controlled(() => validate(definition.input, inputSnapshot, 'input')), { maxBytes: maxOutputBytes });
      const state = initialWorkflowLifecycleState(lifecycleManifest(definition), input, definition.digest, policy, maxCostMicros);
      const id = digest('mayura:workflow-lifecycle-run-id:v1', { scope: scopeKey, submissionKey: command.idempotencyKey });
      const created = await storageCall(() => store.create({ scope: scopeKey, id, idempotencyKey: `lifecycle:${command.idempotencyKey}`,
        definitionHash: definition.digest, state: jsonValue(state) as JsonObject, events: [{ type: 'lifecycle.run.created', data: {} }] }));
      verifyDefinition(definition, created.record, stateFrom(created.record)); return publicSnapshot(created.record);
    },
    inspect: async id => publicSnapshot(await load(id)),
    humanRequest: async (definition, id, nodeId) => {
      ensureOpen(); assertWorkflowLifecycle(definition);
      if (!nodePattern.test(nodeId)) throw new MayuraError('INVALID_INPUT', 'A lifecycle human node ID is required.');
      const record = await load(id); const state = stateFrom(record); verifyDefinition(definition, record, state);
      const node = definition.nodes.find(candidate => candidate.id === nodeId);
      const step = state.steps[nodeId];
      if (!node || node.kind !== 'human' || !step || step.kind !== 'human') throw new MayuraError('NOT_FOUND', 'Lifecycle human request was not found.');
      if (step.status === 'pending' || step.status === 'skipped') return undefined;
      let context: JsonValue | null = null; let subjectDigest: string | null = null; let deadlineAtMs: number | null = null;
      try {
        if (node.request.context) context = resolveBinding(node.request.context, state.input, outputs(state));
        if (node.request.subjectDigest) subjectDigest = exactDigest(resolveBinding(node.request.subjectDigest, state.input, outputs(state)));
        if (node.request.deadlineAtMs) deadlineAtMs = exactTimestamp(resolveBinding(node.request.deadlineAtMs, state.input, outputs(state)));
      } catch { throw new MayuraError('CONFLICT', 'Persisted human request bindings no longer resolve.'); }
      const requestDigest = digest('mayura:human-request:v1', { format: 1, runId: id, nodeId,
        definitionHash: definition.digest, kind: node.request.kind, schemaId: node.request.schemaId,
        schemaDigest: node.request.schemaDigest, prompt: node.request.prompt, context, subjectDigest, deadlineAtMs });
      if (step.requestDigest !== requestDigest || step.deadlineAtMs !== deadlineAtMs) throw new MayuraError('CONFLICT', 'Persisted human request evidence does not match its definition.');
      return freezeJson(jsonValue({ runId: id, nodeId, status: step.status, kind: node.request.kind,
        schemaId: node.request.schemaId, schemaDigest: node.request.schemaDigest, prompt: node.request.prompt,
        digest: requestDigest, context, subjectDigest, deadlineAtMs })) as unknown as WorkflowLifecycleHumanRequest;
    },
    events: (id, after = 0) => { ensureOpen(); return storageCall(() => store.events(scopeKey, id, after)); },
    runUntilSettled: async (definition, id) => {
      ensureOpen(); assertWorkflowLifecycle(definition);
      for (let wave = 0; wave <= definition.nodes.length + 2; wave++) {
        const before = await load(id); const state = stateFrom(before); verifyDefinition(definition, before, state);
        if (state.status === 'paused' || finalRunStatuses.has(state.status)) return publicSnapshot(before);
        await Promise.all(definition.nodes.map(node => executeNode(id, definition, node)));
        let after = await load(id); const next = stateFrom(after); verifyDefinition(definition, after, next);
        const steps = Object.values(next.steps);
        if (!schedulable(next)) return publicSnapshot(after);
        if (steps.every(step => terminalStepStatuses.has(step.status))) {
          if (steps.every(step => step.status === 'succeeded')) {
            try { next.output = jsonValue(await controlled(() => validate(definition.output,
              resolveBinding(definition.result, next.input, outputs(next)), 'output')), { maxBytes: maxOutputBytes }); next.status = 'succeeded'; }
            catch { next.status = 'failed'; }
          } else next.status = steps.some(step => step.status === 'unknown') ? 'outcome_unknown'
            : steps.some(step => step.status === 'blocked') ? 'blocked' : 'failed';
          try { after = await save(after, next, 'lifecycle.run.completed', { status: next.status }); }
          catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; after = await load(id); }
          return publicSnapshot(after);
        }
        if (after.version === before.version) {
          const waiting = steps.some(step => step.status === 'waiting');
          if (waiting && next.status !== 'waiting') {
            next.status = 'waiting';
            try { after = await save(after, next, 'lifecycle.run.waiting'); }
            catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; after = await load(id); }
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
        if (!step || step.kind !== 'tool' || state.policy !== policy || !step.approval || step.approval.digest !== command.digest) {
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
    pause: async id => publicSnapshot(await mutate(id, state => {
      if (state.status === 'paused') return false;
      if (finalRunStatuses.has(state.status)) throw new MayuraError('CONFLICT', 'A terminal lifecycle workflow cannot be paused.');
      if (Object.values(state.steps).some(step => step.kind === 'tool' && step.status === 'dispatching')) {
        throw new MayuraError('CONFLICT', 'A lifecycle workflow with an in-flight effect cannot enter the quiescent paused state.');
      }
      state.status = 'paused'; return true;
    }, 'lifecycle.run.paused')),
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
  });
}
