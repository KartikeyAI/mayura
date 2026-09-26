import { freezeJson, jsonValue, MayuraError, validate, type InferInput, type JsonObject, type JsonValue } from '@mayura/core';
import type { WorkflowDrainOptions, WorkflowDrainReport } from './drain.js';
import { StorageError, assertWorkflowSagaStateMatchesManifest, initialWorkflowSagaState, workflowSagaState,
  type StoredRecord, type WorkflowSagaState, type WorkflowSagaStatus, type WorkflowSagaStepState } from '@mayura/storage-contracts';
import { digest, resolveBinding } from './definition.js';
import { createWorkflowLifecycleRuntime, type WorkflowLifecycleRuntime,
  type WorkflowLifecycleRuntimeOptions, type WorkflowLifecycleSnapshot } from './lifecycle-runtime.js';
import { assertWorkflowSaga, sagaManifest, type AnyWorkflowSaga, type WorkflowSagaStep } from './saga-definition.js';

export interface WorkflowSagaRuntimeOptions extends WorkflowLifecycleRuntimeOptions {}

export interface WorkflowSagaSnapshot {
  readonly id: string;
  readonly version: number;
  readonly status: WorkflowSagaStatus;
  readonly cursor: number;
  readonly steps: Readonly<Record<string, Readonly<WorkflowSagaStepState>>>;
  readonly output: JsonValue;
  readonly budget: { readonly spentMicros: number; readonly maxCostMicros: number };
}

export interface WorkflowSagaRuntime {
  readonly profile: 'saga-v1';
  /** Child runtime used to inspect, approve, or answer the currently linked lifecycle run. */
  readonly lifecycle: WorkflowLifecycleRuntime;
  submit<D extends AnyWorkflowSaga>(definition: D, command: { readonly input: InferInput<D['input']>; readonly idempotencyKey: string }): Promise<WorkflowSagaSnapshot>;
  inspect(id: string): Promise<WorkflowSagaSnapshot>;
  events(id: string, after?: number): ReturnType<WorkflowSagaRuntimeOptions['store']['events']>;
  runUntilSettled(definition: AnyWorkflowSaga, id: string): Promise<WorkflowSagaSnapshot>;
  cancel(id: string): Promise<WorkflowSagaSnapshot>;
  close(): void;
  /** Let admitted child effects settle within the deadline, then close. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
}

const hashPattern = /^[a-f0-9]{64}$/;
const terminalSagaStatuses = new Set<WorkflowSagaStatus>(['succeeded', 'failed', 'compensated', 'compensation_failed', 'cancelled']);
const successfulChild = (snapshot: WorkflowLifecycleSnapshot): boolean => snapshot.status === 'succeeded';
const terminalChild = (snapshot: WorkflowLifecycleSnapshot): boolean =>
  ['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(snapshot.status);

async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof StorageError && error.code === 'CONFLICT') throw error;
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow saga storage is unavailable; inspect current state before retrying.');
  }
}

function decoded(record: StoredRecord): WorkflowSagaState {
  try { return workflowSagaState(record); }
  catch { throw new MayuraError('CONFLICT', 'Stored workflow saga state failed integrity validation.'); }
}

function snapshot(record: StoredRecord): WorkflowSagaSnapshot {
  const state = decoded(record);
  return freezeJson(jsonValue({ id: record.id, version: record.version, status: state.status, cursor: state.cursor,
    steps: state.steps, output: state.output, budget: { spentMicros: state.spentMicros,
      maxCostMicros: state.maxCostMicros } })) as unknown as WorkflowSagaSnapshot;
}

function outputs(state: WorkflowSagaState): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(state.steps).filter(([, step]) =>
    ['succeeded', 'compensation_waiting', 'compensated', 'compensation_failed'].includes(step.status))
    .map(([id, step]) => [id, step.output]));
}

function childKey(sagaRunId: string, stepId: string, phase: 'forward' | 'compensation'): string {
  return digest('mayura:workflow-saga-child:v1', { sagaRunId, stepId, phase });
}

/**
 * Durable saga coordinator built from format-5 lifecycle children.
 * The generic aggregate API cannot atomically write a child and its saga link; the
 * stable child key makes replay after that narrow crash window converge safely.
 */
export function createWorkflowSagaRuntime(options: WorkflowSagaRuntimeOptions): WorkflowSagaRuntime {
  const store = options.store;
  const scope = Object.freeze({ principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  if ([scope.principalId, scope.projectId, options.policyVersion].some(value =>
    typeof value !== 'string' || value.length < 1 || value.length > 128)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow saga scope and policy version are required.');
  }
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4_096
    || options.permissions.allow.some(grant => typeof grant !== 'string' || grant.length < 1 || grant.length > 256)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow saga permissions must be bounded explicit grants.');
  }
  if (!Number.isSafeInteger(options.maxCostMicros) || options.maxCostMicros < 0) {
    throw new MayuraError('INVALID_CONFIG', 'A bounded saga cost is required.');
  }
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 30_000;
  const maxPendingCallbacks = options.maxPendingCallbacks ?? 32;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || !Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 1) {
    throw new MayuraError('INVALID_CONFIG', 'Saga callback and output bounds must be positive integers.');
  }
  if (!Number.isSafeInteger(maxPendingCallbacks) || maxPendingCallbacks < 1 || maxPendingCallbacks > 128) {
    throw new MayuraError('INVALID_CONFIG', 'maxPendingCallbacks must be an integer from 1 through 128.');
  }
  const lifecycle = createWorkflowLifecycleRuntime(options);
  const scopeKey = digest('mayura:scope:v1', scope);
  const policy = digest('mayura:workflow-saga-policy:v1', { scope, permissions: [...options.permissions.allow].sort(),
    policyVersion: options.policyVersion, maxCostMicros: options.maxCostMicros, maxOutputBytes,
    approvalTtlMs: options.approvalTtlMs ?? 3_600_000 });
  let closed = false;
  const ensureOpen = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Workflow saga runtime is closed.'); };
  let pendingCallbacks = 0;
  const boundedValidate = async (schema: AnyWorkflowSaga['input'] | AnyWorkflowSaga['output'], value: unknown,
    boundary: 'input' | 'output'): Promise<JsonValue> => {
    if (pendingCallbacks >= maxPendingCallbacks) throw new MayuraError('LIMIT_EXCEEDED', 'Saga callback capacity is full.');
    pendingCallbacks += 1; let released = false;
    const release = (): void => { if (!released) { released = true; pendingCallbacks -= 1; } };
    const validation = Promise.resolve().then(() => validate(schema, value, boundary, { maxBytes: maxOutputBytes }));
    void validation.then(release, release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const checked = await Promise.race([validation,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new MayuraError('TIMEOUT', 'Saga schema validation timed out.')), callbackTimeoutMs); })]);
      return jsonValue(checked, { maxBytes: maxOutputBytes });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const load = async (id: string): Promise<StoredRecord> => {
    ensureOpen();
    if (typeof id !== 'string' || !hashPattern.test(id)) throw new MayuraError('INVALID_INPUT', 'A workflow saga run ID is required.');
    const record = await storageCall(() => store.read(scopeKey, id));
    if (!record) throw new MayuraError('NOT_FOUND', 'Workflow saga run was not found in this scope.');
    if (record.scope !== scopeKey || record.id !== id) throw new MayuraError('CONFLICT', 'Stored saga identity does not match its requested scope.');
    const state = decoded(record);
    if (state.policy !== policy) throw new MayuraError('CONFLICT', 'Stored saga policy does not match this runtime.');
    return record;
  };
  const verify = (definition: AnyWorkflowSaga, record: StoredRecord, state: WorkflowSagaState): void => {
    if (record.definitionHash !== definition.digest || state.definition !== definition.digest || state.policy !== policy) {
      throw new MayuraError('CONFLICT', 'Workflow saga definition or policy does not match persisted state.');
    }
    try { assertWorkflowSagaStateMatchesManifest(state, sagaManifest(definition)); }
    catch { throw new MayuraError('CONFLICT', 'Workflow saga state does not match its persisted definition.'); }
  };
  const save = (record: StoredRecord, state: WorkflowSagaState, type: string, data: JsonObject = {}): Promise<StoredRecord> =>
    storageCall(() => store.update({ scope: scopeKey, id: record.id, expectedVersion: record.version,
      state: jsonValue(state) as JsonObject, events: [{ type, data }] }));
  const mutate = async (id: string, transition: (state: WorkflowSagaState) => boolean, type: string,
    data: JsonObject = {}): Promise<StoredRecord> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const record = await load(id); const state = decoded(record);
      if (!transition(state)) return record;
      try { return await save(record, state, type, data); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
    }
    throw new MayuraError('CONFLICT', 'Workflow saga contention exceeded the bounded retry limit.');
  };
  const recordChild = (state: WorkflowSagaState, stepId: string, phase: 'forward' | 'compensation',
    child: WorkflowLifecycleSnapshot): void => {
    const step = state.steps[stepId]!;
    if (phase === 'forward') { step.forwardRunId = child.id; step.forwardSpentMicros = child.budget.spentMicros; }
    else { step.compensationRunId = child.id; step.compensationSpentMicros = child.budget.spentMicros; }
    state.spentMicros = Object.values(state.steps).reduce((sum, item) =>
      sum + item.forwardSpentMicros + item.compensationSpentMicros, 0);
    if (!Number.isSafeInteger(state.spentMicros) || state.spentMicros > state.maxCostMicros) {
      throw new MayuraError('LIMIT_EXCEEDED', 'Workflow saga exceeded its persisted cost ceiling.');
    }
  };
  const submitChild = async (runId: string, step: WorkflowSagaStep, phase: 'forward' | 'compensation',
    state: WorkflowSagaState): Promise<WorkflowLifecycleSnapshot> => {
    const workflow = phase === 'forward' ? step.forward : step.compensation!.workflow;
    const binding = phase === 'forward' ? step.input : step.compensation!.input;
    const input = resolveBinding(binding, state.input, outputs(state));
    return lifecycle.submit(workflow, { input, idempotencyKey: childKey(runId, step.id, phase) });
  };

  const run = async (definition: AnyWorkflowSaga, id: string): Promise<WorkflowSagaSnapshot> => {
    assertWorkflowSaga(definition);
    for (let wave = 0; wave < definition.steps.length * 2 + 4; wave++) {
      let record = await load(id); let state = decoded(record); verify(definition, record, state);
      if (terminalSagaStatuses.has(state.status)) return snapshot(record);
      if (state.status === 'running' || state.status === 'waiting') {
        const index = state.cursor; const step = definition.steps[index];
        if (!step) {
          let output: JsonValue;
          try { output = await boundedValidate(definition.output,
            resolveBinding(definition.result, state.input, outputs(state)), 'output'); }
          catch (error) {
            if (!(error instanceof MayuraError) || !['INVALID_INPUT', 'INVALID_OUTPUT'].includes(error.code)) throw error;
            state.status = 'compensating'; state.cursor = definition.steps.length;
            await save(record, state, 'saga.output.rejected'); continue;
          }
          state.output = output; state.status = 'succeeded';
          record = await save(record, state, 'saga.run.succeeded'); return snapshot(record);
        }
        const persisted = state.steps[step.id]!;
        let child: WorkflowLifecycleSnapshot;
        if (persisted.forwardRunId === null) {
          try { child = await submitChild(id, step, 'forward', state); }
          catch (error) {
            if (!(error instanceof MayuraError) || !['INVALID_INPUT', 'INVALID_OUTPUT'].includes(error.code)) throw error;
            await mutate(id, current => { const target = current.steps[step.id]!;
              if (target.status !== 'pending') return false;
              target.status = 'failed';
              for (let next = index + 1; next < definition.steps.length; next++) current.steps[definition.steps[next]!.id]!.status = 'skipped';
              current.status = 'compensating'; current.cursor = index; return true;
            }, 'saga.forward.rejected', { stepId: step.id });
            continue;
          }
          record = await mutate(id, current => { const target = current.steps[step.id]!;
            if (target.forwardRunId !== null) return false;
            recordChild(current, step.id, 'forward', child); target.status = 'forward_waiting';
            current.status = 'running'; return true;
          }, 'saga.forward.linked', { stepId: step.id, childRunId: child.id });
          state = decoded(record); child = await lifecycle.inspect(state.steps[step.id]!.forwardRunId!);
        } else child = await lifecycle.inspect(persisted.forwardRunId);
        child = await lifecycle.runUntilSettled(step.forward, child.id);
        if (!terminalChild(child)) {
          record = await mutate(id, current => { const target = current.steps[step.id]!;
            if (target.forwardRunId !== child.id || terminalSagaStatuses.has(current.status)) return false;
            recordChild(current, step.id, 'forward', child); target.status = 'forward_waiting';
            current.status = child.status === 'waiting' ? 'waiting' : 'running'; return true;
          }, 'saga.forward.waiting', { stepId: step.id, childRunId: child.id });
          return snapshot(record);
        }
        if (successfulChild(child)) {
          record = await mutate(id, current => { const target = current.steps[step.id]!;
            if (target.forwardRunId !== child.id || target.status === 'succeeded') return false;
            recordChild(current, step.id, 'forward', child); target.output = child.output; target.status = 'succeeded';
            current.cursor = index + 1; current.status = 'running'; return true;
          }, 'saga.forward.succeeded', { stepId: step.id, childRunId: child.id });
          continue;
        }
        record = await mutate(id, current => { const target = current.steps[step.id]!;
          if (target.forwardRunId !== child.id || target.status === 'failed') return false;
          recordChild(current, step.id, 'forward', child); target.status = 'failed';
          for (let next = index + 1; next < definition.steps.length; next++) current.steps[definition.steps[next]!.id]!.status = 'skipped';
          current.cursor = index; current.status = 'compensating'; return true;
        }, 'saga.forward.failed', { stepId: step.id, childRunId: child.id, childStatus: child.status });
        continue;
      }

      if (state.status === 'compensating') {
        let index = state.cursor - 1;
        while (index >= 0) {
          const candidate = definition.steps[index]!; const persisted = state.steps[candidate.id]!;
          if (persisted.status === 'succeeded' && candidate.compensation) break;
          index -= 1;
        }
        if (index < 0) {
          const compensated = Object.values(state.steps).some(step => step.status === 'compensated');
          state.status = compensated ? 'compensated' : 'failed'; state.cursor = 0;
          record = await save(record, state, compensated ? 'saga.run.compensated' : 'saga.run.failed');
          return snapshot(record);
        }
        const step = definition.steps[index]!; const persisted = state.steps[step.id]!;
        let child: WorkflowLifecycleSnapshot;
        if (persisted.compensationRunId === null) {
          try { child = await submitChild(id, step, 'compensation', state); }
          catch (error) {
            if (!(error instanceof MayuraError) || !['INVALID_INPUT', 'INVALID_OUTPUT'].includes(error.code)) throw error;
            record = await mutate(id, current => { const target = current.steps[step.id]!;
              if (target.status !== 'succeeded') return false;
              target.status = 'compensation_failed'; current.status = 'compensation_failed'; current.cursor = index; return true;
            }, 'saga.compensation.rejected', { stepId: step.id });
            return snapshot(record);
          }
          record = await mutate(id, current => { const target = current.steps[step.id]!;
            if (target.compensationRunId !== null) return false;
            recordChild(current, step.id, 'compensation', child); target.status = 'compensation_waiting';
            current.status = 'compensating'; current.cursor = index + 1; return true;
          }, 'saga.compensation.linked', { stepId: step.id, childRunId: child.id });
          state = decoded(record); child = await lifecycle.inspect(state.steps[step.id]!.compensationRunId!);
        } else child = await lifecycle.inspect(persisted.compensationRunId);
        child = await lifecycle.runUntilSettled(step.compensation!.workflow, child.id);
        if (!terminalChild(child)) {
          record = await mutate(id, current => { const target = current.steps[step.id]!;
            if (target.compensationRunId !== child.id || terminalSagaStatuses.has(current.status)) return false;
            recordChild(current, step.id, 'compensation', child); target.status = 'compensation_waiting';
            current.status = 'compensating'; current.cursor = index + 1; return true;
          }, 'saga.compensation.waiting', { stepId: step.id, childRunId: child.id });
          return snapshot(record);
        }
        if (successfulChild(child)) {
          await mutate(id, current => { const target = current.steps[step.id]!;
            if (target.compensationRunId !== child.id || target.status === 'compensated') return false;
            recordChild(current, step.id, 'compensation', child); target.status = 'compensated';
            current.status = 'compensating'; current.cursor = index; return true;
          }, 'saga.compensation.succeeded', { stepId: step.id, childRunId: child.id });
          continue;
        }
        record = await mutate(id, current => { const target = current.steps[step.id]!;
          if (target.compensationRunId !== child.id || target.status === 'compensation_failed') return false;
          recordChild(current, step.id, 'compensation', child); target.status = 'compensation_failed';
          current.status = 'compensation_failed'; current.cursor = index; return true;
        }, 'saga.compensation.failed', { stepId: step.id, childRunId: child.id, childStatus: child.status });
        return snapshot(record);
      }
    }
    return snapshot(await load(id));
  };

  return Object.freeze<WorkflowSagaRuntime>({
    profile: 'saga-v1', lifecycle,
    submit: async (definition, command) => {
      ensureOpen(); assertWorkflowSaga(definition);
      if (definition.maxCostMicros > options.maxCostMicros) throw new MayuraError('LIMIT_EXCEEDED', 'Saga static cost exceeds its runtime ceiling.');
      if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 128) {
        throw new MayuraError('INVALID_INPUT', 'A bounded saga submission key is required.');
      }
      const raw = freezeJson(jsonValue(command.input, { maxBytes: maxOutputBytes }));
      const input = await boundedValidate(definition.input, raw, 'input');
      const state = initialWorkflowSagaState(sagaManifest(definition), input, definition.digest, policy, options.maxCostMicros);
      const id = digest('mayura:workflow-saga-run-id:v1', { scope: scopeKey, submissionKey: command.idempotencyKey });
      const created = await storageCall(() => store.create({ scope: scopeKey, id,
        idempotencyKey: `saga:${command.idempotencyKey}`, definitionHash: definition.digest,
        state: jsonValue(state) as JsonObject, events: [{ type: 'saga.run.created', data: {} }] }));
      verify(definition, created.record, decoded(created.record)); return snapshot(created.record);
    },
    inspect: async id => snapshot(await load(id)),
    events: (id, after = 0) => { ensureOpen(); return storageCall(() => store.events(scopeKey, id, after)); },
    runUntilSettled: run,
    cancel: async id => {
      let record = await load(id); const state = decoded(record);
      if (terminalSagaStatuses.has(state.status)) return snapshot(record);
      const activeEntry = Object.entries(state.steps).find(([, step]) => step.status === 'forward_waiting' || step.status === 'compensation_waiting');
      const active = activeEntry?.[1]; const activeStepId = activeEntry?.[0];
      const childRunId = active?.status === 'forward_waiting' ? active.forwardRunId : active?.compensationRunId;
      const child = childRunId ? await lifecycle.cancel(childRunId) : undefined;
      record = await mutate(id, current => {
        if (terminalSagaStatuses.has(current.status)) return false;
        if (child && active && activeStepId) {
          const phase = active.status === 'forward_waiting' ? 'forward' : 'compensation';
          const target = current.steps[activeStepId];
          const linked = phase === 'forward' ? target?.forwardRunId : target?.compensationRunId;
          if (linked === child.id) recordChild(current, activeStepId, phase, child);
        }
        current.status = 'cancelled'; return true;
      }, 'saga.run.cancelled');
      return snapshot(record);
    },
    close: () => { if (!closed) { closed = true; lifecycle.close(); } },
    drain: async options => { const report = await lifecycle.drain(options); closed = true; return report; },
  });
}
