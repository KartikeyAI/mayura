import { freezeJson, jsonValue, MayuraError, validate, type InferInput, type JsonObject, type JsonValue } from '@mayura/core';
import type { WorkflowDrainOptions, WorkflowDrainReport } from './drain.js';
import { StorageError, assertWorkflowLoopStateMatchesManifest, initialWorkflowLoopState, workflowLoopState,
  type StoredRecord, type WorkflowLoopBinding, type WorkflowLoopState, type WorkflowLoopStatus } from '@mayura/storage-contracts';
import { digest, resolveBinding } from './definition.js';
import { createWorkflowLifecycleRuntime, type WorkflowLifecycleRuntime, type WorkflowLifecycleRuntimeOptions,
  type WorkflowLifecycleSnapshot } from './lifecycle-runtime.js';
import { assertWorkflowLoop, loopManifest, type AnyWorkflowLoop } from './loop-definition.js';

export interface WorkflowLoopRuntimeOptions extends WorkflowLifecycleRuntimeOptions {}
export interface WorkflowLoopSnapshot {
  readonly id: string; readonly version: number; readonly status: WorkflowLoopStatus; readonly iteration: number;
  readonly childRunId: string | null; readonly current: JsonValue; readonly output: JsonValue;
  readonly budget: { readonly spentMicros: number; readonly maxCostMicros: number };
}
export interface WorkflowLoopRuntime {
  readonly profile: 'loop-v1'; readonly lifecycle: WorkflowLifecycleRuntime;
  submit<D extends AnyWorkflowLoop>(definition: D, command: { readonly input: InferInput<D['input']>; readonly idempotencyKey: string }): Promise<WorkflowLoopSnapshot>;
  inspect(id: string): Promise<WorkflowLoopSnapshot>;
  events(id: string, after?: number): ReturnType<WorkflowLoopRuntimeOptions['store']['events']>;
  runUntilSettled(definition: AnyWorkflowLoop, id: string): Promise<WorkflowLoopSnapshot>;
  cancel(id: string): Promise<WorkflowLoopSnapshot>; close(): void;
  /** Let admitted iteration effects settle within the deadline, then close. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
}

const hashPattern = /^[a-f0-9]{64}$/;
const terminal = new Set<WorkflowLoopStatus>(['succeeded', 'failed', 'limit_exceeded', 'cancelled']);
const childTerminal = (value: WorkflowLifecycleSnapshot): boolean =>
  ['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(value.status);

function decoded(record: StoredRecord): WorkflowLoopState {
  try { return workflowLoopState(record); }
  catch { throw new MayuraError('CONFLICT', 'Stored workflow loop state failed integrity validation.'); }
}
function view(record: StoredRecord): WorkflowLoopSnapshot {
  const state = decoded(record);
  return freezeJson(jsonValue({ id: record.id, version: record.version, status: state.status,
    iteration: state.iteration, childRunId: state.childRunId, current: state.current, output: state.output,
    budget: { spentMicros: state.spentMicros, maxCostMicros: state.maxCostMicros } })) as unknown as WorkflowLoopSnapshot;
}
function loopValue(binding: WorkflowLoopBinding, input: JsonValue, current: JsonValue): JsonValue {
  if (binding.kind === 'literal') return jsonValue(binding.value);
  let value = binding.kind === 'input' ? input : current;
  for (const segment of binding.path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
      throw new MayuraError('INVALID_INPUT', 'Workflow loop binding cannot resolve its path.');
    }
    value = (value as JsonObject)[segment]!;
  }
  return jsonValue(value);
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof StorageError && error.code === 'CONFLICT') throw error;
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow loop storage is unavailable; inspect current state before retrying.');
  }
}

/** Drive an explicitly bounded loop one lifecycle child at a time. */
export function createWorkflowLoopRuntime(options: WorkflowLoopRuntimeOptions): WorkflowLoopRuntime {
  const store = options.store; const scope = Object.freeze({ principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  if ([scope.principalId, scope.projectId, options.policyVersion].some(value => typeof value !== 'string' || value.length < 1 || value.length > 128)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow loop scope and policy version are required.');
  }
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4_096
    || options.permissions.allow.some(value => typeof value !== 'string' || value.length < 1 || value.length > 256)) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow loop permissions must be bounded explicit grants.');
  }
  if (!Number.isSafeInteger(options.maxCostMicros) || options.maxCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'A bounded loop cost is required.');
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576; const callbackTimeoutMs = options.callbackTimeoutMs ?? 30_000;
  const maxPendingCallbacks = options.maxPendingCallbacks ?? 32;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || !Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 1
    || !Number.isSafeInteger(maxPendingCallbacks) || maxPendingCallbacks < 1 || maxPendingCallbacks > 128) {
    throw new MayuraError('INVALID_CONFIG', 'Workflow loop callback limits are invalid.');
  }
  const lifecycle = createWorkflowLifecycleRuntime(options); const scopeKey = digest('mayura:scope:v1', scope);
  const policy = digest('mayura:workflow-loop-policy:v1', { scope, permissions: [...options.permissions.allow].sort(),
    policyVersion: options.policyVersion, maxCostMicros: options.maxCostMicros, maxOutputBytes,
    approvalTtlMs: options.approvalTtlMs ?? 3_600_000 });
  let closed = false; let pendingCallbacks = 0;
  const ensureOpen = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Workflow loop runtime is closed.'); };
  const checked = async (schema: AnyWorkflowLoop['input'] | AnyWorkflowLoop['output'], candidate: unknown,
    boundary: 'input' | 'output'): Promise<JsonValue> => {
    if (pendingCallbacks >= maxPendingCallbacks) throw new MayuraError('LIMIT_EXCEEDED', 'Loop callback capacity is full.');
    pendingCallbacks += 1; let released = false; const release = (): void => { if (!released) { released = true; pendingCallbacks -= 1; } };
    const operation = Promise.resolve().then(() => validate(schema, candidate, boundary, { maxBytes: maxOutputBytes }));
    void operation.then(release, release); let timer: ReturnType<typeof setTimeout> | undefined;
    try { return jsonValue(await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MayuraError('TIMEOUT', 'Loop schema validation timed out.')), callbackTimeoutMs);
    })]), { maxBytes: maxOutputBytes }); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const load = async (id: string): Promise<StoredRecord> => {
    ensureOpen(); if (typeof id !== 'string' || !hashPattern.test(id)) throw new MayuraError('INVALID_INPUT', 'A workflow loop run ID is required.');
    const record = await storage(() => store.read(scopeKey, id)); if (!record) throw new MayuraError('NOT_FOUND', 'Workflow loop run was not found in this scope.');
    if (record.scope !== scopeKey || record.id !== id) throw new MayuraError('CONFLICT', 'Stored loop identity does not match its requested scope.');
    if (decoded(record).policy !== policy) throw new MayuraError('CONFLICT', 'Stored loop policy does not match this runtime.'); return record;
  };
  const verify = (definition: AnyWorkflowLoop, record: StoredRecord, state: WorkflowLoopState): void => {
    if (record.definitionHash !== definition.digest || state.definition !== definition.digest) throw new MayuraError('CONFLICT', 'Workflow loop definition does not match persisted state.');
    try { assertWorkflowLoopStateMatchesManifest(state, loopManifest(definition)); }
    catch { throw new MayuraError('CONFLICT', 'Workflow loop state does not match its persisted definition.'); }
  };
  const save = (record: StoredRecord, state: WorkflowLoopState, type: string, data: JsonObject = {}) =>
    storage(() => store.update({ scope: scopeKey, id: record.id, expectedVersion: record.version,
      state: jsonValue(state) as JsonObject, events: [{ type, data }] }));
  const mutate = async (id: string, transition: (state: WorkflowLoopState) => boolean, type: string, data: JsonObject = {}) => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const record = await load(id); const state = decoded(record); if (!transition(state)) return record;
      try { return await save(record, state, type, data); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
    }
    throw new MayuraError('CONFLICT', 'Workflow loop contention exceeded the bounded retry limit.');
  };
  const account = (state: WorkflowLoopState, child: WorkflowLifecycleSnapshot, complete: boolean): void => {
    state.spentMicros = state.spentMicros - state.activeSpentMicros + child.budget.spentMicros;
    state.activeSpentMicros = complete ? 0 : child.budget.spentMicros;
    if (!Number.isSafeInteger(state.spentMicros) || state.spentMicros > state.maxCostMicros) throw new MayuraError('LIMIT_EXCEEDED', 'Workflow loop exceeded its persisted cost ceiling.');
  };

  const run = async (definition: AnyWorkflowLoop, id: string): Promise<WorkflowLoopSnapshot> => {
    assertWorkflowLoop(definition);
    for (let wave = 0; wave < definition.maxIterations * 2 + 4; wave++) {
      let record = await load(id); let state = decoded(record); verify(definition, record, state);
      if (terminal.has(state.status)) return view(record);
      if (state.childRunId === null && state.iteration > 0) {
        let again: boolean;
        try { const condition = loopValue(definition.continueWhen, state.input, state.current);
          if (typeof condition !== 'boolean') throw new MayuraError('INVALID_OUTPUT', 'Loop continuation must resolve to a boolean.'); again = condition; }
        catch { state.status = 'failed'; record = await save(record, state, 'loop.condition.rejected'); return view(record); }
        if (!again) {
          try { state.output = await checked(definition.output, loopValue(definition.result, state.input, state.current), 'output'); state.status = 'succeeded'; }
          catch (error) {
            if (!(error instanceof MayuraError) || !['INVALID_INPUT', 'INVALID_OUTPUT'].includes(error.code)) throw error;
            state.status = 'failed';
          }
          record = await save(record, state, state.status === 'succeeded' ? 'loop.run.succeeded' : 'loop.output.rejected'); return view(record);
        }
        if (state.iteration >= state.maxIterations) { state.status = 'limit_exceeded'; record = await save(record, state, 'loop.limit.exceeded'); return view(record); }
      }
      if (state.childRunId === null) {
        let input: JsonValue;
        try { input = state.iteration === 0 ? resolveBinding(definition.initial, state.input, {})
          : loopValue(definition.next, state.input, state.current); }
        catch { state.status = 'failed'; record = await save(record, state, 'loop.input.rejected'); return view(record); }
        let child: WorkflowLifecycleSnapshot;
        try { child = await lifecycle.submit(definition.body, { input,
          idempotencyKey: digest('mayura:workflow-loop-child:v1', { loopRunId: id, iteration: state.iteration }) }); }
        catch (error) {
          if (!(error instanceof MayuraError) || !['INVALID_INPUT', 'INVALID_OUTPUT'].includes(error.code)) throw error;
          state.status = 'failed'; record = await save(record, state, 'loop.child.rejected'); return view(record);
        }
        record = await mutate(id, current => { if (current.childRunId !== null || current.iteration !== state.iteration) return false;
          current.childRunId = child.id; current.status = 'running'; return true;
        }, 'loop.child.linked', { iteration: state.iteration, childRunId: child.id });
        state = decoded(record);
      }
      const childId = state.childRunId!; let child = await lifecycle.inspect(childId);
      child = await lifecycle.runUntilSettled(definition.body, child.id);
      if (!childTerminal(child)) {
        record = await mutate(id, current => { if (current.childRunId !== child.id || terminal.has(current.status)) return false;
          account(current, child, false); current.status = child.status === 'waiting' ? 'waiting' : 'running'; return true;
        }, 'loop.child.waiting', { iteration: state.iteration, childRunId: child.id });
        return view(record);
      }
      if (child.status !== 'succeeded') {
        record = await mutate(id, current => { if (current.childRunId !== child.id || terminal.has(current.status)) return false;
          account(current, child, false); current.status = 'failed'; return true;
        }, 'loop.child.failed', { iteration: state.iteration, childRunId: child.id, childStatus: child.status });
        return view(record);
      }
      await mutate(id, current => { if (current.childRunId !== child.id) return false;
        account(current, child, true); current.current = child.output; current.iteration += 1;
        current.childRunId = null; current.status = 'running'; return true;
      }, 'loop.iteration.succeeded', { iteration: state.iteration, childRunId: child.id });
    }
    return view(await load(id));
  };

  return Object.freeze<WorkflowLoopRuntime>({ profile: 'loop-v1', lifecycle,
    submit: async (definition, command) => {
      ensureOpen(); assertWorkflowLoop(definition);
      if (definition.maxCostMicros > options.maxCostMicros) throw new MayuraError('LIMIT_EXCEEDED', 'Loop static cost exceeds its runtime ceiling.');
      if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 128) throw new MayuraError('INVALID_INPUT', 'A bounded loop submission key is required.');
      const input = await checked(definition.input, freezeJson(jsonValue(command.input, { maxBytes: maxOutputBytes })), 'input');
      const state = initialWorkflowLoopState(loopManifest(definition), input, definition.digest, policy, options.maxCostMicros);
      const id = digest('mayura:workflow-loop-run-id:v1', { scope: scopeKey, submissionKey: command.idempotencyKey });
      const created = await storage(() => store.create({ scope: scopeKey, id, idempotencyKey: `loop:${command.idempotencyKey}`,
        definitionHash: definition.digest, state: jsonValue(state) as JsonObject, events: [{ type: 'loop.run.created', data: {} }] }));
      verify(definition, created.record, decoded(created.record)); return view(created.record);
    },
    inspect: async id => view(await load(id)),
    events: (id, after = 0) => { ensureOpen(); return storage(() => store.events(scopeKey, id, after)); },
    runUntilSettled: run,
    cancel: async id => { let record = await load(id); const state = decoded(record); if (terminal.has(state.status)) return view(record);
      const child = state.childRunId ? await lifecycle.cancel(state.childRunId) : undefined;
      record = await mutate(id, current => { if (terminal.has(current.status)) return false;
        if (child && current.childRunId === child.id) account(current, child, false);
        current.status = 'cancelled'; return true;
      }, 'loop.run.cancelled'); return view(record); },
    close: () => { if (!closed) { closed = true; lifecycle.close(); } },
    drain: async options => { const report = await lifecycle.drain(options); closed = true; return report; },
  });
}
