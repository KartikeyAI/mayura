import {
  assertPositiveInteger, Budget, freezeJson, jsonValue, MayuraError, publicError, validate,
  type BudgetTicket, type BudgetBundle, type Reservation, type ManagedGuardDefinition, type ExecutionEvidence, type ExecutionReceipt, type Guard, type InferInput, type InferOutput, type JsonValue, type ModelMessage, type ModelRequest,
  type Outcome, type Permissions, type RunHandle, type Schema, type Scope,
} from '@mayura/core';
import { readManagedGuardDefinition } from '@mayura/core/host';
import { invokeTool, type AnyTool } from '@mayura/tools';
import { bindToolBudgetTicket } from '@mayura/tools/host';
import { assertAgent, isIdentifier, type AgentDefinition, type AgentGuard } from './agent.js';
import { EventBuffer } from './event-buffer.js';
import { modelCost, modelFailureCost, modelResponse } from './response.js';
import { childGateway, isAgentTool, type ChildOptions } from './composition.js';
import { OperationPermits } from './permits.js';
import { evaluateManagedGuard } from './managed-guards.js';

/** All bounds are finite; model/token/cost declarations do not turn trusted callbacks into a sandbox. */
export interface RuntimeLimits {
  readonly maxSteps?: number;
  readonly maxModelCalls?: number;
  readonly maxToolCalls?: number;
  readonly maxDurationMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxContextBytes?: number;
  readonly maxOutputTokens?: number;
  readonly maxCostMicros?: number;
  readonly maxEventRetention?: number;
  /** Concurrent root admissions; descendants have separate bounded capacity. */
  readonly maxConcurrentRuns?: number;
  readonly maxDescendantRuns?: number;
  readonly maxDepth?: number;
  readonly maxConcurrentOperations?: number;
}
export interface RuntimeOptions {
  readonly profile: 'ephemeral';
  readonly permissions?: Permissions;
  readonly scope?: Scope;
  readonly limits?: RuntimeLimits;
}
export interface Runtime {
  readonly profile: 'ephemeral';
  submit<I extends Schema, O extends Schema>(agent: AgentDefinition<I, O>, options: { readonly input: InferInput<I> }): RunHandle<InferOutput<O>>;
  spawn<I extends Schema, O extends Schema>(parent: RunHandle<unknown>, agent: AgentDefinition<I, O>, options: ChildOptions & { readonly input: InferInput<I> }): RunHandle<InferOutput<O>>;
  inspect(handle: RunHandle<unknown>): RunInspection;
  /** Stop admissions, request cancellation, and wait for accepted runs to reach a terminal outcome. */
  close(): Promise<void>;
}

const defaults: Required<RuntimeLimits> = Object.freeze({
  maxSteps: 16, maxModelCalls: 16, maxToolCalls: 64, maxDurationMs: 60_000,
  maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576, maxContextBytes: 2_097_152,
  maxOutputTokens: 4_096, maxCostMicros: 0, maxEventRetention: 256, maxConcurrentRuns: 32,
  maxDescendantRuns: 64, maxDepth: 8, maxConcurrentOperations: 32,
});

function limitsFor(options: RuntimeLimits | undefined): Required<RuntimeLimits> {
  const result = { ...defaults, ...options };
  if (Object.keys(result).some((key) => !(key in defaults))) throw new MayuraError('INVALID_CONFIG', 'Unknown runtime limit.');
  for (const [key, value] of Object.entries(result)) {
    if (key === 'maxCostMicros') {
      if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'maxCostMicros must be a non-negative safe integer.');
    } else assertPositiveInteger(value, key);
  }
  if (result.maxDurationMs > 2_147_483_647 || !Number.isSafeInteger(result.maxModelCalls + result.maxToolCalls)) {
    throw new MayuraError('INVALID_CONFIG', 'Runtime limits exceed the supported counter or timer range.');
  }
  if (result.maxDepth > 32 || result.maxDescendantRuns > 1023 || result.maxConcurrentOperations > 1024
    || result.maxConcurrentRuns > 1024 || result.maxModelCalls > 4096 || result.maxToolCalls > 4096) {
    throw new MayuraError('INVALID_CONFIG', 'Runtime tree or operation limits exceed supported bounds.');
  }
  return Object.freeze(result);
}

/** Race cooperative async work against cancellation; retained rejection handlers prevent late unhandled failures. */
async function cancellable<T>(operation: () => PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const cleanup = (): void => { signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    }).then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function outcomeFor(error: unknown): Outcome<never> {
  const safe = publicError(error, 'MODEL_FAILED');
  const status = safe.code === 'CANCELLED' ? 'cancelled'
    : ['PERMISSION_DENIED', 'BUDGET_EXCEEDED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE'].includes(safe.code) ? 'blocked'
    : 'failed';
  return Object.freeze({ status, error: Object.freeze(safe) });
}


export interface RunInspection {
  readonly id: string;
  readonly rootId: string;
  readonly parentId?: string;
  readonly agentId: string;
  readonly status: 'running' | Outcome<unknown>['status'];
  readonly budget: ReturnType<Budget['snapshot']>;
  readonly runs: readonly { readonly id: string; readonly parentId?: string; readonly agentId: string; readonly status: 'running' | Outcome<unknown>['status'] }[];
  readonly evidence: readonly ExecutionEvidence[];
}
interface RunState {
  readonly id: string;
  readonly agent: AgentDefinition;
  readonly parent: RunState | undefined;
  readonly root: RunState;
  readonly depth: number;
  readonly deadline: number;
  readonly limits: Required<RuntimeLimits>;
  readonly permissions: Permissions;
  readonly budget: Budget;
  readonly operations: OperationPermits;
  readonly controller: AbortController;
  readonly handle: RunHandle<unknown>;
  readonly children: RunState[];
  readonly receipts: Map<string, ExecutionReceipt>;
  accepting: boolean;
  status: 'running' | Outcome<unknown>['status'];
  descendants: number;
  modelCalls: number;
  toolCalls: number;
  heldModelCalls: number;
  heldToolCalls: number;
  readonly bundles: Set<CallBundle>;
}
function permissionsFor(supplied: Permissions | undefined, required = false): Permissions {
  const allow = supplied?.allow ?? (required ? undefined : []);
  if (!Array.isArray(allow) || allow.length > 4096 || allow.some((grant) => typeof grant !== 'string' || grant.length === 0 || grant.length > 256)) {
    throw new MayuraError('INVALID_CONFIG', 'Permissions must be an explicit list of bounded capability names.');
  }
  return Object.freeze({ allow: Object.freeze([...new Set(allow)]) });
}
function ancestors(state: RunState): RunState[] {
  const path: RunState[] = [];
  for (let current: RunState | undefined = state; current; current = current.parent) path.push(current);
  return path;
}
function subtree(state: RunState): RunState[] { return [state, ...state.children.flatMap(subtree)]; }
function evidenceFor(state: RunState): readonly ExecutionEvidence[] {
  return Object.freeze(subtree(state).flatMap((run) => [...run.receipts.values()].map((receipt) => Object.freeze({ runId: run.id, receipt }))));
}
/** Preserve known late evidence when a stale cancellation snapshot still says unknown. */
function record(state: RunState, receipt: ExecutionReceipt): void {
  const old = state.receipts.get(receipt.callId);
  const execution = old && ['succeeded', 'failed'].includes(old.execution) && !['succeeded', 'failed'].includes(receipt.execution)
    ? old.execution : receipt.execution;
  state.receipts.set(receipt.callId, Object.freeze({ ...receipt, execution }));
}
function checkCalls(state: RunState, kind: 'model' | 'tool', count: number): void {
  for (const current of ancestors(state)) {
    const remaining = kind === 'model' ? current.limits.maxModelCalls - current.modelCalls - current.heldModelCalls
      : current.limits.maxToolCalls - current.toolCalls - current.heldToolCalls;
    if (count > remaining) throw new MayuraError('LIMIT_EXCEEDED', 'An ancestor execution-call limit was reached.');
  }
}
interface CallTicket { readonly ticket: BudgetTicket; readonly kind: 'model' | 'tool'; counted: boolean; cancelled: boolean }
interface CallBundle { readonly entries: readonly CallTicket[]; close(): void }

/** Internal atomic projection: only freshly-created primitive records reach the core commit. */
function reserveCalls(state: RunState, operations: readonly { readonly kind: 'model' | 'tool'; readonly maxCostMicros: number }[]): CallBundle {
  const path = ancestors(state);
  const modelCount = operations.filter(operation => operation.kind === 'model').length;
  const toolCount = operations.length - modelCount;
  checkCalls(state, 'model', modelCount); checkCalls(state, 'tool', toolCount);
  const bundleId = crypto.randomUUID();
  const bundle: BudgetBundle = state.budget.reserveBundle(operations.map((operation, index) => ({ id: `${state.id}/${bundleId}/${index}`, maxCostMicros: operation.maxCostMicros })));
  // No application callback, await, hook or logger occurs between the two ledger projections.
  for (const account of path) { account.heldModelCalls += modelCount; account.heldToolCalls += toolCount; }
  const entries = operations.map((operation, index): CallTicket => ({ ticket: bundle.tickets[index]!, kind: operation.kind, counted: false, cancelled: false }));
  let closed = false;
  const result: CallBundle = { entries, close: () => {
    if (closed) return;
    bundle.close();
    for (const entry of entries) if (!entry.counted) {
      for (const account of path) { if (entry.kind === 'model') account.heldModelCalls--; else account.heldToolCalls--; }
      entry.cancelled = true;
    }
    closed = true; state.bundles.delete(result);
  } };
  state.bundles.add(result); return result;
}

/** Only runtime-owned records reach this transition; model dispatch and tool attempts differ deliberately. */
function consumeCall(state: RunState, entry: CallTicket, kind: 'model'): Reservation;
function consumeCall(state: RunState, entry: CallTicket, kind: 'tool'): void;
function consumeCall(state: RunState, entry: CallTicket, kind: 'model' | 'tool'): Reservation | void {
  if (entry.kind !== kind || entry.counted || entry.cancelled) throw new MayuraError('CONFLICT', 'The runtime invocation was already consumed, cancelled or has the wrong kind.');
  const reservation = kind === 'model' ? entry.ticket.start() : undefined;
  for (const account of ancestors(state)) {
    if (kind === 'model') { account.heldModelCalls--; account.modelCalls++; }
    else { account.heldToolCalls--; account.toolCalls++; }
  }
  entry.counted = true; return reservation;
}

/** Process-local structured concurrency. No restart recovery or hard callback isolation is promised. */
export function createRuntime(options: RuntimeOptions): Runtime {
  if (options.profile !== 'ephemeral') throw new MayuraError('UNSUPPORTED_PROFILE', 'Only the explicit ephemeral profile is supported by this runtime.');
  const rootLimits = limitsFor(options.limits);
  const rootPermissions = permissionsFor(options.permissions);
  const suppliedScope = options.scope ?? { principalId: 'local', projectId: 'default' };
  if (!isIdentifier(suppliedScope.principalId) || !isIdentifier(suppliedScope.projectId)) {
    throw new MayuraError('INVALID_CONFIG', 'Scope requires bounded principal and project identifiers.');
  }
  const scope: Scope = Object.freeze({ principalId: suppliedScope.principalId, projectId: suppliedScope.projectId });
  const active = new Map<string, RunHandle<unknown>>();
  const states = new WeakMap<object, RunState>();
  const operations = new OperationPermits(rootLimits.maxConcurrentOperations, Math.min(65536, rootLimits.maxConcurrentRuns * (rootLimits.maxDescendantRuns + 1)));
  let activeRoots = 0;
  let closed = false;
  const lookup = (handle: RunHandle<unknown>): RunState => {
    const state = states.get(handle);
    if (!state) throw new MayuraError('PERMISSION_DENIED', 'A genuine handle from this runtime is required.');
    return state;
  };
  const admitChild = <I extends Schema, O extends Schema>(
    parent: RunState, agent: AgentDefinition<I, O>, input: unknown, child: ChildOptions, inputAdmitted = false, signal?: AbortSignal,
  ): RunHandle<InferOutput<O>> => {
    if (Date.now() >= parent.deadline && !parent.controller.signal.aborted) parent.controller.abort(new MayuraError('TIMEOUT', 'The parent deadline elapsed.'));
    if (closed || !parent.accepting || parent.status !== 'running' || parent.controller.signal.aborted || signal?.aborted) {
      throw new MayuraError('CONFLICT', 'The parent no longer accepts child execution.');
    }
    assertAgent(agent);
    if (!parent.permissions.allow.includes('agent:delegate')) throw new MayuraError('PERMISSION_DENIED', 'Child delegation is not authorized.');
    const path = ancestors(parent);
    if (path.some((item) => item.agent === agent || item.agent.id === agent.id)) throw new MayuraError('CONFLICT', 'Recursive agent ancestry is not supported.');
    if (path.some((item) => item.descendants >= item.limits.maxDescendantRuns) || parent.depth + 1 > parent.limits.maxDepth) {
      throw new MayuraError('LIMIT_EXCEEDED', 'The descendant or depth limit was reached.');
    }
    const limits = limitsFor({ ...parent.limits, ...child.limits });
    if (limits.maxConcurrentRuns !== parent.limits.maxConcurrentRuns) throw new MayuraError('INVALID_CONFIG', 'maxConcurrentRuns controls root admission only.');
    if (parent.depth + 1 > limits.maxDepth) throw new MayuraError('LIMIT_EXCEEDED', 'The child depth ceiling was reached.');
    if (Object.entries(limits).some(([key, value]) => value > parent.limits[key as keyof RuntimeLimits])) {
      throw new MayuraError('INVALID_CONFIG', 'Child limits cannot exceed parent ceilings.');
    }
    const requested = permissionsFor(child.permissions, true);
    const permissions = permissionsFor({ allow: requested.allow.filter((grant) => parent.permissions.allow.includes(grant)) });
    return start(agent, input, limits, permissions, parent, inputAdmitted, signal);
  };

  const start = <I extends Schema, O extends Schema>(
    agent: AgentDefinition<I, O>, suppliedInput: unknown, limits: Required<RuntimeLimits>, permissions: Permissions,
    parent?: RunState, inputAdmitted = false, externalSignal?: AbortSignal,
  ): RunHandle<InferOutput<O>> => {
    if (closed) throw new MayuraError('CONFLICT', 'Runtime is closed and cannot accept new runs.');
    assertAgent(agent);
    if (!parent && activeRoots >= rootLimits.maxConcurrentRuns) throw new MayuraError('LIMIT_EXCEEDED', 'The runtime concurrent-root limit is reached.');
    let input: JsonValue;
    try { input = freezeJson(jsonValue(suppliedInput, { maxBytes: limits.maxInputBytes })); }
    catch { throw new MayuraError('INVALID_INPUT', 'Submitted input must satisfy the JSON and size limits.'); }
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const events = new EventBuffer(id, limits.maxEventRetention);
    const budget = parent ? parent.budget.fork({ id, maxCostMicros: limits.maxCostMicros, maxCalls: limits.maxModelCalls + limits.maxToolCalls })
      : new Budget(limits.maxCostMicros, limits.maxModelCalls + limits.maxToolCalls);
    const grants = new Set(permissions.allow);
    const tools = new Map(agent.tools.map((tool) => [tool.id, tool]));
    const callIds = new Set<string>();
    let terminal = false;
    let settle!: (result: Outcome<InferOutput<O>>) => void;
    const result = new Promise<Outcome<InferOutput<O>>>((resolve) => { settle = resolve; });
    const deadline = Math.min(Date.now() + limits.maxDurationMs, parent?.deadline ?? Infinity);
    const timer = setTimeout(() => {
      if (!terminal) controller.abort(new MayuraError('TIMEOUT', 'The run deadline elapsed; no new work will be dispatched.'));
    }, Math.max(0, deadline - Date.now()));
    const handle: RunHandle<InferOutput<O>> = Object.freeze({
      id, profile: 'ephemeral', result: () => result,
      observe: (observerOptions?: { readonly after?: number; readonly signal?: AbortSignal }) => events.observe(observerOptions),
      cancel: () => { if (!terminal && !controller.signal.aborted) controller.abort(new MayuraError('CANCELLED', 'Run cancellation was requested.')); },
    });
    const runOperations = (parent?.operations ?? operations).fork(limits.maxConcurrentOperations);
    const state = { id, agent, parent, depth: parent ? parent.depth + 1 : 0, deadline, limits, permissions, budget, operations: runOperations, controller,
      handle, children: [], receipts: new Map(), accepting: true, status: 'running', descendants: 0, modelCalls: 0, toolCalls: 0,
      heldModelCalls: 0, heldToolCalls: 0, bundles: new Set() } as unknown as RunState;
    Object.defineProperty(state, 'root', { value: parent?.root ?? state });
    const relayParent = (): void => { if (!controller.signal.aborted) controller.abort(parent?.controller.signal.reason); };
    const relayExternal = (): void => { if (!controller.signal.aborted) controller.abort(new MayuraError('CANCELLED', 'The composing invocation was cancelled.')); };
    parent?.controller.signal.addEventListener('abort', relayParent, { once: true });
    externalSignal?.addEventListener('abort', relayExternal, { once: true });
    if (parent?.controller.signal.aborted) relayParent();
    if (externalSignal?.aborted) relayExternal();
    // Closing admissions never releases unknown charges; callback settlement remains valid.
    controller.signal.addEventListener('abort', () => {
      state.accepting = false; budget.close(); for (const bundle of state.bundles) bundle.close();
    }, { once: true });
    if (parent) { parent.children.push(state); for (const item of ancestors(parent)) item.descendants++; }
    else activeRoots++;
    states.set(handle, state);
    active.set(id, handle);
    const checkCancelled = (): void => {
      if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new MayuraError('TIMEOUT', 'The run deadline elapsed.'));
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const managed = (checks: readonly AgentGuard[]) => checks.flatMap(check => {
      const descriptor = readManagedGuardDefinition(check);
      return descriptor ? [{ handle: check as ManagedGuardDefinition, descriptor }] : [];
    });
    const requiredChecks = (checks: readonly AgentGuard[]) => {
      const definitions = managed(checks);
      for (const { descriptor } of definitions) if (!grants.has(`model:${descriptor.model.id}`)) {
        throw new MayuraError('PERMISSION_DENIED', 'A required managed guard model destination is not authorized.');
      }
      return definitions;
    };
    const operationBundle = (kind: 'model' | 'tool', maxCostMicros: number): CallBundle => {
      const definitions = requiredChecks(agent.guards.output);
      return reserveCalls(state, [{ kind, maxCostMicros }, ...definitions.map(({ descriptor }) => ({ kind: 'model' as const, maxCostMicros: descriptor.model.maxCostMicros }))]);
    };
    const guard = async (checks: readonly AgentGuard[], value: JsonValue, boundary: 'input' | 'output', callId: string, held?: readonly CallTicket[]): Promise<void> => {
      const definitions = managed(checks);
      const local = checks.filter(check => !readManagedGuardDefinition(check)) as readonly Guard[];
      const verdicts = await cancellable(() => Promise.all(local.map(check => runOperations.run(controller.signal, async () => {
        try {
          const verdict = await check.check(value, Object.freeze({ runId: id, callId, scope, signal: controller.signal, boundary }));
          const decision = verdict?.decision;
          if (decision !== 'allow' && decision !== 'block') throw new Error();
          // Read adapter-owned properties inside the redaction boundary; do not retain a mutable verdict.
          return decision;
        }
        catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A required guard could not complete its check.'); }
      }))), controller.signal);
      if (verdicts.some((decision) => decision !== 'allow')) {
        throw new MayuraError('GUARD_BLOCKED', 'A required guard withheld this content.');
      }
      if (definitions.length === 0) return;
      checkCancelled(); requiredChecks(checks);
      const owned = held === undefined ? reserveCalls(state, definitions.map(({ descriptor }) => ({ kind: 'model' as const, maxCostMicros: descriptor.model.maxCostMicros }))) : undefined;
      const entries = held ?? owned!.entries;
      try {
        if (entries.length !== definitions.length) throw new MayuraError('CONFLICT', 'Required guard reservations do not match this barrier.');
        const results = await cancellable(() => Promise.allSettled(definitions.map(({ descriptor }, index) => {
          const entry = entries[index]!;
          const metadata = { purpose: 'guardrail', modelId: descriptor.model.id, checkId: descriptor.id, checkVersion: descriptor.version, boundary, callId } as const;
          return evaluateManagedGuard({ descriptor, candidate: value,
            context: Object.freeze({ runId: id, callId, scope, signal: controller.signal, boundary }), limits, operations: runOperations,
            assertActive: checkCancelled,
            start: () => {
              checkCancelled();
              if (!grants.has(`model:${descriptor.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The managed guard model destination is not authorized.');
              return consumeCall(state, entry, 'model');
            },
            onStarted: () => { events.emit('model.started', { ...metadata, modelCall: state.modelCalls }); },
            onCompleted: (decision: 'allow' | 'block') => { events.emit('model.completed', { ...metadata, response: 'final', decision }); },
          });
        })), controller.signal);
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        checkCancelled();
      } finally { owned?.close(); }
    };

    const preflight = async (tool: AnyTool, rawInput: JsonValue): Promise<void> => {
      const required = [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
      if (required.some((grant) => !grants.has(grant))) throw new MayuraError('PERMISSION_DENIED', 'The requested tool is not authorized.');
      await cancellable(() => validate(tool.input, rawInput, 'input', { maxBytes: limits.maxInputBytes }), controller.signal);
    };

    const execute = async (): Promise<Outcome<InferOutput<O>>> => {
      events.emit('run.started', { profile: 'ephemeral', rootId: state.root.id, agentId: agent.id, ...(parent ? { parentId: parent.id } : {}) });
      checkCancelled();
      const validated = await cancellable(() => inputAdmitted ? input : validate(agent.input, input, 'input', { maxBytes: limits.maxInputBytes }), controller.signal);
      const approvedInput = freezeJson(jsonValue(validated, { maxBytes: limits.maxInputBytes }));
      await guard(agent.guards.input, approvedInput, 'input', 'input');
      const messages: ModelMessage[] = [{ role: 'user', content: approvedInput }];
      let continuation: JsonValue | undefined;
      for (let step = 0; step < limits.maxSteps; step++) {
        checkCancelled();
        if (!grants.has(`model:${agent.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The model adapter is not authorized.');
        checkCalls(state, 'model', 1);
        // Freeze a bounded copy: a provider cannot mutate history or the tool registry between checks.
        const snapshot = freezeJson(jsonValue(messages, { maxBytes: limits.maxContextBytes })) as unknown as readonly ModelMessage[];
        const modelTools = agent.tools.map((tool) => Object.freeze({ id: tool.id, description: tool.description,
          ...(tool.inputJsonSchema === undefined ? {} : { inputJsonSchema: freezeJson(jsonValue(tool.inputJsonSchema)) as typeof tool.inputJsonSchema }),
        }));
        const requestData = freezeJson(jsonValue({ instructions: agent.instructions, messages: snapshot, tools: modelTools, ...(continuation === undefined ? {} : { continuation }) }, { maxBytes: limits.maxContextBytes })) as unknown as Omit<ModelRequest, 'signal' | 'maxOutputTokens'>;
        const primaryBundle = operationBundle('model', agent.model.maxCostMicros);
        try {
          const rawResponse = await cancellable(() => runOperations.run(controller.signal, async () => {
            checkCancelled();
            const reservation = consumeCall(state, primaryBundle.entries[0]!, 'model');
            events.emit('model.started', { step, modelCall: state.modelCalls });
            let raw;
            try { raw = await agent.model.generate(Object.freeze({ ...requestData, signal: controller.signal, maxOutputTokens: limits.maxOutputTokens })); }
            catch (error) {
              const cost = modelFailureCost(error);
              if (cost !== undefined) reservation.settle(cost);
              throw new MayuraError('MODEL_FAILED', 'The model adapter failed to produce a response.');
            }
            // Account independently validated usage even when the content envelope is malformed.
            // The callback may complete after cooperative cancellation; it cannot re-open disclosure.
            reservation.settle(modelCost(raw));
            return raw;
          }), controller.signal);
          checkCancelled();
          const response = modelResponse(rawResponse, limits.maxOutputBytes, limits.maxToolCalls);
          continuation = response.continuation === undefined ? undefined : freezeJson(jsonValue(response.continuation, { maxBytes: limits.maxContextBytes }));
          events.emit('model.completed', { step, response: response.type });
          if (response.type === 'final') {
            const output = await cancellable(() => validate(agent.output, response.output, 'output', { maxBytes: limits.maxOutputBytes }), controller.signal);
            const approvedOutput = freezeJson(jsonValue(output, { maxBytes: limits.maxOutputBytes }));
            await guard(agent.guards.output, approvedOutput, 'output', `model.${state.modelCalls}`, primaryBundle.entries.slice(1));
            checkCancelled();
            return Object.freeze({ status: 'succeeded' as const, output: approvedOutput as InferOutput<O> });
          }
          // A validated tool proposal has no final candidate; these holds cannot fund a later invocation.
          primaryBundle.close();
          checkCalls(state, 'tool', response.calls.length);
          // Preflight every proposed grant/schema/identity before the first effect. Money/call
          // holds are per dispatch and include its required checks, not every future batch member.
          let batchCost = 0;
          for (const call of response.calls) {
            if (callIds.has(call.id)) throw new MayuraError('CONFLICT', 'Tool call identifiers must be unique within a run.');
            const tool = tools.get(call.toolId);
            if (!tool) throw new MayuraError('NOT_FOUND', 'The model requested an unregistered tool.');
            await preflight(tool, call.input);
            batchCost += tool.costMicros;
            if (!Number.isSafeInteger(batchCost)) throw new MayuraError('BUDGET_EXCEEDED', 'Tool batch cost exceeds supported accounting bounds.');
          }
          const ledger = budget.snapshot();
          if (typeof ledger.spentMicros !== 'number' || batchCost > limits.maxCostMicros - ledger.spentMicros - ledger.reservedMicros) {
            throw new MayuraError('BUDGET_EXCEEDED', 'The complete tool batch cannot be admitted within the budget.');
          }
          for (const call of response.calls) callIds.add(call.id);
          messages.push({ role: 'assistant', calls: response.calls });
          for (const call of response.calls) {
            checkCancelled();
            const tool = tools.get(call.toolId)!;
            const toolBundle = operationBundle('tool', tool.costMicros);
            try {
              consumeCall(state, toolBundle.entries[0]!, 'tool');
              events.emit('tool.started', { callId: call.id, toolId: call.toolId });
              let outcome = await invokeTool(tool, call.input, {
                runId: id, callId: call.id, scope, signal: controller.signal, permissions, budget,
                budgetBinding: bindToolBudgetTicket(tool, toolBundle.entries[0]!.ticket, { budget, runId: id, callId: call.id, scope, signal: controller.signal }),
                maxOutputBytes: limits.maxOutputBytes,
                onExecutionReceipt: async (receipt) => { record(state, receipt); },
                ...(isAgentTool(tools.get(call.toolId)!) ? {
                  contextBindings: [childGateway.bind(Object.freeze({
                    spawn: (childAgent: AgentDefinition, childInput: unknown, childOptions: ChildOptions, signal: AbortSignal) =>
                      admitChild(state, childAgent, childInput, childOptions, true, signal),
                  }))],
                } : { acquireExecution: (signal: AbortSignal) => runOperations.acquire(signal) }),
              });
              if (outcome.receipt) record(state, outcome.receipt);
              if (outcome.status === 'cancelled' && controller.signal.aborted && controller.signal.reason instanceof MayuraError && controller.signal.reason.code === 'TIMEOUT') {
                outcome = { ...outcome, status: 'failed', error: publicError(controller.signal.reason) };
              }
              if (outcome.status !== 'succeeded') {
                events.emit('tool.completed', { callId: call.id, toolId: call.toolId, status: outcome.status,
                  ...(outcome.receipt ? { execution: outcome.receipt.execution, disclosure: outcome.receipt.disclosure } : {}),
                });
                return outcome;
              }
              const toolOutput = freezeJson(jsonValue(outcome.output, { maxBytes: limits.maxOutputBytes }));
              try { await guard(agent.guards.output, toolOutput, 'output', call.id, toolBundle.entries.slice(1)); }
              catch (error) {
                const blocked = outcomeFor(error);
                events.emit('tool.completed', { callId: call.id, toolId: call.toolId, status: blocked.status, execution: 'succeeded', disclosure: 'withheld' });
                const receipt = outcome.receipt ? Object.freeze({ ...outcome.receipt, disclosure: 'withheld' as const }) : undefined;
                if (receipt) record(state, receipt);
                return { ...blocked, ...(receipt ? { receipt } : {}) };
              }
              events.emit('tool.completed', { callId: call.id, toolId: call.toolId, status: outcome.status, execution: 'succeeded', disclosure: 'released' });
              messages.push({ role: 'tool', callId: call.id, toolId: call.toolId, result: toolOutput });
            } finally { toolBundle.close(); }
          }
        } finally { primaryBundle.close(); }
      }
      throw new MayuraError('LIMIT_EXCEEDED', 'The agent step limit was reached.');
    };


    queueMicrotask(() => {
      void execute().catch(outcomeFor).then(async (candidate) => {
        state.accepting = false;
        // Accepted descendants remain required even if the parent's model has already finished.
        if (candidate.status !== 'succeeded' && !controller.signal.aborted) {
          controller.abort(new MayuraError('CANCELLED', 'Parent execution ended before its required children.'));
        }
        const children = await Promise.all(state.children.map((child) => child.handle.result()));
        let outcome: Outcome<InferOutput<O>> = candidate;
        if (outcome.status === 'succeeded' && controller.signal.aborted) outcome = outcomeFor(controller.signal.reason);
        const unknown = children.find((child) => child.status === 'outcome_unknown');
        const failed = children.find((child) => child.status !== 'succeeded');
        if (unknown) outcome = unknown;
        else if (failed && (outcome.status === 'succeeded' || outcome.error.code === 'TOOL_FAILED')) outcome = failed;
        if (state.children.length > 0) outcome = { ...outcome, evidence: evidenceFor(state) };
        terminal = true;
        state.status = outcome.status;
        for (const bundle of state.bundles) bundle.close();
        budget.close();
        clearTimeout(timer);
        parent?.controller.signal.removeEventListener('abort', relayParent);
        externalSignal?.removeEventListener('abort', relayExternal);
        events.emit('run.completed', { status: outcome.status, ...budget.snapshot() });
        events.finish();
        active.delete(id);
        if (!parent) activeRoots--;
        settle(Object.freeze(outcome));
      });
    });
    return handle;
  };
  return Object.freeze({
    profile: 'ephemeral',
    submit: <I extends Schema, O extends Schema>(agent: AgentDefinition<I, O>, submission: { readonly input: InferInput<I> }) =>
      start(agent, submission.input, rootLimits, rootPermissions),
    spawn: <I extends Schema, O extends Schema>(parent: RunHandle<unknown>, agent: AgentDefinition<I, O>, submission: ChildOptions & { readonly input: InferInput<I> }) =>
      admitChild(lookup(parent), agent, submission.input, submission),
    inspect: (handle: RunHandle<unknown>): RunInspection => {
      const state = lookup(handle);
      return Object.freeze({ id: state.id, rootId: state.root.id, ...(state.parent ? { parentId: state.parent.id } : {}),
        agentId: state.agent.id, status: state.status, budget: state.budget.snapshot(),
        runs: Object.freeze(subtree(state).map((run) => Object.freeze({ id: run.id, ...(run.parent ? { parentId: run.parent.id } : {}), agentId: run.agent.id, status: run.status }))),
        evidence: evidenceFor(state),
      });
    },
    close: async (): Promise<void> => {
      closed = true;
      const runs = [...active.values()];
      for (const run of runs) run.cancel();
      await Promise.all(runs.map((run) => run.result()));
    },
  });
}
