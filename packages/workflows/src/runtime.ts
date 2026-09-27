import { Budget, MayuraError, assertPositiveInteger, freezeJson, jsonValue, validate, type ExecutionReceipt, type JsonObject, type JsonValue, type Permissions, type Scope } from '@mayura/core';
import { invokeTool } from '@mayura/tools';
import { createWorkflowDrainGate, type WorkflowDrainOptions, type WorkflowDrainReport } from './drain.js';
import { StorageError, assertWorkflowStateMatchesManifest, workflowState, workflowOutputs, mergeWorkflowReceipt,
  type WorkflowFormat2State as State, type WorkflowFormat2Step as Step, type WorkflowFormat2StepStatus as StepStatus,
  type WorkflowFormat2Status as Status, type AggregateStore, type StoredRecord } from '@mayura/storage-contracts';
import { assertWorkflow, digest, resolveBinding, type AnyWorkflow, type WorkflowNode } from './definition.js';
import { assertMigrationAllowed, assertWorkflowMigration, migrationCommand, migrationEvent, nodeFingerprint, planWorkflowMigration,
  type MigrationBlocker, type MigrationCommand, type WorkflowMigration, type WorkflowMigrationResult } from './migration.js';
import { scheduledManifest } from './scheduled-helpers.js';

export interface WorkflowSnapshot {
  readonly id: string; readonly version: number; readonly status: Status;
  readonly steps: Readonly<Record<string, Readonly<Step>>>;
  readonly output: JsonValue;
  readonly budget: { readonly spentMicros: number; readonly reservedMicros: number; readonly maxCostMicros: number };
}
export interface VerifiedHuman { readonly id: string; readonly projectId: string; readonly canApprove: boolean }
export interface WorkflowRuntimeOptions {
  readonly store: AggregateStore; readonly scope: Scope; readonly permissions: Permissions;
  readonly policyVersion: string; readonly maxCostMicros: number;
  readonly approvalTtlMs?: number; readonly maxOutputBytes?: number;
  /** Trusted identity boundary. Credentials are opaque to the workflow and never persisted. */
  readonly verifyHuman?: (credential: unknown) => Promise<VerifiedHuman>;
}
const terminalSteps = new Set<StepStatus>(['succeeded', 'failed', 'blocked', 'unknown', 'skipped']);

/** Bounds trusted async callbacks; it cannot terminate synchronous JavaScript or undo effects. */
async function bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MayuraError('TIMEOUT', 'Workflow validation or control operation timed out.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function stateFrom(record: StoredRecord): State {
  try { return workflowState(record); }
  catch { throw new MayuraError('CONFLICT', 'Stored workflow state failed integrity validation.'); }
}

/** External storage diagnostics never cross the workflow's public error boundary. */
async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    let conflict = false;
    try {
      if (error instanceof StorageError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
        conflict = !!descriptor && 'value' in descriptor && descriptor.value === 'CONFLICT';
      }
    } catch { /* Untrusted exception accessors/proxies do not become error messages. */ }
    if (conflict) throw new StorageError('CONFLICT', 'Workflow storage version changed.');
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow storage is unavailable; reconcile uncertain actions before retrying.');
  }
}
function snapshot(record: StoredRecord): WorkflowSnapshot {
  const state = stateFrom(record);
  return freezeJson(jsonValue({ id: record.id, version: record.version, status: state.status, steps: state.steps, output: state.output, budget: { spentMicros: state.spentMicros, reservedMicros: state.reservedMicros, maxCostMicros: state.maxCostMicros } })) as unknown as WorkflowSnapshot;
}

/** Known evidence is monotonic; stale cancellation snapshots cannot turn success back into unknown. */
function mergeReceipt(previous: ExecutionReceipt | null, incoming: ExecutionReceipt): ExecutionReceipt {
  try { return mergeWorkflowReceipt(previous, incoming); }
  catch { throw new MayuraError('CONFLICT', 'Conflicting known execution evidence requires reconciliation.'); }
}
function outputs(state: State): Record<string, JsonValue> {
  try { return workflowOutputs(state); }
  catch { throw new MayuraError('CONFLICT', 'Stored workflow output failed integrity validation.'); }
}
function initialState(definition: AnyWorkflow, input: JsonValue, policy: string, maxCostMicros: number): State {
  return { format: 2, definition: definition.digest, policy, input, status: 'running', maxCostMicros, spentMicros: 0, reservedMicros: 0, output: null,
    steps: Object.fromEntries(definition.nodes.map(node => [node.id, { kind: node.kind, status: 'pending', callId: `step:${node.id}`, output: null, receipt: null, approval: null, costReserved: 0, candidateHash: null }])) };
}

/** Conservative durable DAG driver. No automatic replay/reclaim of dispatched effects. */
export function createWorkflowRuntime(options: WorkflowRuntimeOptions) {
  const { store } = options;
  const scope = Object.freeze({ principalId: options.scope.principalId, projectId: options.scope.projectId });
  if ([scope.principalId, scope.projectId, options.policyVersion].some(value => typeof value !== 'string' || !value.length || value.length > 128)) throw new MayuraError('INVALID_CONFIG', 'Workflow scope and policy version are required.');
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4096 || options.permissions.allow.some(grant => typeof grant !== 'string' || !grant.length || grant.length > 256)) throw new MayuraError('INVALID_CONFIG', 'Workflow permissions must be bounded explicit grants.');
  const permissions = Object.freeze({ allow: Object.freeze([...options.permissions.allow]) });
  const maxCostMicros = options.maxCostMicros;
  if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'A bounded workflow cost is required.');
  const approvalTtlMs = options.approvalTtlMs ?? 3_600_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  assertPositiveInteger(approvalTtlMs, 'approvalTtlMs'); assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');
  const verifyHuman = options.verifyHuman;
  const scopeKey = digest('mayura:scope:v1', scope);
  const policy = digest('mayura:policy:v1', { scope, permissions: [...permissions.allow].sort(), policyVersion: options.policyVersion, maxCostMicros, maxOutputBytes, approvalTtlMs });
  const active = new Map<string, AbortController>();
  let closed = false; const gate = createWorkflowDrainGate();
  const ensureOpen = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Workflow runtime is closed.'); };
  const load = async (id: string, allowClosed = false): Promise<StoredRecord> => {
    if (!allowClosed) ensureOpen();
    const record = await storageCall(() => store.read(scopeKey, id));
    if (!record) throw new MayuraError('NOT_FOUND', 'Workflow run was not found in this scope.');
    if (record.id !== id || record.scope !== scopeKey) throw new MayuraError('CONFLICT', 'Stored workflow identity does not match the requested scope.');
    stateFrom(record);
    return record;
  };
  const save = async (record: StoredRecord, state: State, type: string, data: JsonObject = {}): Promise<StoredRecord> =>
    storageCall(() => store.update({ scope: scopeKey, id: record.id, expectedVersion: record.version, state: jsonValue(state) as JsonObject, events: [{ type, data }] }));
  const mutate = async (id: string, update: (state: State) => boolean, type: string, data: JsonObject = {}, allowClosed = false): Promise<StoredRecord> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const record = await load(id, allowClosed); const state = stateFrom(record);
      if (!update(state)) return record;
      try { return await save(record, state, type, data); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
    }
    throw new MayuraError('CONFLICT', 'Workflow contention exceeded the bounded retry limit.');
  };
  const candidate = (node: Extract<WorkflowNode, {kind:'tool'}>, input: JsonValue, runId: string, expiresAt: number | null): string =>
    digest('mayura:approval:v1', { runId, nodeId: node.id, tool: node.tool.id, toolVersion: node.tool.version, input, policy, expiresAt });

  async function executeNode(id: string, node: WorkflowNode, claimRetries = 0): Promise<void> {
    const record = await load(id); const state = stateFrom(record); const step = state.steps[node.id];
    if (!step || state.policy !== policy || ['paused', 'cancelled'].includes(state.status) || !['pending', 'approved'].includes(step.status)) return;
    const dependencies = (node.dependsOn ?? []).map(key => state.steps[key]!);
    if (dependencies.some(item => terminalSteps.has(item.status) && item.status !== 'succeeded')) {
      await mutate(id, current => { const next = current.steps[node.id]!; if (!['pending','approved'].includes(next.status)) return false; next.status = 'skipped'; return true; }, 'step.skipped', { nodeId: node.id }); return;
    }
    if (dependencies.some(item => item.status !== 'succeeded')) return;
    if (node.kind === 'join') {
      step.output = dependencies.map(item => item.output); step.status = 'succeeded';
      try { await save(record, state, 'step.completed', { nodeId: node.id }); } catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    const required = [`tool:${node.tool.id}`, ...node.tool.capabilities, ...(node.tool.effects === 'none' ? [] : [`effect:${node.tool.effects}`])];
    if (required.some(grant => !permissions.allow.includes(grant))) {
      step.status = 'blocked';
      try { await save(record, state, 'step.blocked', { nodeId: node.id, code: 'PERMISSION_DENIED' }); } catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    let input: JsonValue;
    try { input = jsonValue(await bounded(() => validate(node.tool.input, resolveBinding(node.input, state.input, outputs(state)), 'input'), node.tool.timeoutMs), { maxBytes: maxOutputBytes }); }
    catch {
      step.status = 'failed';
      try { await save(record, state, 'step.failed', { nodeId: node.id, code: 'INVALID_INPUT' }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    const previousExpiry = step.approval?.expiresAt ?? 0;
    const reviewExpiry = node.approval ? (previousExpiry > Date.now() ? previousExpiry : Date.now() + approvalTtlMs) : null;
    const candidateHash = candidate(node, input, id, reviewExpiry);
    if (node.approval && (step.status !== 'approved' || step.approval?.digest !== candidateHash || step.approval.expiresAt <= Date.now())) {
      step.status = 'waiting'; step.approval = { digest: candidateHash, expiresAt: reviewExpiry!, humanId: null }; state.status = 'waiting';
      try { await save(record, state, 'approval.requested', { nodeId: node.id, digest: candidateHash }); } catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    if (node.tool.costMicros > state.maxCostMicros - state.spentMicros - state.reservedMicros) {
      step.status = 'blocked';
      try { await save(record, state, 'step.blocked', { nodeId: node.id, code: 'BUDGET_EXCEEDED' }); }
      catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; }
      return;
    }
    step.status = 'dispatching'; step.candidateHash = candidateHash; step.costReserved = node.tool.costMicros;
    state.reservedMicros += node.tool.costMicros; state.status = 'running';
    try { await save(record, state, 'step.dispatching', { nodeId: node.id, callId: step.callId }); }
    catch (error) {
      // Retry the losing claim immediately: waiting for this wave would serialize independent handlers.
      // Every retry reloads permissions/candidate/budget state before crossing the dispatch boundary.
      if (error instanceof StorageError && error.code === 'CONFLICT' && claimRetries < 32) return executeNode(id, node, claimRetries + 1);
      throw error;
    }
    const controller = new AbortController(); const activeKey = `${id}/${node.id}`; active.set(activeKey, controller);
    try {
      const result = await invokeTool(node.tool, resolveBinding(node.input, state.input, outputs(state)), {
        runId: id, callId: `${id}/${step.callId}`, scope, signal: controller.signal, permissions,
        budget: new Budget(node.tool.costMicros, 1), maxOutputBytes,
        beforeDispatch: async processed => {
          const current = stateFrom(await load(id));
          if (current.status !== 'running' || current.policy !== policy || current.steps[node.id]?.status !== 'dispatching' || candidate(node, processed, id, node.approval ? current.steps[node.id]!.approval!.expiresAt : null) !== candidateHash) {
            throw new MayuraError('CONFLICT', 'Workflow dispatch candidate is no longer authorized.');
          }
          if (node.approval && (current.steps[node.id]?.approval?.expiresAt ?? 0) <= Date.now()) throw new MayuraError('PERMISSION_DENIED', 'Approval expired before dispatch.');
        },
        onExecutionReceipt: async receipt => {
          await mutate(id, current => {
            const target = current.steps[node.id]!;
            // Retain late evidence but do not turn an operator-recovered unknown step back into success.
            target.receipt = mergeReceipt(target.receipt, receipt);
            if (receipt.execution !== 'unknown' && target.costReserved > 0) {
              current.reservedMicros -= target.costReserved;
              if (receipt.execution !== 'not_started') current.spentMicros += target.costReserved;
              target.costReserved = 0;
            }
            return true;
          }, 'effect.receipt', { nodeId: node.id, execution: receipt.execution }, true);
        },
      });
      await mutate(id, current => {
        const target = current.steps[node.id]!;
        if (target.status !== 'dispatching') return false;
        if (result.receipt) target.receipt = mergeReceipt(target.receipt, result.receipt);
        if (result.status === 'succeeded') { target.status = 'succeeded'; target.output = jsonValue(result.output, { maxBytes: maxOutputBytes }); }
        else target.status = result.status === 'outcome_unknown' ? 'unknown' : result.status === 'blocked' ? 'blocked' : 'failed';
        if (result.receipt?.execution === 'not_started' && target.costReserved > 0) { current.reservedMicros -= target.costReserved; target.costReserved = 0; }
        return true;
      }, 'step.completed', { nodeId: node.id, outcome: result.status });
    } finally { active.delete(activeKey); }
  }

  return {
    async submit<D extends AnyWorkflow>(definition: D, command: { input: unknown; idempotencyKey: string }): Promise<WorkflowSnapshot> {
      ensureOpen();
      assertWorkflow(definition);
      const idempotencyKey = command.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 128) throw new MayuraError('INVALID_INPUT', 'A bounded submission key is required.');
      const inputSnapshot = freezeJson(jsonValue(command.input, { maxBytes: maxOutputBytes }));
      const input = jsonValue(await bounded(() => validate(definition.input, inputSnapshot, 'input'), 30_000), { maxBytes: maxOutputBytes });
      const state = initialState(definition, input, policy, maxCostMicros);
      const id = digest('mayura:run-id:v1', { scope: scopeKey, submissionKey: idempotencyKey });
      const created = await storageCall(() => store.create({ scope: scopeKey, id, idempotencyKey, definitionHash: definition.digest, state: jsonValue(state) as JsonObject, events: [{ type: 'run.created', data: {} }] }));
      return snapshot(created.record);
    },
    inspect: async (id: string): Promise<WorkflowSnapshot> => snapshot(await load(id)),
    events: (id: string, after = 0) => { ensureOpen(); return storageCall(() => store.events(scopeKey, id, after)); },
    async runUntilSettled(definition: AnyWorkflow, id: string): Promise<WorkflowSnapshot> {
      ensureOpen(); if (gate.draining) throw new MayuraError('CANCELLED', 'Workflow runtime is draining.');
      assertWorkflow(definition);
      for (let wave = 0; wave <= definition.nodes.length + 1; wave++) {
        const before = await load(id); const state = stateFrom(before);
        if (state.definition !== definition.digest || before.definitionHash !== definition.digest || state.policy !== policy || state.maxCostMicros !== maxCostMicros) throw new MayuraError('CONFLICT', 'Definition or policy changed; explicit migration/review is required.');
        if (Object.keys(state.steps).length !== definition.nodes.length || definition.nodes.some(node => !Object.hasOwn(state.steps, node.id))) throw new MayuraError('CONFLICT', 'Stored steps do not match the pinned definition.');
        for (const node of definition.nodes) {
          const step = state.steps[node.id]!;
          if (step.kind !== node.kind || (node.kind === 'tool' && step.receipt && step.receipt.toolId !== node.tool.id) || (step.status === 'succeeded' && (node.dependsOn ?? []).some(dependency => state.steps[dependency]?.status !== 'succeeded'))) throw new MayuraError('CONFLICT', 'Stored step evidence does not match the pinned graph.');
        }
        if (state.status === 'paused' || state.status === 'cancelled' || ['succeeded','failed','blocked','outcome_unknown'].includes(state.status)) return snapshot(before);
        // Each wave holds one drain admission until its effects and receipts settle.
        const release = gate.enter(); if (!release) return snapshot(before);
        try { await Promise.all(definition.nodes.map(node => executeNode(id, node))); } finally { release(); }
        let after = await load(id); const next = stateFrom(after); const steps = Object.values(next.steps);
        if (next.status === 'paused' || next.status === 'cancelled') return snapshot(after);
        if (steps.every(item => terminalSteps.has(item.status))) {
          if (steps.every(item => item.status === 'succeeded')) {
            try { next.output = jsonValue(await bounded(() => validate(definition.output, resolveBinding(definition.result, next.input, outputs(next)), 'output'), 30_000), { maxBytes: maxOutputBytes }); next.status = 'succeeded'; }
            catch { next.status = 'failed'; }
          } else next.status = steps.some(item => item.status === 'unknown') ? 'outcome_unknown' : steps.some(item => item.status === 'blocked') ? 'blocked' : 'failed';
          try { after = await save(after, next, 'run.completed', { status: next.status }); }
          catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; after = await load(id); }
          return snapshot(after);
        }
        if (after.version === before.version) {
          if (steps.some(item => item.status === 'waiting') && !steps.some(item => item.status === 'dispatching') && next.status !== 'waiting') {
            next.status = 'waiting';
            try { after = await save(after, next, 'run.waiting'); } catch (error) { if (!(error instanceof StorageError) || error.code !== 'CONFLICT') throw error; after = await load(id); }
          }
          return snapshot(after);
        }
      }
      return snapshot(await load(id));
    },
    async approve(command: { id: string; nodeId: string; digest: string; credential: unknown }): Promise<WorkflowSnapshot> {
      ensureOpen();
      const { id, nodeId, digest: approvalDigest, credential } = command;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || typeof nodeId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(nodeId) || typeof approvalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(approvalDigest)) throw new MayuraError('INVALID_INPUT', 'Approval requires exact run, node and candidate identifiers.');
      if (!verifyHuman) throw new MayuraError('PERMISSION_DENIED', 'A trusted human identity verifier is required.');
      let human: VerifiedHuman;
      try {
        const verified = await bounded(() => verifyHuman(credential), 30_000);
        human = { id: verified.id, projectId: verified.projectId, canApprove: verified.canApprove };
        if (typeof human.id !== 'string' || !human.id.length || human.id.length > 256 || human.projectId !== scope.projectId || human.canApprove !== true) throw new Error();
      } catch { throw new MayuraError('PERMISSION_DENIED', 'Human identity verification failed.'); }
      return snapshot(await mutate(id, state => {
        const step = state.steps[nodeId];
        if (state.status === 'cancelled' || state.policy !== policy || !step || step.status !== 'waiting' || !step.approval || step.approval.digest !== approvalDigest || step.approval.expiresAt <= Date.now()) throw new MayuraError('CONFLICT', 'Approval request is stale, expired or mismatched.');
        step.approval.humanId = human.id; step.status = 'approved'; if (state.status !== 'paused') state.status = 'running'; return true;
      }, 'approval.resolved', { nodeId, humanId: human.id }));
    },
    /** Persist a quiescent operator pause. In-flight effects must settle or reconcile first. */
    async pause(id: string): Promise<WorkflowSnapshot> {
      return snapshot(await mutate(id, state => {
        if (state.status === 'paused') return false;
        if (['succeeded','failed','blocked','outcome_unknown','cancelled'].includes(state.status)) {
          throw new MayuraError('CONFLICT', 'A terminal workflow cannot be paused.');
        }
        if (Object.values(state.steps).some(step => step.status === 'dispatching')) {
          throw new MayuraError('CONFLICT', 'A workflow with an in-flight effect cannot enter the quiescent paused state.');
        }
        state.status = 'paused'; return true;
      }, 'run.paused'));
    },
    /**
     * Plan (dryRun) or apply a reviewed migration of a paused run to a new definition version. The run stays paused;
     * resume it after review. Waiting approvals of unchanged steps stay valid (their digest does not bind the version).
     */
    async migrate(migration: WorkflowMigration<AnyWorkflow, AnyWorkflow>, command: MigrationCommand): Promise<WorkflowMigrationResult<WorkflowSnapshot>> {
      ensureOpen(); assertWorkflowMigration(migration); assertWorkflow(migration.from); assertWorkflow(migration.to);
      const { id, actorId, commandId, dryRun = false } = migrationCommand(command);
      const record = await load(id); const state = stateFrom(record);
      if (state.definition !== migration.from.digest || record.definitionHash !== migration.from.digest || state.policy !== policy || state.maxCostMicros !== maxCostMicros) {
        throw new MayuraError('CONFLICT', 'The run is not pinned to the migration source definition and this policy.');
      }
      const nodes = (definition: AnyWorkflow) => scheduledManifest(definition).graph.map(node =>
        ({ id: node.id, kind: node.kind, dependsOn: node.dependsOn, fingerprint: nodeFingerprint(node as unknown as Record<string, unknown>) }));
      const preconditions: MigrationBlocker[] = [];
      if (state.status !== 'paused') preconditions.push({ node: '*', reason: `The run is ${state.status}; pause it before migrating.` });
      const plan = planWorkflowMigration({ migration, format: 'workflow-v2', runId: id, fromDigest: migration.from.digest, toDigest: migration.to.digest,
        from: nodes(migration.from), to: nodes(migration.to), steps: Object.entries(state.steps).map(([step, value]) => ({ id: step, status: value.status })), preconditions });
      if (dryRun) return freezeJson(jsonValue({ plan })) as unknown as WorkflowMigrationResult<WorkflowSnapshot>;
      assertMigrationAllowed(plan);
      const fresh = initialState(migration.to, state.input, policy, maxCostMicros);
      const carried: Record<string, Step> = {};
      for (const entry of plan.entries) if (entry.target) carried[entry.target] = entry.action === 'keep' || entry.action === 'accept' ? state.steps[entry.source!]! : fresh.steps[entry.target]!;
      const next: State = { ...state, definition: migration.to.digest, steps: Object.fromEntries(migration.to.nodes.map(node => [node.id, carried[node.id]!])) };
      next.reservedMicros = Object.values(next.steps).reduce((sum, step) => sum + step.costReserved, 0);
      try { assertWorkflowStateMatchesManifest(workflowState({ id, state: jsonValue(next) as JsonObject }), scheduledManifest(migration.to)); }
      catch { throw new MayuraError('CONFLICT', 'Migration refused: the migrated state does not satisfy the new definition.'); }
      if (typeof store.migrate !== 'function') throw new MayuraError('UNSUPPORTED_PROFILE', 'This store cannot migrate in-flight workflow runs.');
      const migrated = await storageCall(() => store.migrate!({ scope: scopeKey, id, expectedVersion: record.version, expectedDefinitionHash: migration.from.digest,
        definitionHash: migration.to.digest, state: jsonValue(next) as JsonObject, events: [migrationEvent(plan, actorId, commandId) as { type: string; data: JsonObject }] }));
      return freezeJson(jsonValue({ plan, snapshot: snapshot(migrated) })) as unknown as WorkflowMigrationResult<WorkflowSnapshot>;
    },
    /** Resume scheduling only; unresolved waits remain waiting and grant no authority. */
    async resume(id: string): Promise<WorkflowSnapshot> {
      return snapshot(await mutate(id, state => {
        if (state.status !== 'paused') throw new MayuraError('CONFLICT', 'Only a paused workflow can be resumed.');
        state.status = Object.values(state.steps).some(step => step.status === 'waiting') ? 'waiting' : 'running'; return true;
      }, 'run.resumed'));
    },
    async cancel(id: string): Promise<WorkflowSnapshot> {
      const record = await mutate(id, state => { if (['succeeded','failed','blocked','outcome_unknown','cancelled'].includes(state.status)) return false; state.status = 'cancelled'; return true; }, 'run.cancelled');
      for (const [key, controller] of active) if (key.startsWith(`${id}/`)) controller.abort();
      return snapshot(record);
    },
    /** Trusted operator action after establishing worker abandonment; never redispatches effects. */
    async recoverAbandoned(id: string): Promise<WorkflowSnapshot> {
      return snapshot(await mutate(id, state => {
        let changed = false;
        for (const step of Object.values(state.steps)) if (step.status === 'dispatching') {
          step.status = step.receipt?.execution === 'succeeded' ? 'blocked' : 'unknown'; changed = true;
        }
        if (changed && state.status !== 'cancelled') state.status = 'running';
        return changed;
      }, 'run.recovery_required'));
    },
    close(): void { closed = true; for (const controller of active.values()) controller.abort(); },
    /** Admit no new wave, let admitted effects settle within the deadline, then close. */
    drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport> {
      return gate.drain(options, () => { closed = true; for (const controller of active.values()) controller.abort(); });
    },
  };
}
