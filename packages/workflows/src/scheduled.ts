import { Budget, MayuraError, assertPositiveInteger, jsonValue, validate, type ExecutionReceipt, type JsonValue, type Schema, type InferInput } from '@mayura/core';
import { invokeTool } from '@mayura/tools';
import {
  StorageError, executionRef, workflowPolicy, workflowResources, workflowOutputs,
  workflowGraphOutputs, workflowGraphResources, workflowGraphTargets, assertWorkflowGraphStateMatchesManifest,
  type Claim, type ScheduledWrite, type ScheduledWorkflowAggregateStore,
  type ScheduledWorkflowStore, type WorkflowResourcePlan, type ExecutionRef, type StoredRecord,
  type WorkflowGraphAggregateStore, type WorkflowGraphStore, type WorkflowFormat2State, type WorkflowGraphFormat3State,
} from '@mayura/storage-contracts';
import { assertWorkflow, digest, resolveBinding, type AnyWorkflow, type WorkflowDefinition } from './definition.js';
import { assertWorkflowGraph, graphManifest, type AnyWorkflowGraph } from './graph-definition.js';
import type { WorkflowGraphRuntimeOptions } from './graphs.js';
import type { WorkflowRuntimeOptions, WorkflowSnapshot, VerifiedHuman } from './runtime.js';
import { isStorageCode, safeScheduledJson, scheduledCallback, scheduledClaim, scheduledClaims, scheduledEvents, scheduledManifest, scheduledSnapshot, scheduledState, scheduledStorage as persist, scheduledSubmission, scheduledTransition, scheduledView, type ScheduledTransition, type ScheduledStoredSnapshot, type ScheduledPublicSnapshot, type ScheduledProfile } from './scheduled-helpers.js';

export interface ScheduledWorkflowRuntimeOptions extends Omit<WorkflowRuntimeOptions, 'store'> {
  readonly store: ScheduledWorkflowAggregateStore;
  readonly workerId: string;
  readonly leaseMs?: number;
  /** Shared across this worker instance, including uncertain handlers that have not settled. */
  readonly maxConcurrentJobs?: number;
  readonly maxConcurrentRuns?: number;
  /** Bounds each adapter wait, not its underlying transaction; timeout never grants replay. */
  readonly storageTimeoutMs?: number;
  /** Timed-out adapter callbacks retain these slots until their actual promises settle. */
  readonly maxPendingStorageOperations?: number;
  /** Explicit resource identities per tool node; immutable after the run is enrolled. */
  readonly resources?: WorkflowResourcePlan;
}
export interface ScheduledWorkflowRuntime {
  readonly profile: 'scheduled-v1';
  submit<I extends Schema, O extends Schema>(definition: WorkflowDefinition<I, O>, command: { readonly input: InferInput<I>; readonly idempotencyKey: string }): Promise<WorkflowSnapshot>;
  attach(definition: AnyWorkflow, id: string): Promise<WorkflowSnapshot>;
  inspect(id: string): Promise<WorkflowSnapshot>;
  /** Scoped immutable identity data, not a capability or proof of backend identity. */
  reference(id: string): Promise<ExecutionRef>;
  events(id: string, after?: number): ReturnType<ScheduledWorkflowAggregateStore['events']>;
  runUntilSettled(definition: AnyWorkflow, id: string): Promise<WorkflowSnapshot>;
  approve(command: { readonly id: string; readonly nodeId: string; readonly digest: string; readonly credential: unknown }): Promise<WorkflowSnapshot>;
  cancel(id: string): Promise<WorkflowSnapshot>;
  recoverExpired(id: string): Promise<WorkflowSnapshot>;
  /** Stops this worker, not the shared workflow. Keeps caller-owned storage available for late evidence. */
  close(): Promise<void>;
}
const terminal = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const methods = ['initialize', 'submit', 'attach', 'inspect', 'requestApproval', 'approve', 'prepare', 'claim', 'renew', 'start',
  'recordReceipt', 'complete', 'abandon', 'failNode', 'advance', 'finalize', 'cancel', 'recover'] as const;

/** Explicit finite scheduled driver. All persistence authority stays in atomic storage commands. */
export function createScheduledWorkflowRuntime(options: ScheduledWorkflowRuntimeOptions): ScheduledWorkflowRuntime {
  return createScheduledDriver(options, 'scheduled-v1') as ScheduledWorkflowRuntime;
}

type DriverDefinition = AnyWorkflow | AnyWorkflowGraph;
type DriverStoreControls = {
  [K in Exclude<keyof ScheduledWorkflowStore, 'submit' | 'attach'>]:
    (...args: Parameters<ScheduledWorkflowStore[K]>) => Promise<Awaited<ReturnType<ScheduledWorkflowStore[K]>> | Awaited<ReturnType<WorkflowGraphStore[K]>>>;
};
interface ScheduledDriverRuntime {
  readonly profile: ScheduledProfile;
  submit(definition: DriverDefinition, command: { readonly input: unknown; readonly idempotencyKey: string }): Promise<ScheduledPublicSnapshot>;
  readonly attach?: (definition: AnyWorkflow, id: string) => Promise<ScheduledPublicSnapshot>;
  inspect(id: string): Promise<ScheduledPublicSnapshot>;
  reference(id: string): Promise<ExecutionRef>;
  events(id: string, after?: number): ReturnType<ScheduledWorkflowAggregateStore['events']>;
  runUntilSettled(definition: DriverDefinition, id: string): Promise<ScheduledPublicSnapshot>;
  approve(command: Parameters<ScheduledWorkflowRuntime['approve']>[0]): Promise<ScheduledPublicSnapshot>;
  cancel(id: string): Promise<ScheduledPublicSnapshot>;
  recoverExpired(id: string): Promise<ScheduledPublicSnapshot>;
  close(): Promise<void>;
}

/** Shared finite worker engine. Only exact profile compilers, decoders and capabilities vary. */
export function createScheduledDriver(options: ScheduledWorkflowRuntimeOptions | WorkflowGraphRuntimeOptions, profile: ScheduledProfile): ScheduledDriverRuntime {
  const { store } = options;
  let api: DriverStoreControls;
  let read: ScheduledWorkflowAggregateStore['read'];
  let events: ScheduledWorkflowAggregateStore['events'];
  try {
    const source = profile === 'scheduled-v1' ? store?.workflows : (store as WorkflowGraphAggregateStore)?.workflowGraphs;
    const required = methods.filter(method => profile === 'scheduled-v1' || method !== 'attach');
    if (!source || required.some(method => typeof (source as ScheduledWorkflowStore)[method] !== 'function')) throw new Error();
    api = Object.freeze(Object.fromEntries(required.map(method => [method, (source as ScheduledWorkflowStore)[method].bind(source)]))) as unknown as DriverStoreControls;
    read = store.read.bind(store); events = store.events.bind(store);
  } catch { throw new MayuraError('UNSUPPORTED_PROFILE', 'This adapter does not provide atomic scheduled workflow storage.'); }
  let policy: ReturnType<typeof workflowPolicy>;
  try {
    policy = workflowPolicy({ scope: options.scope, permissions: options.permissions?.allow,
      policyVersion: options.policyVersion, maxCostMicros: options.maxCostMicros,
      maxOutputBytes: options.maxOutputBytes ?? 65_536, approvalTtlMs: options.approvalTtlMs ?? 3_600_000,
    });
  } catch { throw new MayuraError('INVALID_CONFIG', 'Scheduled execution requires explicit bounded scope, grants and policy; output cannot exceed 64 KiB.'); }
  const scope = policy.scope;
  const scopeKey = digest('mayura:scope:v1', scope);
  const policyHash = digest('mayura:policy:v1', { ...policy, permissions: [...policy.permissions].sort() });
  const stateFrom = (record: StoredRecord) => scheduledState(record, profile);
  const snapshot = (record: StoredRecord) => scheduledSnapshot(record, profile);
  const view = (raw: ScheduledStoredSnapshot, id: string): ScheduledStoredSnapshot => {
    const checked = scheduledView(raw, scopeKey, id, policyHash, profile);
    if (profile === 'scheduled-v2') {
      try {
        const state = stateFrom(checked.record);
        if (state.maxCostMicros !== policy.maxCostMicros) throw new Error();
        jsonValue(state.input, { maxBytes: policy.maxOutputBytes });
        jsonValue(state.output, { maxBytes: policy.maxOutputBytes });
        for (const step of Object.values(state.steps)) jsonValue(step.output, { maxBytes: policy.maxOutputBytes });
      } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled graph response exceeds its configured policy bounds.'); }
    }
    const activeDefinition = drivers.get(id)?.definition;
    // While driving a registered graph, structural validity alone cannot authorize continuation.
    if (profile === 'scheduled-v2' && activeDefinition) matches(activeDefinition, checked);
    return checked;
  };
  const outputs = (state: WorkflowFormat2State | WorkflowGraphFormat3State) => state.format === 2 ? workflowOutputs(state) : workflowGraphOutputs(state);
  const assertDefinition = (definition: DriverDefinition): void => {
    if (profile === 'scheduled-v1') assertWorkflow(definition as AnyWorkflow);
    else assertWorkflowGraph(definition as AnyWorkflowGraph);
  };
  const permissions = Object.freeze({ allow: policy.permissions });
  const workerId = options.workerId;
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(workerId)) throw new MayuraError('INVALID_CONFIG', 'A bounded worker identity is required.');
  const leaseMs = options.leaseMs ?? 3_000;
  const maxConcurrentJobs = options.maxConcurrentJobs ?? 4;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 16;
  const storageTimeoutMs = options.storageTimeoutMs ?? 10_000;
  const maxPendingStorageOperations = options.maxPendingStorageOperations ?? 64;
  for (const [name, value] of Object.entries({ leaseMs, maxConcurrentJobs, maxConcurrentRuns, storageTimeoutMs, maxPendingStorageOperations })) assertPositiveInteger(value, name);
  if (leaseMs < 1_000 || leaseMs > 300_000 || maxConcurrentJobs > 32 || maxConcurrentRuns > 128 || storageTimeoutMs > 30_000 || maxPendingStorageOperations > 1_024) throw new MayuraError('INVALID_CONFIG', 'Scheduled worker limits exceed supported bounds.');
  const resourceInput = safeScheduledJson(options.resources ?? {}, 1_048_576, 'input') as WorkflowResourcePlan;
  const verifyHuman = options.verifyHuman;
  const shutdown = new AbortController();
  let pendingStorage = 0;
  // A cancelled/expired wait never cancels a committed database fact or authorizes a replay.
  const scheduledStorage = <T>(operation: () => Promise<T>, evidence = false): Promise<T> => persist(async () => {
    if (pendingStorage >= maxPendingStorageOperations) throw new StorageError('QUEUE_FULL', 'The worker persistence capacity is occupied.');
    pendingStorage++;
    try { return await operation(); } finally { pendingStorage--; }
  }, storageTimeoutMs, evidence ? undefined : shutdown.signal);
  const active = new Map<string, AbortController>();
  const drivers = new Map<string, { readonly definition: DriverDefinition; readonly definitionHash: string; readonly operation: Promise<ScheduledPublicSnapshot> }>();
  let slots = 0;
  let closed = false;
  let initialized: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const open = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Scheduled worker is closed.'); };
  const initialize = (): Promise<void> => {
    initialized ??= scheduledStorage(() => api.initialize()).catch((error: unknown) => { initialized = undefined; throw error; });
    return initialized;
  };
  const access = (id: string) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new MayuraError('INVALID_INPUT', 'An exact workflow run ID is required.');
    return { scope: scopeKey, id, policyHash };
  };
  const load = async (id: string): Promise<ScheduledStoredSnapshot> => {
    const key = access(id); await initialize();
    return view(await scheduledStorage(() => api.inspect(key)), id);
  };
  const write = async <T extends ScheduledTransition>(id: string, operation: (command: ScheduledWrite, current: ScheduledStoredSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const commandId = crypto.randomUUID();
    for (let attempt = 0; attempt < 32; attempt++) {
      (signal ?? shutdown.signal).throwIfAborted();
      const current = await load(id);
      (signal ?? shutdown.signal).throwIfAborted();
      try {
        const result = await scheduledStorage(() => operation({ ...access(id), commandId, expectedVersion: current.record.version }, current));
        const checked = scheduledTransition(result, scopeKey, id, policyHash, profile);
        // Mutation acknowledgements must meet the same registered graph checks as reads.
        if (profile === 'scheduled-v2') view('snapshot' in checked ? checked.snapshot : checked, id);
        return checked;
      }
      catch (error) { if (!isStorageCode(error, 'CONFLICT')) throw error; }
    }
    throw new MayuraError('CONFLICT', 'Scheduled contention exceeded the bounded retry limit.');
  };
  const compileEnrollment = (definition: DriverDefinition) => {
    if (profile === 'scheduled-v2') {
      const manifest = graphManifest(definition as AnyWorkflowGraph);
      if (digest('mayura:workflow:v2', manifest) !== definition.digest) throw new MayuraError('INVALID_CONFIG', 'Workflow graph metadata does not match its registered definition.');
      return { manifest, policy, resources: workflowGraphResources(resourceInput, manifest) };
    }
    const manifest = scheduledManifest(definition as AnyWorkflow);
    if (digest('mayura:workflow:v1', manifest) !== definition.digest) throw new MayuraError('INVALID_CONFIG', 'Workflow metadata does not match its registered definition.');
    return { manifest, policy, resources: workflowResources(resourceInput, manifest) };
  };
  const enrollments = new WeakMap<DriverDefinition, { readonly registered: ReturnType<typeof compileEnrollment>; readonly resourceHash: string }>();
  const enrollment = (definition: DriverDefinition) => {
    // Factory branding is checked before consulting identity caches. Definitions,
    // manifests, policy and the captured resource plan are immutable snapshots.
    assertDefinition(definition);
    let known = enrollments.get(definition);
    if (!known) {
      const registered = Object.freeze(compileEnrollment(definition));
      known = { registered, resourceHash: digest('mayura:workflow-resources:v1', registered.resources) };
      enrollments.set(definition, known);
    }
    return known.registered;
  };
  const matches = (definition: DriverDefinition, current: ScheduledStoredSnapshot): void => {
    const registered = enrollment(definition);
    if (current.manifestHash !== definition.digest || current.record.definitionHash !== definition.digest
      || current.resourceHash !== enrollments.get(definition)!.resourceHash) throw new MayuraError('CONFLICT', 'Scheduled definition or resource plan changed; explicit migration is required.');
    if ('format' in registered.manifest) {
      try {
        const state = stateFrom(current.record); if (state.format !== 3) throw new Error();
        assertWorkflowGraphStateMatchesManifest(state, registered.manifest);
      } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled graph state does not match its registered definition.'); }
    }
  };
  const receiptId = (jobId: string, fence: number, receipt: ExecutionReceipt): string => digest('mayura:workflow-receipt:v1', { jobId, fence, receipt });
  const pendingNode = (current: ScheduledStoredSnapshot, nodeId: string): boolean => {
    const state = stateFrom(current.record);
    return !terminal.has(state.status) && !current.jobs.some(job => job.nodeId === nodeId)
      && ['pending', 'waiting', 'approved'].includes(state.steps[nodeId]?.status ?? '');
  };
  const updatePendingNode = (id: string, nodeId: string, operation: (command: ScheduledWrite) => Promise<ScheduledStoredSnapshot>): Promise<ScheduledStoredSnapshot> =>
    write(id, (command, current) => pendingNode(current, nodeId) ? operation(command) : Promise.resolve(current));

  async function executeClaim(definition: DriverDefinition, id: string, jobId: string, originalClaim: Claim): Promise<void> {
    const controller = new AbortController();
    active.set(jobId, controller);
    const relay = (): void => { controller.abort(); };
    shutdown.signal.addEventListener('abort', relay, { once: true });
    if (shutdown.signal.aborted) relay();
    let token = originalClaim;
    let dispatchSignal = controller.signal;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | undefined;
    let finished = false; let acquired = false; let handlerSettled = false; let logicalSettled = false; let released = false;
    const releaseSlot = (): void => {
      if (!released && logicalSettled && (!acquired || handlerSettled)) { released = true; slots--; }
    };
    const scheduleRenewal = (): void => {
      if (finished || controller.signal.aborted) return;
      renewal = setTimeout(() => {
        renewing = scheduledStorage(() => api.renew({ ...access(id), claim: token, leaseMs }))
          .then(next => { if (!controller.signal.aborted) { token = scheduledClaim(next, originalClaim); scheduleRenewal(); } })
          .catch(() => { controller.abort(); });
      }, Math.max(100, Math.floor(leaseMs / 3)));
    };
    const stopRenewal = async (): Promise<void> => {
      // A renewal commits the same aggregate version that completion compares.
      // Stop future heartbeats and drain its bounded adapter wait before final CAS;
      // otherwise this worker can repeatedly invalidate its own completion read.
      finished = true;
      if (renewal) clearTimeout(renewal);
      await renewing;
    };
    const ownsJob = (current: ScheduledStoredSnapshot, state: 'leased' | 'started'): boolean => {
      const job = current.jobs.find(item => item.jobId === jobId);
      return !terminal.has(stateFrom(current.record).status) && job?.state === state
        && job.fence === originalClaim.fence && job.workerId === originalClaim.workerId
        && !job.cancelRequested && !job.leaseRevoked;
    };
    const record = async (receipt: ExecutionReceipt): Promise<string> => {
      const withheld = Object.freeze({ ...receipt, disclosure: 'withheld' as const });
      const evidenceId = receiptId(jobId, originalClaim.fence, withheld);
      // Actual completion evidence outlives worker shutdown; only its wait is deadline-bounded.
      const result = await scheduledStorage(() => api.recordReceipt({ ...access(id), jobId, fence: originalClaim.fence, evidenceId, receipt: withheld }), true);
      view(result, id);
      return evidenceId;
    };
    try {
      const initial = await load(id); matches(definition, initial);
      const job = initial.jobs.find(item => item.jobId === jobId);
      const node = definition.nodes.find(item => item.kind === 'tool' && item.id === job?.nodeId);
      if (!job || !node || node.kind !== 'tool' || job.intent['toolId'] !== node.tool.id || job.intent['callId'] !== `${id}/step:${node.id}`) throw new MayuraError('CONFLICT', 'Scheduled claim does not match this registered tool node.');
      scheduleRenewal();
      const state = stateFrom(initial.record);
      const raw = resolveBinding(node.input, state.input, outputs(state));
      const result = await invokeTool(node.tool, raw, {
        runId: id, callId: `${id}/step:${node.id}`, scope, permissions, signal: controller.signal,
        budget: new Budget(node.tool.costMicros, 1), maxOutputBytes: policy.maxOutputBytes,
        acquireExecution: async signal => {
          signal.throwIfAborted(); acquired = true; dispatchSignal = signal;
          return () => { handlerSettled = true; releaseSlot(); };
        },
        beforeDispatch: async input => {
          const started = await write(id, command => api.start({ ...command, claim: token, input }), dispatchSignal);
          if (started.status !== 'started') throw new MayuraError('CONFLICT', 'The claim does not grant a fresh dispatch.');
        },
        onExecutionReceipt: async receipt => { await record(receipt); },
      });
      const current = await load(id);
      const currentJob = current.jobs.find(item => item.jobId === jobId);
      if (!currentJob || currentJob.fence !== originalClaim.fence) return;
      if (currentJob.startedAtMs === null) {
        // Worker shutdown hands never-started leases back to expiry/recovery, not a run cancellation.
        if (!closed && currentJob.state === 'leased') {
          await stopRenewal();
          await write(id, (command, latest) => ownsJob(latest, 'leased')
            ? api.abandon({ ...command, claim: token, outcome: result.status === 'failed' ? 'failed' : 'blocked' })
            : Promise.resolve(latest));
        }
        return;
      }
      if (!result.receipt) return;
      const evidenceId = await scheduledCallback(() => record(result.receipt!), storageTimeoutMs, shutdown.signal);
      if (result.receipt.execution === 'unknown') return;
      const outcome = result.status === 'succeeded' ? 'succeeded' : result.receipt.execution === 'failed' ? 'failed' : 'blocked';
      await stopRenewal();
      await write(id, (command, latest) => {
        // Receipt persistence, cancellation or recovery may have committed lost
        // authority. That is not a version conflict: retain the known evidence and
        // withheld output without retrying a permanently ineligible completion.
        if (!ownsJob(latest, 'started')) return Promise.resolve(latest);
        return api.complete({ ...command, claim: token, evidenceId, outcome,
          output: result.status === 'succeeded' ? safeScheduledJson(result.output, policy.maxOutputBytes, 'output') : null,
        });
      });
    } catch (error) {
      // Lost authority never causes a handler replay or a generic aggregate replacement.
      if (!isStorageCode(error, 'STALE_CLAIM') && !isStorageCode(error, 'CONFLICT')) throw error;
    } finally {
      finished = true; if (renewal) clearTimeout(renewal);
      shutdown.signal.removeEventListener('abort', relay); active.delete(jobId);
      logicalSettled = true; releaseSlot();
    }
  }

  async function drive(definition: DriverDefinition, id: string): Promise<ScheduledPublicSnapshot> {
    for (let wave = 0; wave < definition.nodes.length * 2 + 8; wave++) {
      open();
      let current = await load(id); matches(definition, current);
      if (terminal.has(stateFrom(current.record).status)) return snapshot(current.record);
      const before = current.record.version;
      current = await write(id, command => api.recover(command));
      current = await write(id, command => api.advance(command));
      if (terminal.has(stateFrom(current.record).status)) return snapshot(current.record);
      let preparingState = stateFrom(current.record);
      for (const node of definition.nodes) {
        if (node.kind !== 'tool') continue;
        // A validated terminal step or immutable prepared-job link can never become a new
        // preparation candidate. Avoid re-reading the entire aggregate for each such node.
        // Potential candidates still receive a fresh read and the same authoritative CAS.
        const observedStep = preparingState.steps[node.id];
        if (!observedStep || !['pending', 'waiting', 'approved'].includes(observedStep.status)
          || current.jobs.some(job => job.nodeId === node.id)) continue;
        current = await load(id);
        const state = stateFrom(current.record); preparingState = state; const step = state.steps[node.id];
        if (terminal.has(state.status)) return snapshot(current.record);
        if (!step || !['pending', 'waiting', 'approved'].includes(step.status) || current.jobs.some(job => job.nodeId === node.id)
          || (node.dependsOn ?? []).some(dependency => state.steps[dependency]?.status !== 'succeeded')) continue;
        const required = [`tool:${node.tool.id}`, ...node.tool.capabilities, ...(node.tool.effects === 'none' ? [] : [`effect:${node.tool.effects}`])];
        if (required.some(grant => !permissions.allow.includes(grant))) {
          current = await updatePendingNode(id, node.id, command => api.failNode({ ...command, nodeId: node.id, outcome: 'blocked' }));
          preparingState = stateFrom(current.record); continue;
        }
        let input: JsonValue;
        try {
          const raw = resolveBinding(node.input, state.input, outputs(state));
          input = safeScheduledJson(await scheduledCallback(() => validate(node.tool.input, raw, 'input', { maxBytes: policy.maxOutputBytes }), node.tool.timeoutMs, shutdown.signal), policy.maxOutputBytes, 'input');
        } catch {
          open(); current = await updatePendingNode(id, node.id, command => api.failNode({ ...command, nodeId: node.id, outcome: 'failed' }));
          preparingState = stateFrom(current.record); continue;
        }
        if (node.approval) {
          current = await updatePendingNode(id, node.id, command => api.requestApproval({ ...command, nodeId: node.id, input }));
          preparingState = stateFrom(current.record);
          if (preparingState.steps[node.id]?.status !== 'approved') continue;
        }
        current = await updatePendingNode(id, node.id, command => api.prepare({ ...command, nodeId: node.id, input }));
        preparingState = stateFrom(current.record);
      }
      const available = maxConcurrentJobs - slots;
      let count = 0;
      if (available > 0 && !closed) {
        slots += available;
        let claims: Awaited<ReturnType<ScheduledWorkflowStore['claim']>>;
        try { claims = scheduledClaims(await scheduledStorage(() => api.claim({ ...access(id), workerId, limit: available, leaseMs })), scopeKey, id, workerId, available); }
        catch (error) { slots -= available; throw error; }
        slots -= available - claims.length; count = claims.length;
        // A sibling storage failure does not detach already claimed local work from this driver.
        const results = await Promise.allSettled(claims.map(item => executeClaim(definition, id, item.job.jobId, item.claim)));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
      current = await write(id, command => api.advance(command));
      const state = stateFrom(current.record);
      if (terminal.has(state.status)) return snapshot(current.record);
      if (Object.values(state.steps).every(step => step.status === 'succeeded')) {
        let final: { validation: 'passed'; output: JsonValue } | { validation: 'failed' };
        try {
          const raw = resolveBinding(definition.result, state.input, outputs(state));
          const output = await scheduledCallback(() => validate(definition.output, raw, 'output', { maxBytes: policy.maxOutputBytes }), 30_000, shutdown.signal);
          final = { validation: 'passed', output: safeScheduledJson(output, policy.maxOutputBytes, 'output') };
        } catch { open(); final = { validation: 'failed' }; }
        try {
          const committed = await scheduledStorage(() => api.finalize({ ...access(id), expectedVersion: current.record.version, commandId: crypto.randomUUID(), ...final }));
          return snapshot(view(committed, id).record);
        } catch (error) { if (!isStorageCode(error, 'CONFLICT')) throw error; }
      }
      if (count === 0 && current.record.version === before) return snapshot(current.record);
    }
    return snapshot((await load(id)).record);
  }

  return Object.freeze<ScheduledDriverRuntime>({
    profile,
    async submit(definition, command): Promise<ScheduledPublicSnapshot> {
      open(); const registered = enrollment(definition);
      const key = command.idempotencyKey;
      if (typeof key !== 'string' || !key.length || key.length > 128) throw new MayuraError('INVALID_INPUT', 'A bounded stable submission key is required.');
      const raw = safeScheduledJson(command.input, policy.maxOutputBytes, 'input');
      const input = safeScheduledJson(await scheduledCallback(() => validate(definition.input, raw, 'input'), 30_000, shutdown.signal), policy.maxOutputBytes, 'input');
      if ('format' in registered.manifest) {
        try { workflowGraphTargets(registered.manifest, input); }
        catch { throw new MayuraError('INVALID_INPUT', 'Workflow graph wait targets are invalid or exceed their finite bounds.'); }
      }
      open(); await initialize();
      const submission = { ...registered, input, idempotencyKey: key };
      const result = await scheduledStorage<{ readonly snapshot: ScheduledStoredSnapshot; readonly created: boolean }>(() => profile === 'scheduled-v1'
        ? (api as ScheduledWorkflowStore).submit(submission as Parameters<ScheduledWorkflowStore['submit']>[0])
        : (api as WorkflowGraphStore).submit(submission as Parameters<WorkflowGraphStore['submit']>[0]));
      const id = digest('mayura:run-id:v1', { scope: scopeKey, submissionKey: key });
      const current = view(scheduledSubmission(result).snapshot, id); matches(definition, current);
      if (profile === 'scheduled-v2' && (current.record.idempotencyKey !== key
        || digest('mayura:workflow-input:v1', stateFrom(current.record).input) !== digest('mayura:workflow-input:v1', input))) {
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow graph submission acknowledgement changed admitted input or identity.');
      }
      return snapshot(current.record);
    },
    ...(profile === 'scheduled-v1' ? { async attach(definition: AnyWorkflow, id: string) {
      open(); const registered = enrollment(definition); await initialize();
      // Explicit enrollment reads the ordinary pristine aggregate; it has no sidecar to inspect yet.
      const record = await scheduledStorage(() => read(scopeKey, access(id).id));
      if (!record) throw new MayuraError('NOT_FOUND', 'Workflow was not found in this scope.');
      const result = await scheduledStorage(() => (api as ScheduledWorkflowStore).attach({ ...access(id), expectedVersion: record.version, commandId: crypto.randomUUID(), ...registered } as Parameters<ScheduledWorkflowStore['attach']>[0]));
      const current = view(result, id); matches(definition, current);
      return snapshot(current.record);
    } } : {}),
    async inspect(id) { open(); return snapshot((await load(id)).record); },
    async reference(id) {
      open(); const current = await load(id); open();
      return executionRef({ kind: 'scheduled-workflow', runId: current.record.id,
        definitionHash: current.record.definitionHash, policyHash: current.policyHash });
    },
    async events(id, after = 0) {
      open(); access(id);
      if (!Number.isSafeInteger(after) || after < 0) throw new MayuraError('INVALID_INPUT', 'A non-negative event cursor is required.');
      await load(id);
      return scheduledEvents(await scheduledStorage(() => events(scopeKey, id, after)), after);
    },
    runUntilSettled(definition, id) {
      open(); assertDefinition(definition); access(id); enrollment(definition);
      const existing = drivers.get(id);
      if (existing) return existing.definitionHash === definition.digest ? existing.operation
        : Promise.reject(new MayuraError('CONFLICT', 'The active driver uses a different workflow definition.'));
      if (drivers.size >= maxConcurrentRuns) return Promise.reject(new MayuraError('LIMIT_EXCEEDED', 'This worker has reached its active-run limit.'));
      const operation = drive(definition, id).finally(() => { drivers.delete(id); });
      drivers.set(id, { definition, definitionHash: definition.digest, operation }); return operation;
    },
    async approve(command) {
      open(); const { id, nodeId, digest: approvalDigest, credential } = command; access(id);
      if (typeof nodeId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(nodeId) || ['constructor', 'prototype', '__proto__'].includes(nodeId)
        || typeof approvalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(approvalDigest)) throw new MayuraError('INVALID_INPUT', 'Approval requires an exact node and review digest.');
      if (!verifyHuman) throw new MayuraError('PERMISSION_DENIED', 'A trusted human verifier is required.');
      let human: VerifiedHuman;
      try {
        const value = await scheduledCallback(() => verifyHuman(credential), 30_000, shutdown.signal);
        human = { id: value.id, projectId: value.projectId, canApprove: value.canApprove };
        if (typeof human.id !== 'string' || !human.id.length || human.id.length > 256 || human.projectId !== scope.projectId || human.canApprove !== true) throw new Error();
      } catch { throw new MayuraError('PERMISSION_DENIED', 'Human verification did not authorize this approval.'); }
      open();
      return snapshot((await write(id, base => api.approve({ ...base, nodeId, digest: approvalDigest, humanId: human.id }), shutdown.signal)).record);
    },
    async cancel(id) {
      open(); const result = await write(id, command => api.cancel(command));
      for (const job of result.jobs) active.get(job.jobId)?.abort();
      return snapshot(result.record);
    },
    async recoverExpired(id) { open(); return snapshot((await write(id, command => api.recover(command))).record); },
    close() {
      if (!closing) { closed = true; shutdown.abort(); closing = Promise.allSettled([...drivers.values()].map(driver => driver.operation)).then(() => {}); }
      return closing;
    },
  });
}
