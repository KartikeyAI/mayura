import { restoreHandoff, sameHandoffOutput } from './handoffs.js';
import {
  assertPositiveInteger, Budget, freezeJson, jsonValue, MayuraError, publicError, validate,
  type Authorizer, type AuthorizationResourceKind, type BudgetTicket, type BudgetBundle, type Reservation, type ManagedGuardDefinition, type ExecutionEvidence, type ExecutionReceipt, type Guard, type InferInput, type InferOutput, type JsonValue, type ModelMessage, type ModelRequest, type ModelToolCall,
  type JsonObject, type Outcome, type Permissions, type RunHandle, type Schema, type Scope, type Media, mediaSummary,
} from '@mayura/core';
import { admitMedia, readManagedGuardDefinition, sha256Hex } from '@mayura/core/host';
import { invokeTool, type AnyTool, type ToolOutcome } from '@mayura/tools';
import { prepareToolInput, bindPreparedToolInput, toolContinuation, bindToolApproval, bindToolBudgetTicket, toolNeedsApproval, type ToolApprovalBinding } from '@mayura/tools/host';
import { handoffTools, assertAgent, isIdentifier, type AgentDefinition, type AgentGuard } from './agent.js';
import { EventBuffer } from './event-buffer.js';
import type { RunRecorder, RunRecording, RecordedApproval } from './recording.js';
import { admitRunHistory, type RunHistory } from './history.js';
import { agentDigest, checkpointOptions, decodeBody, encodeBody, scopeKey, type CheckpointBody, type CheckpointOptions } from './checkpoint.js';
import { modelCost, modelFailure as publicModelFailure, modelFailureCost, modelResponse } from './response.js';
import { createBatcher, createFieldExtractor } from './stream.js';
import { childGateway, isAgentTool, type ChildOptions } from './composition.js';
import { OperationPermits } from './permits.js';
import { evaluateManagedGuard } from './managed-guards.js';
import { readHookDefinition, type ControlHookStage, type HookEvent, type HookEvents, type TerminalHookStage } from './hooks.js';
import { evaluateHook, evaluateObserver } from './hook-execution.js';

/** All bounds are finite; model/token/cost declarations do not turn trusted callbacks into a sandbox. */
/** A model id observability may carry: a bounded stable identifier, as run event metadata requires. */
const stableModelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export interface RuntimeLimits {
  readonly maxSteps?: number;
  /** Transfers within one root run; zero disables handoffs, default eight, maximum 64. */
  readonly maxHandoffs?: number;
  readonly maxModelCalls?: number;
  readonly maxToolCalls?: number;
  /** Actual required lifecycle callback admissions, separate from model/tool charges. */
  readonly maxHookCalls?: number;
  readonly maxDurationMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxContextBytes?: number;
  /** All media in one run (with the input and from tools), in bytes. Counted apart from the JSON context. */
  readonly maxMediaBytes?: number;
  readonly maxOutputTokens?: number;
  readonly maxCostMicros?: number;
  readonly maxEventRetention?: number;
  /** Concurrent root admissions; descendants have separate bounded capacity. */
  readonly maxConcurrentRuns?: number;
  readonly maxDescendantRuns?: number;
  readonly maxDepth?: number;
  readonly maxConcurrentOperations?: number;
}
export interface SpeculationBranch<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly agent: AgentDefinition<I, O>;
  readonly input: InferInput<I>;
  readonly permissions: Permissions;
  readonly limits?: RuntimeLimits;
  /** The assumptions this branch depends on; their digest is recorded and passed to `verify`. */
  readonly assumptions: JsonValue;
}
export interface SpeculationOptions<I extends Schema, O extends Schema> {
  /** 1–8 branches with unique ids. */
  readonly branches: readonly SpeculationBranch<I, O>[];
  /** Re-check current inputs, scope and policy before promotion. Only an exact `true` promotes; errors and timeouts do not. */
  readonly verify: (candidate: { readonly branchId: string; readonly assumptionsDigest: string; readonly output: InferOutput<O> }) => boolean | Promise<boolean>;
  /** Deadline for each `verify` call (default 5000 ms, maximum 30000). */
  readonly verifyTimeoutMs?: number;
}
export interface SpeculationResult<T> {
  readonly status: 'promoted' | 'none';
  readonly branchId?: string;
  readonly output?: T;
  readonly assumptionsDigest?: string;
  readonly branches: readonly { readonly id: string; readonly runId: string; readonly status: Outcome<unknown>['status']; readonly assumptionsDigest: string; readonly verified: boolean }[];
}

/** When a person must approve a tool call before it runs, and how long a request waits for them. */
export interface ApprovalOptions {
  /** Tool ids whose every call needs approval, in addition to tools that declare `approval` themselves. */
  readonly tools?: readonly string[];
  /** How long a request waits for an answer (default 15 minutes, at most 7 days). Waiting does not count against `maxDurationMs`. */
  readonly expiresInMs?: number;
  /** What an unanswered request does when it expires: tell the model it was not approved (default), or cancel the run. */
  readonly onExpired?: 'reject' | 'cancel';
}
/** A person's answer to a pending approval. `digest` is the one in `approval.requested` and the run's inspection. */
export interface ApprovalAnswer {
  readonly callId: string;
  readonly digest: string;
  readonly decision: 'approved' | 'rejected';
  /** Who answered, as a stable identifier; it appears in the `approval.resolved` event. */
  readonly actorId: string;
  /** Why, for a rejection: the model sees it with the refusal (at most 1,000 characters). */
  readonly reason?: string;
}
/** The tool call a waiting run asks a person to approve: exactly what will run if it is approved. */
export interface PendingApproval {
  readonly callId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: JsonValue;
  readonly digest: string;
  readonly expiresAtMs: number;
}

export interface RuntimeOptions {
  /** Optional host-owned core enforcement and audit boundary, shared across root, child and handed-off agents. */
  readonly authorization?: Authorizer;
  readonly profile: 'ephemeral';
  readonly permissions?: Permissions;
  readonly scope?: Scope;
  readonly limits?: RuntimeLimits;
  /** Calls that need a person's approval before they run, beyond the tools that declare it. */
  readonly approvals?: ApprovalOptions;
  /**
   * Save runs that wait for approval in a store, so they survive a restart and any runtime with the same store, scope
   * and agent can approve and resume them. Without it, a waiting run lives in this process's memory.
   */
  readonly checkpoints?: CheckpointOptions;
  /** Record bound submissions before execution and on completion, including after a restart. */
  readonly recorder?: RunRecorder;
}
export interface Runtime {
  readonly profile: 'ephemeral';
  /** Host recorder configured for bound submissions. */
  readonly recorder?: RunRecorder;
  /**
   * Start a run. `media` holds images or PDFs for the model to see with the input; the agent must accept them
   * (`defineAgent({ media })`), and they are checked against its limits before the run starts. `history` is the
   * conversation before this run, oldest first and in whole turns; it is sent before the input, counts toward
   * `limits.maxContextBytes`, and when nonempty needs a model adapter that declares `capabilities.history`.
   * A fitted `RunHistory` object adds counts-only event metadata; only its messages reach the model.
   */
  submit<I extends Schema, O extends Schema>(agent: AgentDefinition<I, O>, options: {
    readonly input: InferInput<I>; readonly media?: readonly Media[]; readonly history?: RunHistory;
    /** Identifier-only association saved in checkpoints and passed to the host recorder. */
    readonly recording?: JsonObject;
  }): RunHandle<InferOutput<O>>;
  spawn<I extends Schema, O extends Schema>(parent: RunHandle<unknown>, agent: AgentDefinition<I, O>, options: ChildOptions & { readonly input: InferInput<I>; readonly media?: readonly Media[] }): RunHandle<InferOutput<O>>;
  inspect(handle: RunHandle<unknown>): RunInspection;
  /**
   * A run's conversation so far, in order: its input as the model saw it (after input guards), its tool calls, and the
   * tool results released to the model. A history given to the run is not included, nor a final output (that is the
   * outcome). It holds content, so keep it to trusted code, as you would the outcome.
   */
  transcript(handle: RunHandle<unknown>): readonly ModelMessage[];
  /**
   * Answer the approval a waiting run asks for, by its handle or id. The answer must name the pending call and its exact
   * digest, before the request expires. Approved, the call runs; rejected, the model is told and carries on.
   */
  approve(run: RunHandle<unknown> | string, answer: ApprovalAnswer): Promise<RunHandle<unknown>>;
  /** Publish or resume a checkpointed external result wait. Never accepts browser data or replays completed work. */
  resumeTool(runId: string, input: { readonly callId: string; readonly digest: string }): Promise<RunHandle<unknown> | undefined>;
  /** Handle exactly one saved approval; hosts must observe/persist a returned resumed run. */
  expireApproval(runId: string): Promise<{ readonly status: 'not_due' } | { readonly status: 'cancelled' } | { readonly status: 'resumed'; readonly run: RunHandle<unknown> }>;
  /**
   * With `checkpoints`: resume this scope's saved runs whose approval request expired, as their policy says (the model
   * is told, or the run is cancelled). A runtime does this itself for runs it paused while it lives; call this
   * periodically to handle the rest, for example after a restart. Returns how many runs it handled.
   */
  expireApprovals(options?: { readonly limit?: number }): Promise<number>;
  /** Retry a failed terminal recording without rerunning the model or tools. The handle belongs to this runtime. */
  retryRecording(handle: RunHandle<unknown>): Promise<void>;
  /** Cancel this scope's persisted approval wait without dispatching its pending tool. */
  cancelSaved(runId: string): Promise<void>;
  /**
   * Run isolated speculative child branches under the parent's shared budget and promote at most one. Branches may
   * not hold write, host, delegation or memory-mutation grants; losing and unverified branches are cancelled.
   */
  speculate<I extends Schema, O extends Schema>(parent: RunHandle<unknown>, options: SpeculationOptions<I, O>): Promise<SpeculationResult<InferOutput<O>>>;
  /** Stop admissions, request cancellation, and wait for accepted runs to reach a terminal outcome. */
  close(): Promise<void>;
}

const defaults: Required<RuntimeLimits> = Object.freeze({
  maxSteps: 16, maxHandoffs: 8, maxModelCalls: 16, maxToolCalls: 64, maxHookCalls: 128, maxDurationMs: 60_000,
  maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576, maxContextBytes: 2_097_152, maxMediaBytes: 20_971_520,
  maxOutputTokens: 4_096, maxCostMicros: 0, maxEventRetention: 256, maxConcurrentRuns: 32,
  maxDescendantRuns: 64, maxDepth: 8, maxConcurrentOperations: 32,
});

function limitsFor(options: RuntimeLimits | undefined): Required<RuntimeLimits> {
  const result = { ...defaults, ...options };
  if (Object.keys(result).some((key) => !(key in defaults))) throw new MayuraError('INVALID_CONFIG', 'Unknown runtime limit.');
  for (const [key, value] of Object.entries(result)) {
    // Zero is meaningful for cost and tool calls (an agent with no tools makes none); every other limit is positive.
    if (key === 'maxCostMicros' || key === 'maxToolCalls' || key === 'maxHandoffs') {
      if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', `${key} must be a non-negative safe integer.`);
    } else assertPositiveInteger(value, key);
  }
  if (result.maxDurationMs > 2_147_483_647 || !Number.isSafeInteger(result.maxModelCalls + result.maxToolCalls)) {
    throw new MayuraError('INVALID_CONFIG', 'Runtime limits exceed the supported counter or timer range.');
  }
  if (result.maxHandoffs > 64 || result.maxDepth > 32 || result.maxDescendantRuns > 1023 || result.maxConcurrentOperations > 1024
    || result.maxConcurrentRuns > 1024 || result.maxModelCalls > 4096 || result.maxToolCalls > 4096 || result.maxHookCalls > 4096
    || result.maxMediaBytes > 268_435_456) {
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


/** A run is `waiting` while it waits for a person to approve a tool call. */
export type RunStatus = 'running' | 'waiting' | Outcome<unknown>['status'];
export interface RunInspection {
  readonly id: string;
  readonly rootId: string;
  readonly parentId?: string;
  readonly agentId: string;
  readonly status: RunStatus;
  /** The call a waiting run asks a person to approve. */
  readonly approval?: PendingApproval;
  /** Durable external-result wait, never a human approval request. */
  readonly toolWait?: PendingApproval;
  readonly budget: ReturnType<Budget['snapshot']>;
  readonly runs: readonly { readonly id: string; readonly parentId?: string; readonly agentId: string; readonly status: RunStatus }[];
  readonly evidence: readonly ExecutionEvidence[];
}
type Failure = Exclude<Outcome<never>, { readonly status: 'succeeded' }>;
interface ObserveOptions { readonly signal?: AbortSignal; readonly terminal?: boolean }
interface RunState {
  readonly id: string;
  readonly events: EventBuffer;
  /** This run's awaited control hooks; also used by children for beforeDelegate. */
  control(event: HookEvent, step: number | null, signal?: AbortSignal): Promise<Failure | undefined>;
  /** This run's observers; a mandatory failure is returned, never thrown. Also used by children for afterDelegate. */
  observe(event: HookEvent, step: number | null, options?: ObserveOptions): Promise<Failure | undefined>;
  readonly agent: AgentDefinition;
  readonly originAgent: AgentDefinition;
  readonly parent: RunState | undefined;
  readonly root: RunState;
  readonly depth: number;
  /** Moves later after a wait for approval: waiting does not count against maxDurationMs. */
  deadline: number;
  readonly limits: Required<RuntimeLimits>;
  readonly permissions: Permissions;
  readonly budget: Budget;
  readonly operations: OperationPermits;
  readonly controller: AbortController;
  readonly handle: RunHandle<unknown>;
  readonly children: RunState[];
  /** A speculative branch: awaited by its parent, but its failure or cancellation never becomes the parent's outcome. */
  readonly speculative: boolean;
  readonly receipts: Map<string, ExecutionReceipt>;
  accepting: boolean;
  status: RunStatus;
  readonly recording?: JsonObject;
  /** The pending approval while the run waits in memory, with the function that answers it. */
  approval: (PendingApproval & { answer(answer: Answered): void }) | undefined;
  /** The saved checkpoint while the run is paused to the store; its process state is let go. */
  suspended: { readonly body: CheckpointBody; expiry?: ReturnType<typeof setTimeout> } | undefined;
  /** Continue a paused run of this process, answered. */
  resume(body: CheckpointBody, answer: Answered): void;
  /** End a paused run of this process without continuing it. */
  endSuspended(error: MayuraError): void;
  /** The run's budget, counting what it spent before a resume in another process. */
  budgetSnapshot(): ReturnType<Budget['snapshot']>;
  /** The run's conversation so far, without any history it was given. */
  transcript(): readonly ModelMessage[];
  descendants: number;
  modelCalls: number;
  toolCalls: number;
  hookCalls: number;
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

const violationBoundary: Record<ControlHookStage, HookEvents['onViolation']['boundary']> = {
  beforeExecution: 'execution', beforeStep: 'execution', beforeModelCall: 'model', beforeToolCall: 'tool', beforeDelegate: 'delegate', beforeOutputRelease: 'output',
};
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}
type Answered = { readonly decision: 'approved' | 'rejected' | 'expired'; readonly actorId?: string; readonly reason?: string };
const APPROVAL_DEFAULT_MS = 900_000;
const APPROVAL_MAX_MS = 604_800_000;
function approvalOptions(supplied: ApprovalOptions | undefined): { readonly tools: ReadonlySet<string>; readonly expiresInMs: number; readonly onExpired: 'reject' | 'cancel' } {
  if (supplied !== undefined && (typeof supplied !== 'object' || supplied === null || Object.keys(supplied).some(key => !['tools', 'expiresInMs', 'onExpired'].includes(key)))) {
    throw new MayuraError('INVALID_CONFIG', 'approvals takes only tools, expiresInMs and onExpired.');
  }
  const tools = supplied?.tools ?? []; const expiresInMs = supplied?.expiresInMs ?? APPROVAL_DEFAULT_MS; const onExpired = supplied?.onExpired ?? 'reject';
  if (!Array.isArray(tools) || tools.length > 256 || tools.some(tool => !isIdentifier(tool))) throw new MayuraError('INVALID_CONFIG', 'approvals.tools must be at most 256 tool ids.');
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1 || expiresInMs > APPROVAL_MAX_MS) throw new MayuraError('INVALID_CONFIG', `approvals.expiresInMs must be 1 to ${APPROVAL_MAX_MS} ms (7 days).`);
  if (onExpired !== 'reject' && onExpired !== 'cancel') throw new MayuraError('INVALID_CONFIG', "approvals.onExpired must be 'reject' or 'cancel'.");
  return Object.freeze({ tools: new Set(tools), expiresInMs, onExpired });
}
/** Binds an approval to exactly one call: this run, call, tool version, input, policy and expiry. */
function approvalDigest(fields: { runId: string; callId: string; toolId: string; toolVersion: string; input: JsonValue; policy: { onExpired: string }; expiresAtMs: number }): string {
  return sha256Hex(`mayura:run-approval:v1\0${canonicalJson(fields as unknown as JsonValue)}`);
}
/** Thrown to unwind a run that paused to the store: not an outcome, the run continues later. */
const SUSPENDED = Object.freeze({ suspended: true });
interface Resumption { readonly runId: string; readonly body: CheckpointBody; readonly answer: Answered }
function terminalView(stage: TerminalHookStage, outcome: Outcome<unknown>): HookEvent<TerminalHookStage> {
  return Object.freeze({ stage, status: outcome.status, ...(outcome.status === 'succeeded' ? {} : { error: Object.freeze({ code: outcome.error.code }) }) });
}

/** Process-local structured concurrency with optional approval checkpoints and trusted host recording. */
export function createRuntime(options: RuntimeOptions): Runtime {
  if (options.profile !== 'ephemeral') throw new MayuraError('UNSUPPORTED_PROFILE', 'Only the explicit ephemeral profile is supported by this runtime.');
  const rootLimits = limitsFor(options.limits);
  const rootPermissions = permissionsFor(options.permissions);
  const suppliedScope = options.scope ?? { principalId: 'local', projectId: 'default' };
  if (!isIdentifier(suppliedScope.principalId) || !isIdentifier(suppliedScope.projectId)) {
    throw new MayuraError('INVALID_CONFIG', 'Scope requires bounded principal and project identifiers.');
  }
  const scope: Scope = Object.freeze({ principalId: suppliedScope.principalId, projectId: suppliedScope.projectId });
  const approvalPolicy = approvalOptions(options.approvals);
  const authorization = options.authorization;
  if (authorization !== undefined && (!authorization || typeof authorization.authorize !== 'function')) throw new MayuraError('INVALID_CONFIG', 'Runtime authorization requires a core authorizer.');
  const evaluateAuthorization = authorization?.authorize.bind(authorization);
  const authorizationStop = new AbortController();
  const authorizationFailures = new WeakSet<object>();
  const executionDenied = (): MayuraError => {
    const error = new MayuraError('PERMISSION_DENIED', 'Runtime execution is not authorized.'); authorizationFailures.add(error); return error;
  };
  const requireAuthorization = async (kind: AuthorizationResourceKind, id: string, action: string, signal: AbortSignal = authorizationStop.signal): Promise<void> => {
    if (!evaluateAuthorization) return;
    if (signal.aborted || authorizationStop.signal.aborted) throw executionDenied();
    let allowed = false;
    try { allowed = (await evaluateAuthorization(scope, action, { kind, id, scope, ...(['run', 'thread'].includes(kind) ? { ownerId: scope.principalId } : {}) }, { signal })).effect === 'allow'; }
    catch { /* Policy diagnostics never enter run errors. Core authorizers emit the final decision audit. */ }
    if (!allowed || signal.aborted || authorizationStop.signal.aborted) throw executionDenied();
  };
  /** Only a verified host recording binding names the thread; answers and model input cannot supply one. */
  const authorizeRecording = async (binding: JsonObject | undefined, action: string, signal?: AbortSignal): Promise<void> => {
    if (typeof binding?.['threadId'] !== 'string') return;
    await requireAuthorization('thread', binding['threadId'], 'read', signal);
    await requireAuthorization('thread', binding['threadId'], action, signal);
  };
  const checkpoints = checkpointOptions(options.checkpoints);
  const recorder = options.recorder;
  const pendingRecordings = new WeakMap<RunHandle<unknown>, RunRecording>();
  if (recorder !== undefined && (!recorder || typeof recorder.begin !== 'function' || typeof recorder.complete !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'recorder requires begin and complete callbacks.');
  }
  const scopeId = scopeKey(scope);
  /** Runs this process paused to the store: no longer active, resumed in place when answered here. */
  const suspendedRuns = new Map<string, RunState>();
  const externalResumes = new Set<string>();
  const externalConsumptions = new WeakSet<CheckpointBody>();
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
    parent: RunState, agent: AgentDefinition<I, O>, input: unknown, child: ChildOptions, inputAdmitted = false, signal?: AbortSignal, speculative = false,
    media?: unknown,
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
    return start(agent, input, limits, permissions, parent, inputAdmitted, signal, speculative, media);
  };

  const start = <I extends Schema, O extends Schema>(
    agent: AgentDefinition<I, O>, suppliedInput: unknown, limits: Required<RuntimeLimits>, permissions: Permissions,
    parent?: RunState, inputAdmitted = false, externalSignal?: AbortSignal, speculative = false, suppliedMedia?: unknown, suppliedHistory?: unknown,
    resumption?: Resumption, suppliedRecording?: JsonObject,
  ): RunHandle<InferOutput<O>> => {
    if (closed) throw new MayuraError('CONFLICT', 'Runtime is closed and cannot accept new runs.');
    assertAgent(agent);
    const originAgent = agent;
    const sourcePermissions = permissions;
    const handoffPath: string[] = [...(resumption?.body.handoff?.path ?? [])];
    if (handoffPath.length > limits.maxHandoffs) throw new MayuraError('LIMIT_EXCEEDED', 'The saved handoff count exceeds this run ceiling.');
    if (resumption?.body.handoff) {
      const restored = restoreHandoff(originAgent, sourcePermissions, handoffPath, resumption.body.permissions);
      agent = restored.agent as AgentDefinition<I, O>; permissions = restored.permissions;
    }
    if (!parent && activeRoots >= rootLimits.maxConcurrentRuns) throw new MayuraError('LIMIT_EXCEEDED', 'The runtime concurrent-root limit is reached.');
    let input: JsonValue;
    try { input = freezeJson(jsonValue(suppliedInput, { maxBytes: limits.maxInputBytes })); }
    catch { throw new MayuraError('INVALID_INPUT', 'Submitted input must satisfy the JSON and size limits.'); }
    const runInput = input;
    // Media is checked and copied now, before the run exists: a refusal names what to change.
    const inputMedia = admitMedia(suppliedMedia ?? [], agent.media, limits.maxMediaBytes, 'INVALID_INPUT', `Agent ${agent.id}`);
    let mediaBytes = resumption?.body.mediaBytes ?? inputMedia.bytes;
    // History is checked and copied now too, and only sent to an adapter that takes it.
    const admittedHistory = suppliedHistory === undefined ? undefined : admitRunHistory(suppliedHistory, limits.maxContextBytes);
    const history = admittedHistory?.messages.length ? admittedHistory.messages : undefined;
    if (history && agent.model.capabilities.history !== true) {
      throw new MayuraError('INVALID_CONFIG', `Agent ${agent.id}'s model adapter does not take a conversation history (capabilities.history). Use a provider that does, or submit without history.`);
    }
    const recording = resumption?.body.recording ?? (suppliedRecording === undefined ? undefined
      : freezeJson(jsonValue(suppliedRecording, { maxBytes: 4096 })) as JsonObject);
    if (recording && !recorder) throw new MayuraError('INVALID_CONFIG', 'This run requires its configured recorder, including after a restart.');
    const recordedApprovals: RecordedApproval[] = [...(resumption?.body.approvals ?? [])];
    let recordingOpened = resumption !== undefined;
    const id = resumption?.runId ?? crypto.randomUUID();
    const controller = new AbortController();
    const events = new EventBuffer(id, limits.maxEventRetention);
    // A run resumed in another process gets a fresh account for what is left; reports add what it spent before.
    const before = resumption ? { micros: BigInt(resumption.body.spent.micros), calls: resumption.body.spent.calls } : { micros: 0n, calls: 0 };
    const maxCalls = limits.maxModelCalls + limits.maxToolCalls;
    const budget = parent ? parent.budget.fork({ id, maxCostMicros: limits.maxCostMicros, maxCalls })
      : resumption ? new Budget(Number(BigInt(limits.maxCostMicros) > before.micros ? BigInt(limits.maxCostMicros) - before.micros : 0n), Math.max(1, maxCalls - before.calls))
      : new Budget(limits.maxCostMicros, maxCalls);
    const budgetSnapshot = (): ReturnType<Budget['snapshot']> => {
      const now = budget.snapshot(); if (!resumption) return now;
      const micros = BigInt(now.spentMicros) + before.micros;
      return Object.freeze({ spentMicros: micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : micros.toString(), reservedMicros: now.reservedMicros, calls: now.calls + before.calls });
    };
    const grants = new Set(permissions.allow);
    const tools = new Map(agent.tools.map((tool) => [tool.id, tool]));
    const authorizeRun = async (signal: AbortSignal = controller.signal): Promise<void> => {
      if (authorization === undefined) return;
      if (!grants.has(`model:${agent.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The agent model requires an explicit capability.');
      await requireAuthorization('agent', agent.id, 'execute', signal);
      await requireAuthorization('run', id, 'execute', signal);
      await authorizeRecording(recording, 'append', signal);
      if (parent) await requireAuthorization('agent', agent.id, 'delegate', signal);
      for (const target of handoffPath) await requireAuthorization('agent', target, 'handoff', signal);
    };

    const callIds = new Set<string>(resumption?.body.callIds ?? []);
    // The conversation so far and the batch being run; module level so a pause can save them.
    let messages: ModelMessage[] = [];
    let continuation: JsonValue | undefined;
    let batch: { readonly step: number; readonly calls: readonly ModelToolCall[] } | undefined;
    let terminal = false;
    let settle!: (result: Outcome<InferOutput<O>>) => void;
    const result = new Promise<Outcome<InferOutput<O>>>((resolve) => { settle = resolve; });
    let deadline = Math.min(Date.now() + Math.min(limits.maxDurationMs, resumption?.body.remainingMs ?? Infinity), parent?.deadline ?? Infinity);
    const armDeadline = (): ReturnType<typeof setTimeout> => setTimeout(() => {
      if (!terminal) controller.abort(new MayuraError('TIMEOUT', 'The run deadline elapsed; no new work will be dispatched.'));
    }, Math.max(0, deadline - Date.now()));
    let timer = armDeadline();
    const handle: RunHandle<InferOutput<O>> = Object.freeze({
      id, profile: 'ephemeral', result: () => result,
      observe: (observerOptions?: { readonly after?: number; readonly signal?: AbortSignal }) => events.observe(observerOptions),
      cancel: () => {
        if (state.suspended) { void cancelSuspended(state); return; }
        if (!terminal && !controller.signal.aborted) controller.abort(new MayuraError('CANCELLED', 'Run cancellation was requested.'));
      },
    });
    const runOperations = (parent?.operations ?? operations).fork(limits.maxConcurrentOperations);
    const state = { id, events, agent, originAgent, parent, depth: parent ? parent.depth + 1 : 0, deadline, limits, permissions, budget, operations: runOperations, controller,
      handle, ...(recording ? { recording } : {}), children: [], speculative, receipts: new Map(), accepting: true, status: 'running', approval: undefined, suspended: undefined,
      descendants: resumption?.body.counts.descendants ?? 0, modelCalls: resumption?.body.counts.modelCalls ?? 0,
      toolCalls: resumption?.body.counts.toolCalls ?? 0, hookCalls: resumption?.body.counts.hookCalls ?? 0,
      heldModelCalls: 0, heldToolCalls: 0, bundles: new Set(), budgetSnapshot } as unknown as RunState;
    for (const receipt of resumption?.body.receipts ?? []) {
      const callId = (receipt as { callId?: unknown } | null)?.callId;
      if (typeof callId === 'string') state.receipts.set(callId, receipt as unknown as ExecutionReceipt);
    }
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
    if (parent) {
      parent.children.push(state); for (const item of ancestors(parent)) item.descendants++;
      parent.events.emit('delegate.started', { childRunId: id, childAgentId: agent.id });
    }
    else activeRoots++;
    states.set(handle, state);
    active.set(id, handle);
    const checkCancelled = (signal: AbortSignal = controller.signal): void => {
      if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new MayuraError('TIMEOUT', 'The run deadline elapsed.'));
      if (controller.signal.aborted) throw controller.signal.reason;
      if (signal.aborted) throw signal.reason;
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
    /** Runs the guards and returns the content to use: the original, or what local guards rewrote it to. */
    const guard = async (checks: readonly AgentGuard[], value: JsonValue, boundary: 'input' | 'output', callId: string, held?: readonly CallTicket[], signal: AbortSignal = controller.signal): Promise<JsonValue> => {
      try { return await guardChecks(checks, value, boundary, callId, held, signal); }
      catch (error) {
        if (error instanceof MayuraError && error.code === 'GUARD_BLOCKED') {
          await observe(Object.freeze({ stage: 'onViolation', source: 'guard', boundary, code: 'GUARD_BLOCKED', callId }), null, { signal });
        }
        throw error;
      }
    };
    /**
     * Guard `value`; if a guard rewrote it, validate the rewrite against `schema` again so a rewrite can never hand on a
     * value its boundary would have refused. Returns the frozen content to use.
     */
    const guarded = async (checks: readonly AgentGuard[], value: JsonValue, schema: Schema, boundary: 'input' | 'output', callId: string,
      maxBytes: number, held?: readonly CallTicket[], signal: AbortSignal = controller.signal): Promise<JsonValue> => {
      const result = await guard(checks, value, boundary, callId, held, signal);
      if (result === value) return value;
      const revalidated = await cancellable(() => runOperations.run(signal, async () => {
        checkCancelled(signal); return await validate(schema, result, boundary, { maxBytes });
      }), signal);
      return freezeJson(jsonValue(revalidated, { maxBytes }));
    };
    const guardChecks = async (checks: readonly AgentGuard[], value: JsonValue, boundary: 'input' | 'output', callId: string, held?: readonly CallTicket[], signal: AbortSignal = controller.signal): Promise<JsonValue> => {
      checkCancelled(signal);
      const definitions = managed(checks);
      const local = checks.filter(check => !readManagedGuardDefinition(check)) as readonly Guard[];
      // Local guards run in declared order, each on the content the one before it allowed or rewrote.
      let current = value;
      for (const check of local) {
        type Checked = { readonly decision: 'allow' | 'block' } | { readonly decision: 'rewrite'; readonly value: JsonValue };
        const verdict = await cancellable(() => runOperations.run(signal, async (): Promise<Checked> => {
          try {
            checkCancelled(signal);
            const raw = await check.check(current, Object.freeze({ runId: id, callId, scope, signal, boundary }));
            // Read adapter-owned properties inside the redaction boundary; do not retain a mutable verdict.
            const decision = raw?.decision;
            if (decision === 'allow' || decision === 'block') return { decision } as const;
            if (decision === 'rewrite') return { decision, value: freezeJson(jsonValue((raw as { value: JsonValue }).value, { maxBytes: limits.maxOutputBytes })) } as const;
            throw new Error();
          }
          catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A required guard could not complete its check.'); }
        }), signal);
        checkCancelled(signal);
        if (verdict.decision === 'block') throw new MayuraError('GUARD_BLOCKED', 'A required guard withheld this content.');
        if (verdict.decision === 'rewrite') current = verdict.value;
      }
      if (definitions.length === 0) return current;
      requiredChecks(checks);
      const owned = held === undefined ? reserveCalls(state, definitions.map(({ descriptor }) => ({ kind: 'model' as const, maxCostMicros: descriptor.model.maxCostMicros }))) : undefined;
      const entries = held ?? owned!.entries;
      try {
        if (entries.length !== definitions.length) throw new MayuraError('CONFLICT', 'Required guard reservations do not match this barrier.');
        const results = await cancellable(() => Promise.allSettled(definitions.map(({ descriptor }, index) => {
          const entry = entries[index]!;
          const metadata = { purpose: 'guardrail', modelId: descriptor.model.id, checkId: descriptor.id, checkVersion: descriptor.version, boundary, callId } as const;
          return evaluateManagedGuard({ descriptor, candidate: current,
            context: Object.freeze({ runId: id, callId, scope, signal, boundary }), limits, operations: runOperations,
            assertActive: () => checkCancelled(signal),
            authorize: async guardSignal => {
              if (!grants.has(`model:${descriptor.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The managed guard model destination is not authorized.');
              await authorizeRun(guardSignal);
            },
            start: () => {
              checkCancelled(signal);
              if (!grants.has(`model:${descriptor.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The managed guard model destination is not authorized.');
              return consumeCall(state, entry, 'model');
            },
            onStarted: () => { events.emit('model.started', { ...metadata, modelCall: state.modelCalls }); },
            onCompleted: (decision: 'allow' | 'block') => { events.emit('model.completed', { ...metadata, response: 'final', decision }); },
          });
        })), signal);
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        checkCancelled(signal);
      } finally { owned?.close(); }
      return current;
    };

    const preflight = async (tool: AnyTool, rawInput: JsonValue, signal: AbortSignal = controller.signal): Promise<void> => {
      checkCancelled(signal);
      const required = [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
      if (required.some((grant) => !grants.has(grant))) {
        await observe(Object.freeze({ stage: 'onViolation', source: 'permission', boundary: 'tool', code: 'PERMISSION_DENIED' }), null, { signal });
        throw new MayuraError('PERMISSION_DENIED', 'The requested tool is not authorized.');
      }
      await authorizeRun(signal); await requireAuthorization('tool', tool.id, 'execute', signal);
      await cancellable(() => runOperations.run(signal, async () => {
        checkCancelled(signal);
        await authorizeRun(signal); await requireAuthorization('tool', tool.id, 'execute', signal);
        return await validate(tool.input, rawInput, 'input', { maxBytes: limits.maxInputBytes });
      }), signal);
      checkCancelled(signal);
    };

    const control = async (event: HookEvent, step: number | null, signal: AbortSignal = controller.signal): Promise<Failure | undefined> => {
      for (const handle of agent.hooks) {
        if (handle.stage !== event.stage) continue;
        checkCancelled(signal);
        const descriptor = readHookDefinition(handle)!;
        const invocationId = crypto.randomUUID();
        const metadata = { hookId: handle.id, hookVersion: handle.version, stage: handle.stage, invocationId, step: step ?? 0, attempt: 1 };
        const failure = await evaluateHook({ descriptor, event,
          context: Object.freeze({ runId: id, rootId: state.root.id, ...(parent ? { parentId: parent.id } : {}),
            agentId: agent.id, scope, invocationId, hookId: handle.id, hookVersion: handle.version, step, attempt: 1 }),
          signal, operations: runOperations, assertActive: () => checkCancelled(signal),
          onStarted: () => {
            checkCancelled(signal);
            const path = ancestors(state);
            if (path.some(account => account.hookCalls >= account.limits.maxHookCalls)) {
              throw new MayuraError('LIMIT_EXCEEDED', 'An ancestor lifecycle-hook call limit was reached.');
            }
            // No callback/await between the ancestor check and historical admission.
            for (const account of path) account.hookCalls++;
            events.emit('hook.started', metadata);
          },
          onCompleted: status => events.emit('hook.completed', { ...metadata, status }),
          preflight,
          invoke: (tool, input, callId, actionSignal) => invokeRunTool(tool, input, callId, step ?? 0, actionSignal, false),
          allocateCallId: index => {
            const callId = `hook:${invocationId}:${index}`;
            if (callIds.has(callId)) throw new MayuraError('CONFLICT', 'Hook invocation identifiers must be unique.');
            callIds.add(callId); return callId;
          },
        });
        if (failure) {
          if (failure.status === 'blocked' && failure.error.code === 'GUARD_BLOCKED') {
            const callId = event.stage === 'beforeToolCall' ? event.proposal.callId : event.stage === 'beforeOutputRelease' ? event.callId : undefined;
            await observe(Object.freeze({ stage: 'onViolation', source: 'hook', boundary: violationBoundary[event.stage as ControlHookStage],
              code: 'GUARD_BLOCKED', ...(callId === undefined ? {} : { callId }) }), step, { signal });
          }
          return failure;
        }
      }
      checkCancelled(signal); return undefined;
    };

    const observe = async (event: HookEvent, step: number | null, options: ObserveOptions = {}): Promise<Failure | undefined> => {
      let failure: Failure | undefined;
      for (const handle of agent.hooks) {
        if (handle.stage !== event.stage) continue;
        const descriptor = readHookDefinition(handle)!;
        // Terminal observers run after this run's signal and budget closed; they get a deadline-only signal.
        const signal = options.terminal ? new AbortController().signal : options.signal ?? controller.signal;
        const invocationId = crypto.randomUUID();
        const metadata = { hookId: handle.id, hookVersion: handle.version, stage: handle.stage, invocationId, step: step ?? 0, attempt: 1 };
        const status = await evaluateObserver({ descriptor, event, signal, operations: runOperations,
          context: Object.freeze({ runId: id, rootId: state.root.id, ...(parent ? { parentId: parent.id } : {}),
            agentId: agent.id, scope, invocationId, hookId: handle.id, hookVersion: handle.version, step, attempt: 1 }),
          onStarted: () => {
            const path = ancestors(state);
            if (path.some(account => account.hookCalls >= account.limits.maxHookCalls)) {
              throw new MayuraError('LIMIT_EXCEEDED', 'An ancestor lifecycle-hook call limit was reached.');
            }
            for (const account of path) account.hookCalls++;
            events.emit('hook.started', metadata);
          },
          onCompleted: completion => events.emit('hook.completed', { ...metadata, status: completion }),
        });
        if (status === 'failed' && descriptor.mandatory && !failure) {
          failure = Object.freeze({ status: 'blocked', error: Object.freeze({ code: 'GUARD_UNAVAILABLE', message: 'A mandatory lifecycle observer could not complete.' }) });
        }
      }
      return failure;
    };
    state.control = control; state.observe = observe;

    /**
     * Wait for a person to answer an approval request for this call. Called at a safe point: the model call has settled
     * and this call holds no reservation. The deadline stops while the run waits and moves later by the time waited.
     */
    const awaitApproval = async (tool: AnyTool, input: JsonValue, callId: string, signal: AbortSignal): Promise<Answered> => {
      if (parent) throw new MayuraError('APPROVAL_UNAVAILABLE', `Tool ${tool.id} needs a person's approval, which only a root run can wait for.`);
      const expiresAtMs = Date.now() + approvalPolicy.expiresInMs;
      const policy = { onExpired: approvalPolicy.onExpired };
      const digest = approvalDigest({ runId: id, callId, toolId: tool.id, toolVersion: tool.version, input, policy, expiresAtMs });
      if (agent.hooks.some(hook => hook.stage === 'onApprovalRequested')) {
        await authorizeRun(signal); await requireAuthorization('tool', tool.id, 'execute', signal);
        const notification = await observe(Object.freeze({ stage: 'onApprovalRequested', callId, toolId: tool.id,
          toolVersion: tool.version, digest, expiresAtMs }), batch?.step ?? null, { signal });
        if (notification) throw new MayuraError(notification.error.code, notification.error.message);
        checkCancelled(signal);
        await authorizeRun(signal); await requireAuthorization('tool', tool.id, 'execute', signal);
        if (Date.now() >= expiresAtMs) throw new MayuraError('TIMEOUT', 'The approval request expired before publication.');
      }
      const pausedAt = Date.now();
      // At a safe point, with a store: save the run and let go of it. It continues where an answer is given.
      if (checkpoints && batch?.calls[0]?.id === callId && budget.snapshot().reservedMicros === 0 && state.bundles.size === 0
        && state.children.every(child => child.status !== 'running' && child.status !== 'waiting')) {
        const spent = budgetSnapshot();
        const body: CheckpointBody = { agent: { id: originAgent.id, version: originAgent.version, digest: agentDigest(originAgent) }, scope,
          ...(handoffPath.length ? { handoff: { path: [...handoffPath], sourcePermissions: [...sourcePermissions.allow] } } : {}),
          ...(recording ? { recording, approvals: recordedApprovals } : {}),
          permissions: [...permissions.allow], limits: { ...limits }, input: runInput, history: (history ?? null) as JsonValue, messages: [...messages],
          continuation: continuation ?? null, step: batch.step, calls: batch.calls, callIds: [...callIds],
          counts: { modelCalls: state.modelCalls, toolCalls: state.toolCalls, hookCalls: state.hookCalls, descendants: state.descendants },
          spent: { micros: String(spent.spentMicros), calls: spent.calls }, receipts: [...state.receipts.values()] as unknown as JsonValue[],
          mediaBytes, remainingMs: Math.max(0, Math.min(deadline, Number.MAX_SAFE_INTEGER) - pausedAt),
          pending: { callId, toolId: tool.id, toolVersion: tool.version, input, digest, expiresAtMs, onExpired: approvalPolicy.onExpired } };
        let saved = false;
        try { await checkpoints.store.put({ runId: id, scope: scopeId, expiresAtMs, body: encodeBody(body) }); saved = true; }
        catch { /* Too large or the store is unavailable: wait in memory instead. */ }
        if (saved) {
          if (signal.aborted) { await checkpoints.store.delete({ runId: id }).catch(() => false); throw signal.reason; }
          state.suspended = { body };
          suspend();
          events.emit('approval.requested', { callId, toolId: tool.id, digest, expiresAtMs });
          events.emit('run.paused', { callId });
          throw SUSPENDED;
        }
      }
      clearTimeout(timer);
      let answered: Answered;
      try {
        answered = await new Promise<Answered>((resolve, reject) => {
          const settle = (): void => { clearTimeout(expiry); signal.removeEventListener('abort', abort); state.approval = undefined; };
          const abort = (): void => { settle(); reject(signal.reason); };
          const expiry = setTimeout(() => {
            settle();
            recordedApprovals.push({ callId, toolId: tool.id, decision: 'expired' });
            events.emit('approval.resolved', { callId, toolId: tool.id, decision: 'expired' });
            if (approvalPolicy.onExpired === 'cancel') reject(new MayuraError('CANCELLED', 'The approval request expired, and the run was cancelled.'));
            else resolve({ decision: 'expired' });
          }, Math.max(0, expiresAtMs - Date.now()));
          signal.addEventListener('abort', abort, { once: true });
          state.approval = Object.freeze({ callId, toolId: tool.id, toolVersion: tool.version, input, digest, expiresAtMs,
            answer: (answer: Answered) => {
              settle();
              recordedApprovals.push({ callId, toolId: tool.id, decision: answer.decision, ...(answer.actorId === undefined ? {} : { actorId: answer.actorId }) });
      events.emit('approval.resolved', { callId, toolId: tool.id, decision: answer.decision, ...(answer.actorId === undefined ? {} : { actorId: answer.actorId }) });
              resolve(answer);
            } });
          state.status = 'waiting';
          events.emit('approval.requested', { callId, toolId: tool.id, digest, expiresAtMs });
          if (signal.aborted) abort();
        });
      } finally {
        if (state.status === 'waiting') state.status = 'running';
        deadline += Date.now() - pausedAt; state.deadline = deadline;
        if (!terminal) timer = armDeadline();
      }
      // The call that runs is the one approved: the same input under the same digest.
      if (answered.decision === 'approved'
        && approvalDigest({ runId: id, callId, toolId: tool.id, toolVersion: tool.version, input, policy, expiresAtMs }) !== digest) {
        throw new MayuraError('CONFLICT', 'The approved call no longer matches its approval.');
      }
      return answered;
    };


    /** Park before external dispatch, after all earlier work has settled. Publication follows the durable checkpoint. */
    const awaitExternalResult = async (tool: AnyTool, input: JsonValue, callId: string, signal: AbortSignal): Promise<never> => {
      const port = toolContinuation(tool)!;
      if (!checkpoints || parent || speculative || batch?.calls[0]?.id !== callId || budget.snapshot().reservedMicros !== 0
        || state.bundles.size !== 0 || state.children.some(child => child.status === 'running' || child.status === 'waiting')) {
        throw new MayuraError('CONFLICT', 'External tool recovery requires an idle root checkpoint boundary.');
      }
      const context = { runId: id, callId, scope, signal };
      const admission = new AbortController();
      const abortAdmission = () => admission.abort(signal.reason);
      signal.addEventListener('abort', abortAdmission, { once: true }); if (signal.aborted) abortAdmission();
      const admissionTimer = setTimeout(() => admission.abort(new MayuraError('TIMEOUT', 'External input admission timed out.')), tool.timeoutMs);
      let admitted: JsonValue;
      try { admitted = await cancellable(() => prepareToolInput(tool, input, { ...context, signal: admission.signal }, work => runOperations.run(admission.signal, work)), admission.signal); }
      finally { clearTimeout(admissionTimer); signal.removeEventListener('abort', abortAdmission); }
      checkCancelled(signal);
      const prepared = await port.prepare(admitted, context);
      const { digest: externalDigest, expiresAtMs } = prepared;
      if (!/^[a-f0-9]{64}$/.test(externalDigest) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) throw new MayuraError('CONFLICT', 'Invalid external wait checkpoint.');
      const digest = sha256Hex(JSON.stringify(['mayura.external-checkpoint.v1', scopeId, id, callId, tool.id, tool.version, agentDigest(originAgent), externalDigest]));
      // Conservatively settle the declared browser-call bound before publication; no free writes on owner loss.
      const prepaid = reserveCalls(state, [{ kind: 'tool', maxCostMicros: tool.costMicros }]);
      try { consumeCall(state, prepaid.entries[0]!, 'tool'); prepaid.entries[0]!.ticket.start().settle(tool.costMicros); } finally { prepaid.close(); }
      record(state, { callId, toolId: tool.id, execution: 'unknown', disclosure: 'withheld' });
      events.emit('tool.started', { callId, toolId: tool.id });
      const pausedAt = Date.now(); const spent = budgetSnapshot();
      const body: CheckpointBody = { waitKind: 'frontend', preparedInput: admitted, prepaid: true, externalDigest, agent: { id: originAgent.id, version: originAgent.version, digest: agentDigest(originAgent) }, scope,
        ...(handoffPath.length ? { handoff: { path: [...handoffPath], sourcePermissions: [...sourcePermissions.allow] } } : {}),
        ...(recording ? { recording, approvals: recordedApprovals } : {}),
        permissions: [...permissions.allow], limits: { ...limits }, input: runInput, history: (history ?? null) as JsonValue, messages: [...messages],
        continuation: continuation ?? null, step: batch!.step, calls: batch!.calls, callIds: [...callIds],
        counts: { modelCalls: state.modelCalls, toolCalls: state.toolCalls, hookCalls: state.hookCalls, descendants: state.descendants },
        spent: { micros: String(spent.spentMicros), calls: spent.calls }, receipts: [...state.receipts.values()] as unknown as JsonValue[],
        mediaBytes, remainingMs: Math.max(0, Math.min(deadline, Number.MAX_SAFE_INTEGER) - pausedAt),
        pending: { callId, toolId: tool.id, toolVersion: tool.version, input, digest, expiresAtMs, onExpired: 'cancel' } };
      // No live fallback: admitting a browser write without this checkpoint would make owner recovery unsafe.
      await checkpoints.store.put({ runId: id, scope: scopeId, expiresAtMs, body: encodeBody(body) });
      state.suspended = { body }; suspend();
      events.emit('run.paused', { callId });
      // A restart may repeat publication using this saved checkpoint, never prepare or browser execution.
      try { await port.publish(admitted, context, externalDigest); } catch { /* Remain safely parked for explicit recovery. */ }
      throw SUSPENDED;
    };

    /** Ordinary proposals and hook actions share the same broker, exact account and output barriers. */
    /**
     * The answer a paused run was resumed with, for its pending call: checked against the saved digest, then the
     * checkpoint is deleted before anything runs, so a call is dispatched by one runtime at most.
     */
    const resumedAnswer = async (tool: AnyTool, input: JsonValue, callId: string, resumed: { readonly body: CheckpointBody; readonly answer: Answered }): Promise<Answered> => {
      const pending = resumed.body.pending;
      if (approvalDigest({ runId: id, callId, toolId: tool.id, toolVersion: tool.version, input, policy: { onExpired: pending.onExpired }, expiresAtMs: pending.expiresAtMs }) !== pending.digest) {
        throw new MayuraError('CONFLICT', 'The resumed call no longer matches its approval.');
      }
      let deleted = false;
      try { deleted = await checkpoints!.store.delete({ runId: id, holderId: checkpoints!.replicaId }); } catch { deleted = false; }
      if (!deleted) throw new MayuraError('CONFLICT', 'Another runtime took over this run; this one stopped before the call.');
      const answer = resumed.answer;
      recordedApprovals.push({ callId, toolId: tool.id, decision: answer.decision, ...(answer.actorId === undefined ? {} : { actorId: answer.actorId }) });
              events.emit('approval.resolved', { callId, toolId: tool.id, decision: answer.decision, ...(answer.actorId === undefined ? {} : { actorId: answer.actorId }) });
      return answer;
    };

    /** Ordinary proposals and hook actions share the same broker, exact account and output barriers. */
    const invokeRunTool = async (tool: AnyTool, rawInput: JsonValue, callId: string, step: number,
      signal: AbortSignal = controller.signal, withHooks = true, resumed?: { readonly body: CheckpointBody; readonly answer: Answered }): Promise<Outcome<JsonValue>> => {
      checkCancelled(signal);
      // Model envelopes are validated JSON but not frozen. Do not expose their live history
      // objects to callbacks or let a proposal hook rewrite the later executor's arguments.
      const input = freezeJson(jsonValue(rawInput, { maxBytes: limits.maxInputBytes }));
      const prepaidResult = resumed?.body.waitKind === 'frontend' && resumed.body.prepaid === true;
      const resultChecks = prepaidResult ? requiredChecks(agent.guards.output).map(({ descriptor }) => ({ kind: 'model' as const, maxCostMicros: descriptor.model.maxCostMicros })) : [];
      let toolBundle: CallBundle = prepaidResult
        ? resultChecks.length ? reserveCalls(state, resultChecks) : { entries: [], close() {} }
        : operationBundle('tool', tool.costMicros);
      let approvalBinding: ToolApprovalBinding | undefined;
      try {
        await authorizeRun();
        if (authorization) {
          const required = [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
          if (!required.every(grant => grants.has(grant))) throw new MayuraError('PERMISSION_DENIED', 'The tool requires explicit capabilities.');
          await requireAuthorization('tool', tool.id, 'execute', signal);
        }
        if (withHooks && resumed?.body.waitKind !== 'frontend') {
          const failure = await control(Object.freeze({ stage: 'beforeToolCall', phase: 'proposal',
            proposal: Object.freeze({ callId, toolId: tool.id, input }) }), step, signal);
          if (failure) return failure;
        }
        checkCancelled(signal);
        // Approval applies to calls that passed preflight and the proposal hooks; it never grants anything.
        if (resumed?.body.waitKind === 'frontend') {
          // A saved frontend boundary already completed proposal hooks and any required human approval.
          if (!toolContinuation(tool)) throw new MayuraError('DEFINITION_CHANGED', 'The external continuation port is missing.');
          if (!externalConsumptions.delete(resumed.body)) throw new MayuraError('CONFLICT', 'External continuation was not consumed exactly once.');
          if (approvalPolicy.tools.has(tool.id) || toolNeedsApproval(tool, input)) approvalBinding = bindToolApproval(tool, { runId: id, callId, input });
        } else if (approvalPolicy.tools.has(tool.id) || toolNeedsApproval(tool, input)) {
          if (!withHooks) throw new MayuraError('APPROVAL_UNAVAILABLE', `A hook action cannot call ${tool.id}, which needs a person's approval.`);
          // Nothing is held while the run waits; an approved call reserves again, under the limits as they are then.
          toolBundle.close();
          const answer = resumed?.body.pending.callId === callId ? await resumedAnswer(tool, input, callId, resumed) : await awaitApproval(tool, input, callId, signal);
          checkCancelled(signal);
          if (answer.decision !== 'approved') {
            const refusal = answer.decision === 'rejected'
              ? { error: 'APPROVAL_REJECTED', message: `A person did not approve this call to ${tool.id}; it did not run.`, ...(answer.reason ? { reason: answer.reason } : {}) }
              : { error: 'APPROVAL_EXPIRED', message: `Nobody approved this call to ${tool.id} in time; it did not run.` };
            return Object.freeze({ status: 'succeeded' as const, output: freezeJson(refusal) });
          }
          toolBundle = operationBundle('tool', tool.costMicros);
          approvalBinding = bindToolApproval(tool, { runId: id, callId, input });
        }
        if (toolContinuation(tool) && resumed?.body.waitKind !== 'frontend') {
          toolBundle.close();
          await awaitExternalResult(tool, input, callId, signal);
        }
        if (!prepaidResult) { consumeCall(state, toolBundle.entries[0]!, 'tool'); events.emit('tool.started', { callId, toolId: tool.id }); }
        let outcome: ToolOutcome<unknown> = await invokeTool(tool, input, {
          runId: id, callId, scope, signal, permissions, budget,
          ...(authorization === undefined ? {} : { authorization, beforeDispatch: async () => { await authorizeRun(); } }), maxMediaBytes: Math.max(0, limits.maxMediaBytes - mediaBytes),
          ...(prepaidResult ? {} : { budgetBinding: bindToolBudgetTicket(tool, toolBundle.entries[0]!.ticket, { budget, runId: id, callId, scope, signal }) }),
          ...(approvalBinding ? { approvalBinding } : {}),
          ...(resumed?.body.waitKind === 'frontend' ? { preparedInput: bindPreparedToolInput(tool, input, resumed.body.preparedInput!, { runId: id, callId, scope, signal }, prepaidResult) } : {}),
          maxOutputBytes: limits.maxOutputBytes,
          acquireCallback: (callbackSignal: AbortSignal) => runOperations.acquire(callbackSignal),
          onExecutionReceipt: async receipt => { record(state, receipt); },
          ...(isAgentTool(tool) ? {
            contextBindings: [childGateway.bind(Object.freeze({
              spawn: (childAgent: AgentDefinition, childInput: unknown, childOptions: ChildOptions, childSignal: AbortSignal) =>
                admitChild(state, childAgent, childInput, childOptions, true, childSignal),
            }))],
          } : { acquireExecution: (executionSignal: AbortSignal) => runOperations.acquire(executionSignal) }),
        });
        if (outcome.receipt) record(state, outcome.status === 'succeeded'
          ? Object.freeze({ ...outcome.receipt, disclosure: 'withheld' as const }) : outcome.receipt);
        if (outcome.status === 'cancelled' && signal.aborted && signal.reason instanceof MayuraError && signal.reason.code === 'TIMEOUT') {
          outcome = { ...outcome, status: 'failed', error: publicError(signal.reason) };
        }
        if (outcome.status !== 'succeeded') {
          const completion = { callId, toolId: tool.id, status: outcome.status,
            ...(outcome.receipt ? { execution: outcome.receipt.execution, disclosure: outcome.receipt.disclosure } : {}) };
          events.emit('tool.completed', completion);
          // The tool already failed; an observer failure cannot make the outcome worse or better.
          if (withHooks) await observe(Object.freeze({ stage: 'afterToolCall', step, ...completion }), step, { signal });
          return outcome;
        }
        let toolOutput = freezeJson(jsonValue(outcome.output, { maxBytes: limits.maxOutputBytes }));
        let failure: Exclude<Outcome<never>, { status: 'succeeded' }> | undefined;
        let observed = false;
        try {
          // A rewritten tool result (for example redacted) is what the model sees, validated again by the tool's schema.
          toolOutput = await guarded(agent.guards.output, toolOutput, tool.output, 'output', callId, limits.maxOutputBytes, prepaidResult ? toolBundle.entries : toolBundle.entries.slice(1), signal);
          if (withHooks) failure = await control(Object.freeze({ stage: 'beforeOutputRelease', source: 'tool', callId,
            toolId: tool.id, candidate: toolOutput }), step, signal);
          // Observe the real released outcome before it enters model history; a mandatory failure withholds it.
          if (withHooks && !failure) {
            observed = true;
            failure = await observe(Object.freeze({ stage: 'afterToolCall', step, callId, toolId: tool.id, status: 'succeeded',
              execution: 'succeeded', disclosure: 'released' }), step, { signal });
          }
          if (!failure) checkCancelled(signal);
        } catch (error) { failure = outcomeFor(error) as Exclude<Outcome<never>, { status: 'succeeded' }>; }
        if (failure) {
          events.emit('tool.completed', { callId, toolId: tool.id, status: failure.status, execution: 'succeeded', disclosure: 'withheld' });
          if (withHooks && !observed) await observe(Object.freeze({ stage: 'afterToolCall', step, callId, toolId: tool.id, status: failure.status,
            execution: 'succeeded', disclosure: 'withheld' }), step, { signal });
          const receipt = outcome.receipt ? Object.freeze({ ...outcome.receipt, disclosure: 'withheld' as const }) : undefined;
          if (receipt) record(state, receipt);
          // An uncertain hook action owns the primary failure receipt. The original known
          // success remains withheld in the run-qualified evidence rather than replacing it.
          return { ...failure, ...(!failure.receipt && receipt ? { receipt } : {}) };
        }
        if (outcome.receipt) record(state, outcome.receipt);
        const returnedMedia = outcome.status === 'succeeded' ? outcome.media ?? [] : [];
        for (const item of returnedMedia) if ('data' in item) mediaBytes += item.data.byteLength;
        events.emit('tool.completed', { callId, toolId: tool.id, status: 'succeeded', execution: 'succeeded', disclosure: 'released',
          ...(returnedMedia.length > 0 ? { media: returnedMedia.length } : {}) });
        return Object.freeze({ ...outcome, output: toolOutput });
      } finally { toolBundle.close(); }
    };

    const execute = async (resume?: { readonly body: CheckpointBody; readonly answer: Answered }): Promise<Outcome<InferOutput<O>>> => {
      if (resume) return await continueRun(resume);
      events.emit('run.started', { profile: 'ephemeral', rootId: state.root.id, agentId: agent.id, ...(parent ? { parentId: parent.id } : {}),
        ...(inputMedia.media.length > 0 ? { media: inputMedia.media.length } : {}), ...(history ? { history: history.length } : {}) });
      checkCancelled();
      if (parent) {
        // The parent's own hooks decide delegation, in the parent's context and under its hook ceiling.
        const delegateFailure = await parent.control(Object.freeze({ stage: 'beforeDelegate', childRunId: id, childAgentId: agent.id, input }), null, controller.signal);
        if (delegateFailure) return delegateFailure;
      }
      const validated = inputAdmitted ? input : await cancellable(() => runOperations.run(controller.signal, async () => {
        checkCancelled(); return await validate(agent.input, input, 'input', { maxBytes: limits.maxInputBytes });
      }), controller.signal);
      const approvedInput = await guarded(agent.guards.input, freezeJson(jsonValue(validated, { maxBytes: limits.maxInputBytes })), agent.input, 'input', 'input', limits.maxInputBytes);
      const inputFailure = await control(Object.freeze({ stage: 'beforeExecution', input: approvedInput,
        ...(inputMedia.media.length > 0 ? { media: Object.freeze(inputMedia.media.map(mediaSummary)) } : {}) }), null);
      if (inputFailure) return inputFailure;
      messages = [{ role: 'user', content: approvedInput, ...(inputMedia.media.length > 0 ? { media: inputMedia.media } : {}) }];
      if (admittedHistory) events.emit('history.applied', admittedHistory.metadata);
      return await steps(0);
    };
      /**
       * Consume a streamed model call. Only the configured string field of the final output is released, in batches,
       * each after the batch guards allow it; the returned complete response is then handled exactly like `generate`.
       * Batch guards run directly rather than through operation permits: this code already holds the model call's
       * permit, and a nested acquisition could wait on itself.
       */
      const streamModel = async (request: ModelRequest, step: number, modelCall: number): Promise<unknown> => {
        const policy = agent.stream!; const extractor = createFieldExtractor(policy.field);
        const batcher = createBatcher(policy.batch?.minChars, policy.batch?.maxChars);
        let released = ''; let withheld = false; let index = 0; let response: unknown; let received = 0;
        const release = async (batches: readonly string[]): Promise<void> => {
          for (const batch of batches) {
            if (withheld || batch.length === 0) return;
            // Guards run in order on the batch with already released context; a guard may rewrite the batch (for
            // example to redact it), and the next guard sees the rewrite. Context before the batch is never changed.
            const context = released.slice(-512); let text = batch; let blocked = false;
            for (const check of policy.guards) {
              let verdict: { readonly decision?: unknown; readonly value?: unknown } | undefined;
              try { verdict = await cancellable(async () => check.check(context + text, Object.freeze({ runId: id, callId: `model.${modelCall}.stream`, scope, signal: controller.signal, boundary: 'output' as const })), controller.signal); }
              catch { blocked = true; break; }
              checkCancelled();
              if (verdict?.decision === 'allow') continue;
              // A rewrite must keep the released context unchanged and return the rest as bounded text.
              if (verdict?.decision === 'rewrite' && typeof verdict.value === 'string' && verdict.value.startsWith(context) && verdict.value.length - context.length <= 4_096) {
                text = verdict.value.slice(context.length); continue;
              }
              blocked = true; break;
            }
            if (blocked) {
              withheld = true; events.emit('output.withheld', { step, modelCall });
              await observe(Object.freeze({ stage: 'onViolation', source: 'guard', boundary: 'output', code: 'GUARD_BLOCKED', callId: `model.${modelCall}.stream` }), step);
              return;
            }
            if (text.length === 0) continue;
            await authorizeRun();
            released += text; events.emit('output.delta', { step, modelCall, index: index++, text });
          }
        };
        for await (const event of agent.model.stream!(request)) {
          checkCancelled();
          if (response !== undefined) throw new MayuraError('MODEL_FAILED', 'The model stream continued after its response.');
          if (event?.type === 'output.delta' && typeof event.text === 'string') {
            received += event.text.length;
            if (received > limits.maxOutputBytes) throw new MayuraError('MODEL_FAILED', 'The model stream exceeded the output bound.');
            if (!withheld && !extractor.done) await release(batcher.push(extractor.feed(event.text)));
          } else if (event?.type === 'response') response = event.response;
          else throw new MayuraError('MODEL_FAILED', 'The model stream produced an invalid event.');
        }
        if (response === undefined) throw new MayuraError('MODEL_FAILED', 'The model stream ended without a response.');
        // The tail is released only for a final answer; a tool-call response releases nothing further.
        if ((response as { type?: unknown }).type === 'final' && !withheld) await release(batcher.flush());
        return response;
      };
      type StepResult = { readonly done: false; readonly handoff?: ModelToolCall } | { readonly done: true; readonly outcome: Outcome<InferOutput<O>> };
      const runStep = async (step: number): Promise<StepResult> => {
        const stepFailure = await control(Object.freeze({ stage: 'beforeStep', step }), step);
        if (stepFailure) return { done: true, outcome: stepFailure };
        if (!grants.has(`model:${agent.model.id}`)) {
          await observe(Object.freeze({ stage: 'onViolation', source: 'permission', boundary: 'model', code: 'PERMISSION_DENIED' }), step);
          throw new MayuraError('PERMISSION_DENIED', 'The model adapter is not authorized.');
        }
        checkCalls(state, 'model', 1);
        // Freeze a bounded copy: a provider cannot mutate history or the tool registry between checks. Media is not JSON:
        // it is set aside, counted under maxMediaBytes instead of the context limit, and put back unchanged.
        const mediaOf = messages.map(message => ('media' in message ? message.media : undefined));
        const textual = messages.map(message => {
          if (!('media' in message)) return message;
          const { media: _media, ...rest } = message; return rest;
        });
        const snapshot = freezeJson(jsonValue(textual, { maxBytes: limits.maxContextBytes })) as unknown as readonly ModelMessage[];
        const modelTools = [...agent.tools.map((tool) => Object.freeze({ id: tool.id, description: tool.description,
          ...(tool.inputJsonSchema === undefined ? {} : { inputJsonSchema: freezeJson(jsonValue(tool.inputJsonSchema)) as typeof tool.inputJsonSchema }),
        })), ...handoffTools(agent)];
        const jsonRequest = freezeJson(jsonValue({ instructions: agent.instructions, ...(history ? { history } : {}), messages: snapshot, tools: modelTools, ...(continuation === undefined ? {} : { continuation }), ...(agent.outputJsonSchema === undefined ? {} : { outputJsonSchema: agent.outputJsonSchema }) }, { maxBytes: limits.maxContextBytes })) as unknown as Omit<ModelRequest, 'signal' | 'maxOutputTokens'>;
        const withMedia = (message: ModelMessage, index: number): ModelMessage => mediaOf[index] ? Object.freeze({ ...message, media: mediaOf[index] }) : message;
        const requestData: Omit<ModelRequest, 'signal' | 'maxOutputTokens'> = mediaOf.some(Boolean)
          ? Object.freeze({ ...jsonRequest, messages: Object.freeze(jsonRequest.messages.map(withMedia)) }) : jsonRequest;
        // Hooks see what media there is (type and size by message), never its bytes.
        const hookMedia = Object.freeze(mediaOf.flatMap((items, index) => items ? [Object.freeze({ message: index, media: Object.freeze(items.map(mediaSummary)) })] : []));
        const primaryBundle = operationBundle('model', agent.model.maxCostMicros);
        let callCostMicros: number | undefined;
        try {
          // A content-only projection: private instructions and provider continuation never
          // enter hook context. These immutable fields are the same ones sent to the adapter.
          const modelFailure = await control(Object.freeze({ stage: 'beforeModelCall', purpose: 'primary', modelId: agent.model.id,
            request: Object.freeze({ ...(jsonRequest.history ? { history: jsonRequest.history } : {}), messages: jsonRequest.messages, tools: requestData.tools, maxOutputTokens: limits.maxOutputTokens,
              ...(hookMedia.length > 0 ? { media: hookMedia } : {}) }) }), step);
          if (modelFailure) return { done: true, outcome: modelFailure };
          const rawResponse = await cancellable(() => runOperations.run(controller.signal, async () => {
            checkCancelled();
            await authorizeRun();
            const reservation = consumeCall(state, primaryBundle.entries[0]!, 'model');
            // The model's id, when it is a stable identifier, lets trace exporters name the model and its provider.
            events.emit('model.started', { step, modelCall: state.modelCalls, ...(stableModelId.test(agent.model.id) ? { modelId: agent.model.id } : {}) });
            let raw;
            const modelRequest = Object.freeze({ ...requestData, signal: controller.signal, maxOutputTokens: limits.maxOutputTokens });
            try { raw = agent.stream && agent.model.stream ? await streamModel(modelRequest, step, state.modelCalls) : await agent.model.generate(modelRequest); }
            catch (error) {
              const cost = modelFailureCost(error);
              if (cost !== undefined) reservation.settle(cost);
              // Preserve only our privately branded streaming-authorization refusal, never a provider-shaped error.
              if (error !== null && typeof error === 'object' && authorizationFailures.has(error)) throw error;
              // Only Mayura's own message for a known reason reaches the outcome, never the adapter's text.
              throw publicModelFailure(error, controller.signal.aborted);
            }
            // Account independently validated usage even when the content envelope is malformed.
            // The callback may complete after cooperative cancellation; it cannot re-open disclosure.
            callCostMicros = modelCost(raw);
            reservation.settle(callCostMicros);
            return raw;
          }), controller.signal);
          checkCancelled();
          const response = modelResponse(rawResponse, limits.maxOutputBytes, Math.max(1, limits.maxToolCalls));
          continuation = response.continuation === undefined ? undefined : freezeJson(jsonValue(response.continuation, { maxBytes: limits.maxContextBytes }));
          events.emit('model.completed', { step, response: response.type, ...(callCostMicros === undefined ? {} : { costMicros: callCostMicros }),
            ...(response.usage.inputTokens === undefined ? {} : { inputTokens: response.usage.inputTokens }), ...(response.usage.outputTokens === undefined ? {} : { outputTokens: response.usage.outputTokens }) });
          const modelObserved = await observe(Object.freeze({ stage: 'afterModelCall', step, modelId: agent.model.id, response: response.type,
            toolCalls: response.type === 'final' ? 0 : response.calls.length }), step);
          if (modelObserved) return { done: true, outcome: modelObserved };
          if (response.type === 'final') {
            const output = await cancellable(() => runOperations.run(controller.signal, async () => {
              checkCancelled(); return await validate(agent.output, response.output, 'output', { maxBytes: limits.maxOutputBytes });
            }), controller.signal);
            const callId = `model.${state.modelCalls}`;
            const approvedOutput = await guarded(agent.guards.output, freezeJson(jsonValue(output, { maxBytes: limits.maxOutputBytes })), agent.output, 'output', callId,
              limits.maxOutputBytes, primaryBundle.entries.slice(1));
            const outputFailure = await control(Object.freeze({ stage: 'beforeOutputRelease', source: 'agent',
              callId, candidate: approvedOutput }), step);
            if (outputFailure) return { done: true, outcome: outputFailure };
            if (agent !== originAgent) {
              const contract = await cancellable(() => runOperations.run(controller.signal, () => validate(originAgent.output, approvedOutput, 'output', { maxBytes: limits.maxOutputBytes })), controller.signal);
              // The original typed handle cannot silently return a different schema or an unguarded transformation.
              if (!sameHandoffOutput(jsonValue(contract, { maxBytes: limits.maxOutputBytes }), approvedOutput)) throw new MayuraError('INVALID_OUTPUT', 'Handoff agents must share the original run output contract.');
            }
            checkCancelled();
            return { done: true, outcome: Object.freeze({ status: 'succeeded' as const, output: approvedOutput as InferOutput<O> }) };
          }
          // A validated tool proposal has no final candidate; these holds cannot fund a later invocation.
          primaryBundle.close();
          const transfers = response.calls.filter(call => agent.handoffs?.some(edge => call.toolId === `handoff.${edge.agent.id}`));
          if (transfers.length) {
            if (response.calls.length !== 1) throw new MayuraError('INVALID_INPUT', 'A handoff must be the only call in its model response.');
            return { done: false, handoff: transfers[0]! };
          }
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
          if (typeof ledger.spentMicros !== 'number' || batchCost > budget.maxCostMicros - ledger.spentMicros - ledger.reservedMicros) {
            const left = typeof ledger.spentMicros === 'number' ? Math.max(0, budget.maxCostMicros - ledger.spentMicros - ledger.reservedMicros) : 0;
            throw new MayuraError('BUDGET_EXCEEDED', `The tool calls the model asked for may cost up to ${batchCost} micros, but only ${left} of the run's limits.maxCostMicros (${limits.maxCostMicros}) are left.`);
          }
          for (const call of response.calls) callIds.add(call.id);
          messages.push({ role: 'assistant', calls: response.calls });
          return await runCalls(response.calls, step);
        } finally { primaryBundle.close(); }
      };
      /** Run a batch's calls in order; `resumed` answers the first one, which a paused run was waiting on. */
      const runCalls = async (calls: readonly ModelToolCall[], step: number, resumed?: { readonly body: CheckpointBody; readonly answer: Answered }): Promise<StepResult> => {
        for (const [index, call] of calls.entries()) {
          batch = { step, calls: calls.slice(index) };
          const outcome = await invokeRunTool(tools.get(call.toolId)!, call.input, call.id, step, controller.signal, true, index === 0 ? resumed : undefined);
          if (outcome.status !== 'succeeded') return { done: true, outcome };
          const toolMedia = (outcome as ToolOutcome<JsonValue>).media;
          messages.push({ role: 'tool', callId: call.id, toolId: call.toolId, result: outcome.output, ...(toolMedia && toolMedia.length > 0 ? { media: toolMedia } : {}) });
        }
        batch = undefined;
        return { done: false };
      };
      const finishStep = async (step: number, result: 'tool_calls' | 'final' | 'stopped'): Promise<Failure | undefined> => {
        const failure = await observe(Object.freeze({ stage: 'afterStep', step, result }), step);
        events.emit('step.completed', { step, result });
        return failure;
      };
    /** Settle a step: its observers and event. A mandatory afterStep failure stops a continuing step and withholds a final output. */
    const settleStep = async (step: number, result: StepResult): Promise<Outcome<InferOutput<O>> | undefined> => {
      const observed = await finishStep(step, !result.done ? 'tool_calls' : result.outcome.status === 'succeeded' ? 'final' : 'stopped');
      if (observed && (!result.done || result.outcome.status === 'succeeded')) return observed;
      return result.done ? result.outcome : undefined;
    };
    /** Transfer at a settled step boundary. The same account, scope, recorder, transcript and deadline continue. */
    const transfer = async (call: ModelToolCall, step: number): Promise<Failure | undefined> => {
      checkCancelled();
      await authorizeRun();
      const edge = agent.handoffs?.find(edge => call.toolId === `handoff.${edge.agent.id}`);
      if (!edge || !grants.has(`agent:${edge.agent.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The handoff target is not authorized.');
      await requireAuthorization('agent', edge.agent.id, 'handoff', controller.signal);
      await requireAuthorization('agent', edge.agent.id, 'execute', controller.signal);
      if (parent || speculative) throw new MayuraError('PERMISSION_DENIED', 'Handoffs require a non-speculative root run.');
      if (state.children.some(child => child.status === 'running' || child.status === 'waiting')) throw new MayuraError('CONFLICT', 'Settle child execution before handing off.');
      if (step + 1 >= limits.maxSteps) throw new MayuraError('LIMIT_EXCEEDED', 'No model step remains for the handoff target.');
      if (handoffPath.length >= limits.maxHandoffs) throw new MayuraError('LIMIT_EXCEEDED', 'The run handoff limit was reached.');
      if (mediaBytes > 0 || messages.some(message => 'media' in message && (message.media?.length ?? 0) > 0)) throw new MayuraError('INVALID_INPUT', 'Media cannot cross a handoff boundary in this release.');
      if (edge.agent.model.capabilities.history !== true) throw new MayuraError('INVALID_CONFIG', 'A handoff target must accept conversation history.');
      if (callIds.has(call.id)) throw new MayuraError('CONFLICT', 'Tool call identifiers must remain unique across handoffs.');
      checkCalls(state, 'tool', 1);
      const rawInput = freezeJson(jsonValue(call.input, { maxBytes: limits.maxInputBytes }));
      const sourceFailure = await control(Object.freeze({ stage: 'beforeToolCall', phase: 'proposal', proposal: Object.freeze({ callId: call.id, toolId: call.toolId, input: rawInput }) }), step);
      if (sourceFailure) return sourceFailure;
      const validated = await cancellable(() => runOperations.run(controller.signal, () => validate(edge.agent.input, rawInput, 'input', { maxBytes: limits.maxInputBytes })), controller.signal);
      const acknowledged = await observe(Object.freeze({ stage: 'afterToolCall', step, callId: call.id, toolId: call.toolId, status: 'succeeded' }), step);
      if (acknowledged) return acknowledged;
      checkCancelled(); checkCalls(state, 'tool', 1);
      if (state.children.some(child => child.status === 'running' || child.status === 'waiting')) throw new MayuraError('CONFLICT', 'Child execution started before handoff commit.');
      await authorizeRun(); await requireAuthorization('agent', edge.agent.id, 'handoff', controller.signal); await requireAuthorization('agent', edge.agent.id, 'execute', controller.signal);
      const bundle = reserveCalls(state, [{ kind: 'tool', maxCostMicros: 0 }]);
      try { consumeCall(state, bundle.entries[0]!, 'tool'); bundle.entries[0]!.ticket.start().settle(0); } finally { bundle.close(); }
      const fromAgentId = agent.id; callIds.add(call.id);
      events.emit('tool.started', { callId: call.id, toolId: call.toolId });
      messages.push({ role: 'assistant', calls: [call] });
      messages.push({ role: 'tool', callId: call.id, toolId: call.toolId, result: { handedOff: true, agentId: edge.agent.id } });
      agent = edge.agent as AgentDefinition<I, O>; permissions = permissionsFor(edge.permissions, true);
      grants.clear(); for (const grant of permissions.allow) grants.add(grant);
      tools.clear(); for (const tool of agent.tools) tools.set(tool.id, tool);
      Object.assign(state, { agent, permissions }); handoffPath.push(agent.id); continuation = undefined;
      events.emit('tool.completed', { callId: call.id, toolId: call.toolId, status: 'succeeded', fromAgentId, toAgentId: agent.id, handoffs: handoffPath.length });
      const approved = await guarded(agent.guards.input, freezeJson(jsonValue(validated, { maxBytes: limits.maxInputBytes })), agent.input, 'input', call.id, limits.maxInputBytes);
      const targetFailure = await control(Object.freeze({ stage: 'beforeExecution', input: approved }), step);
      if (targetFailure) return targetFailure;
      messages.push({ role: 'user', content: approved });
      // Check the whole envelope on the next model call; context is never silently dropped at transfer.
      return undefined;
    };
    const steps = async (first: number): Promise<Outcome<InferOutput<O>>> => {
      for (let step = first; step < limits.maxSteps; step++) {
        checkCancelled();
        events.emit('step.started', { step });
        let result: StepResult;
        try { result = await runStep(step); }
        catch (error) { if (error !== SUSPENDED) await finishStep(step, 'stopped'); throw error; }
        const ended = await settleStep(step, result);
        if (ended) return ended;
        if (!result.done && result.handoff) { const failure = await transfer(result.handoff, step); if (failure) return failure; }
      }
      throw new MayuraError('LIMIT_EXCEEDED', 'The agent step limit was reached.');
    };
    /** Continue a paused run: restore its conversation, finish the paused batch from the answered call, then go on. */
    const continueRun = async (resume: { readonly body: CheckpointBody; readonly answer: Answered }): Promise<Outcome<InferOutput<O>>> => {
      const { body } = resume;
      events.emit('run.resumed', { callId: body.pending.callId });
      checkCancelled();
      messages = [...body.messages];
      continuation = body.continuation === null ? undefined : freezeJson(body.continuation);
      for (const call of body.calls) if (!tools.has(call.toolId)) throw new MayuraError('DEFINITION_CHANGED', 'A tool of the paused batch is no longer registered.');
      let result: StepResult;
      try { result = await runCalls(body.calls, body.step, resume); }
      catch (error) { if (error !== SUSPENDED) await finishStep(body.step, 'stopped'); throw error; }
      return await settleStep(body.step, result) ?? await steps(body.step + 1);
    };


    /** End the run with an outcome: children, terminal hooks, events, accounting, then settle the handle. */
    const finish = async (candidate: Outcome<InferOutput<O>>): Promise<void> => {
        state.accepting = false;
        // Accepted descendants remain required even if the parent's model has already finished.
        if (candidate.status !== 'succeeded' && !controller.signal.aborted) {
          controller.abort(new MayuraError('CANCELLED', 'Parent execution ended before its required children.'));
        }
        const settled = await Promise.all(state.children.map((child) => child.handle.result()));
        const children = settled.filter((_, index) => !state.children[index]!.speculative);
        let outcome: Outcome<InferOutput<O>> = candidate;
        if (outcome.status === 'succeeded' && controller.signal.aborted) outcome = outcomeFor(controller.signal.reason);
        const unknown = children.find((child) => child.status === 'outcome_unknown');
        const failed = children.find((child) => child.status !== 'succeeded');
        if (unknown) outcome = unknown;
        else if (failed && (outcome.status === 'succeeded' || outcome.error.code === 'TOOL_FAILED')) outcome = failed;
        if (agent.hooks.length > 0) {
          const stage: TerminalHookStage = outcome.status === 'succeeded' ? 'afterExecution' : outcome.status === 'cancelled' ? 'onCancel'
            : outcome.status === 'blocked' ? 'onBlocked' : 'onError';
          const terminalFailure = await observe(terminalView(stage, outcome), null, { terminal: true });
          // Only a mandatory afterExecution can change the outcome: it withholds a successful output.
          if (terminalFailure && outcome.status === 'succeeded') outcome = terminalFailure;
          await observe(terminalView('onFinally', outcome), null, { terminal: true });
        }
        if (parent && parent.agent.hooks.length > 0) {
          const delegated = await parent.observe(Object.freeze({ stage: 'afterDelegate', childRunId: id, childAgentId: agent.id, status: outcome.status }), null, { terminal: true });
          if (delegated && outcome.status === 'succeeded') outcome = delegated;
        }
        if (state.children.length > 0 || agent.hooks.length > 0 || (authorization && state.receipts.size > 0)) outcome = { ...outcome, evidence: evidenceFor(state) };
        if (outcome.status === 'succeeded') {
          try { await authorizeRun(); }
          catch (error) { outcome = { ...outcomeFor(error), ...(outcome.evidence ? { evidence: outcome.evidence } : {}), ...(outcome.receipt ? { receipt: outcome.receipt } : {}) }; }
        }
        if (recording && recordingOpened) {
          try {
            const completion: RunRecording = Object.freeze({ runId: id, scope, binding: recording, messages: Object.freeze([...messages]),
              approvals: Object.freeze([...recordedApprovals]), outcome });
            pendingRecordings.set(handle, completion);
            await recorder!.complete(completion);
            pendingRecordings.delete(handle);
          } catch {
            outcome = { ...(outcome.receipt ? { receipt: outcome.receipt } : {}), ...(outcome.evidence ? { evidence: outcome.evidence } : {}), status: 'failed', error: { code: 'STORAGE_UNAVAILABLE', message: 'The run ended but its conversation could not be recorded. The thread remains blocked for recovery.' } };
          }
        }
        terminal = true;
        state.status = outcome.status;
        for (const bundle of state.bundles) bundle.close();
        budget.close();
        clearTimeout(timer);
        parent?.controller.signal.removeEventListener('abort', relayParent);
        externalSignal?.removeEventListener('abort', relayExternal);
        events.emit('run.completed', { status: outcome.status, ...budgetSnapshot() });
        events.finish();
        parent?.events.emit('delegate.completed', { childRunId: id, status: outcome.status });
        active.delete(id);
        if (!parent) activeRoots--;
        settle(Object.freeze(outcome));
    };
    /** Let go of a run paused to the store: it holds no slot, timer or work; the handle stays for this process. */
    const suspend = (): void => {
      clearTimeout(timer);
      state.status = 'waiting';
      active.delete(id); if (!parent) activeRoots--;
      suspendedRuns.set(id, state);
      const pending = state.suspended!.body.pending;
      // A timer may fire a little early; it waits out the rest rather than finding the request not yet expired.
      const fire = (): void => {
        const left = pending.expiresAtMs - Date.now();
        if (left > 0) { if (state.suspended) state.suspended.expiry = setTimeout(fire, left); return; }
        void expireRun(id).catch(() => undefined);
      };
      if (checkpoints?.autoExpire !== false) state.suspended!.expiry = setTimeout(fire, Math.max(0, pending.expiresAtMs - Date.now()));
    };
    const launch = (resume?: { readonly body: CheckpointBody; readonly answer: Answered }): void => {
      queueMicrotask(() => {
        const execution = (async () => {
          await authorizeRun();
          if (recording && !recordingOpened) { await recorder!.begin({ runId: id, scope, binding: recording }); recordingOpened = true; }
          return execute(resume);
        })();
        void execution.then(outcome => outcome, (error: unknown) => error === SUSPENDED ? SUSPENDED : outcomeFor(error)).then(async candidate => {
          if (candidate === SUSPENDED) { return; }
          await finish(candidate as Outcome<InferOutput<O>>);
        });
      });
    };
    /** Take a paused run of this process back: a slot and the status of a running run. */
    const reactivate = (): void => {
      clearTimeout(state.suspended?.expiry); state.suspended = undefined; suspendedRuns.delete(id);
      active.set(id, handle); if (!parent) activeRoots++;
      state.status = 'running';
    };
    state.transcript = () => Object.freeze([...messages]);
    state.resume = (body, answer) => {
      reactivate();
      // The deadline restarts with the active time the run had left: waiting did not count.
      deadline = Date.now() + body.remainingMs; state.deadline = deadline; timer = armDeadline();
      launch({ body, answer });
    };
    state.endSuspended = error => {
      reactivate();
      controller.abort(error);
      void finish(outcomeFor(error) as Outcome<InferOutput<O>>);
    };
    launch(resumption ? { body: resumption.body, answer: resumption.answer } : undefined);
    return handle;
  };
  /** Claim a saved run for this runtime; a run another runtime holds, or one already gone, is refused. */
  const claimCheckpoint = async (runId: string): Promise<void> => {
    try { await checkpoints!.store.claim({ runId, holderId: checkpoints!.replicaId, leaseMs: checkpoints!.leaseMs }); }
    catch { throw new MayuraError('CONFLICT', 'Another runtime is resuming this run, or it is no longer waiting.'); }
  };
  /** Consume the exact checkpoint epoch before any continuation work; no lease expiry can replay that epoch. */
  const consumeExternalCheckpoint = async (runId: string, body: CheckpointBody): Promise<void> => {
    const claimed = await checkpoints!.store.claim({ runId, holderId: checkpoints!.replicaId, leaseMs: checkpoints!.leaseMs, expectedDigest: body.pending.digest }) as { runId?: unknown; scope?: unknown; version?: unknown; body?: JsonObject };
    if (!claimed || claimed.runId !== runId || claimed.scope !== scopeId || !Number.isSafeInteger(claimed.version) || !claimed.body
      || claimed.body['waitKind'] !== 'frontend' || decodeBody(claimed.body).pending.digest !== body.pending.digest) throw new MayuraError('CONFLICT', 'External checkpoint identity changed during claim.');
    let deleted: boolean;
    try { deleted = await checkpoints!.store.delete({ runId, holderId: checkpoints!.replicaId, expectedVersion: claimed.version as number, expectedDigest: body.pending.digest }); }
    catch { throw new MayuraError('OUTCOME_UNKNOWN', 'External continuation consumption could not be confirmed. Do not replay paid work.'); }
    if (!deleted) throw new MayuraError('CONFLICT', 'External continuation could not be consumed.');
  };
  /** A saved run of this scope, read back, with the agent to continue it. */
  const loadCheckpoint = async (runId: string, operation?: 'approve'): Promise<{ readonly body: CheckpointBody; readonly agent: AgentDefinition | undefined; readonly local: RunState | undefined }> => {
    let stored;
    try { stored = await checkpoints!.store.get({ runId }); }
    catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'The run checkpoint store could not be read.'); }
    if (!stored || stored.scope !== scopeId) throw new MayuraError('NOT_FOUND', 'No run of this scope is waiting for approval with that id.');
    const body = decodeBody(stored.body);
    const reclaimable = body.waitKind === 'frontend' && stored.status === 'claimed' && typeof stored.leaseExpiresAtMs === 'number' && stored.leaseExpiresAtMs <= Date.now();
    if (stored.status !== 'waiting' && !reclaimable) throw new MayuraError('CONFLICT', 'Another runtime is resuming this run.');
    if (body.scope.principalId !== scope.principalId || body.scope.projectId !== scope.projectId) throw new MayuraError('NOT_FOUND', 'No run of this scope is waiting for approval with that id.');
    if (operation) await authorizeRecording(body.recording, operation);
    if (body.recording && !recorder) throw new MayuraError('INVALID_CONFIG', 'Configure the run recorder before resuming this bound run.');
    if (body.recording && operation) await recorder!.begin({ runId, scope, binding: body.recording });
    const local = suspendedRuns.get(runId);
    return { body, agent: local?.originAgent ?? checkpoints!.agents.get(body.agent.id), local };
  };
  const authorizeSaved = async (runId: string, body: CheckpointBody, origin: AgentDefinition, approved: boolean): Promise<void> => {
    await requireAuthorization('run', runId, 'execute');
    await authorizeRecording(body.recording, 'append');
    if (body.waitKind !== 'frontend') await authorizeRecording(body.recording, 'approve');
    if (!authorization) return;
    const source = permissionsFor({ allow: (body.handoff?.sourcePermissions ?? body.permissions).filter(grant => rootPermissions.allow.includes(grant)) });
    const restored = restoreHandoff(origin, source, body.handoff?.path ?? [], body.permissions);
    if (!restored.permissions.allow.includes(`model:${restored.agent.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The resumed agent model requires an explicit capability.');
    await requireAuthorization('agent', restored.agent.id, 'execute');
    for (const target of body.handoff?.path ?? []) await requireAuthorization('agent', target, 'handoff');
    if (approved) await requireAuthorization('tool', body.pending.toolId, 'execute');
  };
  /** Continue a saved run, answered: in place when this process paused it, otherwise as a new handle here. */
  const resumeSaved = (runId: string, body: CheckpointBody, agent: AgentDefinition, local: RunState | undefined, answer: Answered): RunHandle<unknown> => {
    if (local?.suspended) { local.resume(body, answer); return local.handle; }
    // The run keeps the permissions and limits it had; this runtime can only narrow them, never widen.
    const allow = (body.handoff?.sourcePermissions ?? body.permissions).filter(grant => rootPermissions.allow.includes(grant));
    const limits = limitsFor(Object.fromEntries(Object.keys(defaults).map(key => [key,
      Math.min(Number.isSafeInteger(body.limits[key]) ? body.limits[key]! : Infinity, rootLimits[key as keyof RuntimeLimits])])) as RuntimeLimits);
    return start(agent, body.input, limits, permissionsFor({ allow }), undefined, true, undefined, false, undefined,
      body.history === null ? undefined : body.history, { runId, body, answer });
  };
  /** A changed agent cannot continue a saved run: the run ends, and its checkpoint is removed. */
  const refuseChanged = async (runId: string, body: CheckpointBody, local: RunState | undefined): Promise<never> => {
    await checkpoints!.store.delete({ runId, holderId: checkpoints!.replicaId }).catch(() => false);
    const error = new MayuraError('DEFINITION_CHANGED', 'The agent changed while the run waited for approval, so the run cannot continue.');
    if (local) local.endSuspended(error);
    else if (body.recording) await recorder!.complete({ runId, scope, binding: body.recording, messages: body.messages,
      approvals: body.approvals ?? [], outcome: outcomeFor(error) });
    throw error;
  };
  /** Handle one saved run whose approval request expired, as its policy says. */
  const expireRun = async (runId: string): Promise<boolean | RunHandle<unknown>> => {
    if (closed || !checkpoints) return false;
    const { body, agent, local } = await loadCheckpoint(runId);
    if (body.waitKind === 'frontend') {
      if (Date.now() < body.pending.expiresAtMs) return false;
      await requireAuthorization('run', runId, 'cancel'); await authorizeRecording(body.recording, 'cancel');
      await consumeExternalCheckpoint(runId, body);
      const error = new MayuraError('TIMEOUT', 'The external result wait expired. Browser actions must not be replayed.');
      if (local) local.endSuspended(error);
      else if (body.recording) await recorder!.complete({ runId, scope, binding: body.recording, messages: body.messages, approvals: body.approvals ?? [], outcome: outcomeFor(error) });
      return true;
    }
    await requireAuthorization('run', runId, 'approve'); await authorizeRecording(body.recording, 'approve');
    if (closed) return false;
    if (Date.now() < body.pending.expiresAtMs || !agent) return false;
    if (activeRoots >= rootLimits.maxConcurrentRuns && body.pending.onExpired === 'reject') return false;
    await authorizeSaved(runId, body, agent, false);
    await claimCheckpoint(runId);
    if (agentDigest(agent) !== body.agent.digest) await refuseChanged(runId, body, local);
    if (body.pending.onExpired === 'cancel') {
      await checkpoints!.store.delete({ runId, holderId: checkpoints!.replicaId }).catch(() => false);
      const error = new MayuraError('CANCELLED', 'The approval request expired, and the run was cancelled.');
      if (local) local.endSuspended(error);
      else if (body.recording) await recorder!.complete({ runId, scope, binding: body.recording, messages: body.messages,
        approvals: body.approvals ?? [], outcome: outcomeFor(error) });
      return true;
    }
    return resumeSaved(runId, body, agent, local, { decision: 'expired' });
  };
  /** Cancel a run this process paused: remove its checkpoint first, so no other runtime resumes it. */
  const cancelSuspended = async (paused: RunState): Promise<void> => {
    if (!checkpoints || !paused.suspended) return;
    if (paused.suspended.body.waitKind === 'frontend') {
      try { await consumeExternalCheckpoint(paused.id, paused.suspended.body); } catch { return; }
    } else {
      try { await claimCheckpoint(paused.id); } catch { return; }
      await checkpoints.store.delete({ runId: paused.id, holderId: checkpoints.replicaId }).catch(() => false);
    }
    if (paused.suspended) paused.endSuspended(new MayuraError('CANCELLED', 'Run cancellation was requested.'));
  };
  return Object.freeze({
    profile: 'ephemeral',
    ...(recorder ? { recorder } : {}),
    submit: <I extends Schema, O extends Schema>(agent: AgentDefinition<I, O>, submission: {
      readonly input: InferInput<I>; readonly media?: readonly Media[]; readonly history?: RunHistory; readonly recording?: JsonObject;
    }) => start(agent, submission.input, rootLimits, rootPermissions, undefined, false, undefined, false, submission.media, submission.history, undefined, submission.recording),
    spawn: <I extends Schema, O extends Schema>(parent: RunHandle<unknown>, agent: AgentDefinition<I, O>, submission: ChildOptions & { readonly input: InferInput<I>; readonly media?: readonly Media[] }) =>
      admitChild(lookup(parent), agent, submission.input, submission, false, undefined, false, submission.media),
    speculate: async <I extends Schema, O extends Schema>(parentHandle: RunHandle<unknown>, speculation: SpeculationOptions<I, O>): Promise<SpeculationResult<InferOutput<O>>> => {
      const parent = lookup(parentHandle);
      const branches = speculation?.branches; const verify = speculation?.verify;
      const verifyTimeoutMs = speculation?.verifyTimeoutMs ?? 5_000;
      if (!Array.isArray(branches) || branches.length < 1 || branches.length > 8 || typeof verify !== 'function'
        || !Number.isSafeInteger(verifyTimeoutMs) || verifyTimeoutMs < 1 || verifyTimeoutMs > 30_000
        || new Set(branches.map(branch => branch?.id)).size !== branches.length || branches.some(branch => !isIdentifier(branch?.id))) {
        throw new MayuraError('INVALID_CONFIG', 'Speculation needs 1–8 uniquely identified branches, a verify function and a bounded verify deadline.');
      }
      const prepared = await Promise.all(branches.map(async branch => {
        const permissions = permissionsFor(branch.permissions, true);
        // No speculative external writes, host execution, further delegation or durable memory promotion.
        if (permissions.allow.some(grant => grant === 'agent:delegate' || (grant.startsWith('effect:') && grant !== 'effect:read')
          || (grant.startsWith('memory:') && grant !== 'memory:read'))) {
          throw new MayuraError('PERMISSION_DENIED', 'Speculative branches cannot hold write, host, delegation or memory-mutation grants.');
        }
        let assumptions: JsonValue;
        try { assumptions = freezeJson(jsonValue(branch.assumptions, { maxBytes: 65_536 })); }
        catch { throw new MayuraError('INVALID_INPUT', 'Branch assumptions must be bounded plain JSON.'); }
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mayura:speculation-assumptions:v1\0${canonicalJson(assumptions)}`));
        return { branch, permissions, digest: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
      }));
      const handles: RunHandle<InferOutput<O>>[] = [];
      try {
        for (const { branch, permissions } of prepared) {
          handles.push(admitChild(parent, branch.agent, branch.input, { permissions, ...(branch.limits ? { limits: branch.limits } : {}) }, false, undefined, true));
        }
      } catch (error) { for (const handle of handles) handle.cancel(); throw error; }
      const outcomes = new Map<number, Outcome<InferOutput<O>>>(); const verified = new Set<number>();
      let winner: number | undefined;
      const pending = new Map(handles.map((handle, index) => [index, handle.result().then(outcome => ({ index, outcome }))]));
      while (pending.size > 0 && winner === undefined) {
        const { index, outcome } = await Promise.race(pending.values());
        pending.delete(index); outcomes.set(index, outcome);
        if (outcome.status !== 'succeeded') continue;
        let accepted = false;
        try {
          accepted = await new Promise<boolean>((resolve, reject) => {
            const timer = setTimeout(() => resolve(false), verifyTimeoutMs);
            Promise.resolve().then(() => verify(Object.freeze({ branchId: prepared[index]!.branch.id, assumptionsDigest: prepared[index]!.digest, output: outcome.output })))
              .then(value => { clearTimeout(timer); resolve(value === true); }, error => { clearTimeout(timer); reject(error); });
          });
        } catch { accepted = false; }
        if (accepted) { verified.add(index); winner = index; }
      }
      for (const [index, handle] of handles.entries()) if (index !== winner && !outcomes.has(index)) handle.cancel();
      for (const [index, promise] of pending) outcomes.set(index, (await promise).outcome);
      const promoted = winner === undefined ? undefined : outcomes.get(winner);
      return Object.freeze({
        status: winner === undefined ? 'none' as const : 'promoted' as const,
        ...(winner === undefined || promoted?.status !== 'succeeded' ? {} : { branchId: prepared[winner]!.branch.id, output: promoted.output, assumptionsDigest: prepared[winner]!.digest }),
        branches: Object.freeze(prepared.map(({ branch, digest }, index) => Object.freeze({ id: branch.id, runId: handles[index]!.id,
          status: outcomes.get(index)!.status, assumptionsDigest: digest, verified: verified.has(index) }))),
      });
    },
    inspect: (handle: RunHandle<unknown>): RunInspection => {
      const state = lookup(handle);
      const external = state.suspended?.body.waitKind === 'frontend';
      const pending = state.approval ?? state.suspended?.body.pending;
      return Object.freeze({ id: state.id, rootId: state.root.id, ...(state.parent ? { parentId: state.parent.id } : {}),
        agentId: state.agent.id, status: state.status,
        ...(pending ? { [external ? 'toolWait' : 'approval']: Object.freeze({ callId: pending.callId, toolId: pending.toolId, toolVersion: pending.toolVersion, input: pending.input,
          digest: pending.digest, expiresAtMs: pending.expiresAtMs }) } : {}),
        budget: state.budgetSnapshot(),
        runs: Object.freeze(subtree(state).map((run) => Object.freeze({ id: run.id, ...(run.parent ? { parentId: run.parent.id } : {}), agentId: run.agent.id, status: run.status }))),
        evidence: evidenceFor(state),
      });
    },
    transcript: (handle: RunHandle<unknown>): readonly ModelMessage[] => lookup(handle).transcript(),
    cancelSaved: async (runId: string): Promise<void> => {
      if (!checkpoints || closed) throw new MayuraError('NOT_FOUND', 'No saved run can be cancelled by this runtime.');
      await requireAuthorization('run', runId, 'cancel');
      const { body, local } = await loadCheckpoint(runId);
      if (body.waitKind === 'frontend') { await authorizeRecording(body.recording, 'cancel'); await consumeExternalCheckpoint(runId, body); }
      else {
        await claimCheckpoint(runId);
        const deleted = await checkpoints.store.delete({ runId, holderId: checkpoints.replicaId });
        if (!deleted) throw new MayuraError('CONFLICT', 'The checkpoint changed before cancellation.');
      }
      const error = new MayuraError('CANCELLED', 'Run cancellation was requested.');
      if (local) { local.endSuspended(error); await local.handle.result(); }
      else if (body.recording) await recorder!.complete({ runId, scope, binding: body.recording, messages: body.messages,
        approvals: body.approvals ?? [], outcome: outcomeFor(error) });
    },
    retryRecording: async (handle: RunHandle<unknown>): Promise<void> => {
      lookup(handle);
      const completion = pendingRecordings.get(handle);
      if (!completion) return;
      try { await recorder!.complete(completion); }
      catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'The conversation could not be recorded. Retry when storage is available.'); }
      pendingRecordings.delete(handle);
    },
    approve: async (run: RunHandle<unknown> | string, answer: ApprovalAnswer): Promise<RunHandle<unknown>> => {
      const reason = answer?.reason;
      if (!answer || typeof answer !== 'object' || typeof answer.callId !== 'string' || typeof answer.digest !== 'string'
        || (answer.decision !== 'approved' && answer.decision !== 'rejected') || !isIdentifier(answer.actorId)
        || (reason !== undefined && (typeof reason !== 'string' || reason.length > 1_000))) {
        throw new MayuraError('INVALID_INPUT', 'An approval answer needs callId, digest, decision (approved or rejected), actorId, and at most a 1,000-character reason.');
      }
      const decided: Answered = Object.freeze({ decision: answer.decision, actorId: answer.actorId, ...(reason === undefined ? {} : { reason }) });
      await requireAuthorization('run', typeof run === 'string' ? run : run.id, 'approve');
      const target = typeof run === 'string' ? active.get(run) ?? suspendedRuns.get(run)?.handle : run;
      const state = target ? lookup(target) : undefined;
      // Waiting in memory: recheck immediately before accepting this exact answer.
      if (state && !state.suspended) {
        const pending = state.approval;
        if (!pending || pending.callId !== answer.callId) throw new MayuraError('NOT_FOUND', 'This run is not waiting for an approval of that call.');
        if (Date.now() >= pending.expiresAtMs) throw new MayuraError('CONFLICT', 'The approval request has expired.');
        if (answer.digest !== pending.digest) throw new MayuraError('CONFLICT', 'The digest does not match the call waiting for approval.');
        await requireAuthorization('run', state.id, 'approve');
        await authorizeRecording(state.recording, 'approve');
        await requireAuthorization('run', state.id, 'execute'); await requireAuthorization('agent', state.agent.id, 'execute');
        if (decided.decision === 'approved') await requireAuthorization('tool', pending.toolId, 'execute');
        if (state.approval !== pending || Date.now() >= pending.expiresAtMs) throw new MayuraError('CONFLICT', 'The approval changed or expired during authorization.');
        pending.answer(decided);
        return state.handle;
      }
      // Saved to the store, by this process or another one.
      const runId = typeof run === 'string' ? run : state?.id;
      if (!checkpoints || runId === undefined) throw new MayuraError('NOT_FOUND', 'No active run has that id.');
      if (closed) throw new MayuraError('CONFLICT', 'Runtime is closed and cannot resume runs.');
      const { body, agent, local } = await loadCheckpoint(runId, 'approve');
      if (body.waitKind === 'frontend') throw new MayuraError('CONFLICT', 'External result waits cannot be approved.');
      if (body.pending.callId !== answer.callId) throw new MayuraError('NOT_FOUND', 'This run is not waiting for an approval of that call.');
      if (Date.now() >= body.pending.expiresAtMs) throw new MayuraError('CONFLICT', 'The approval request has expired.');
      if (answer.digest !== body.pending.digest) throw new MayuraError('CONFLICT', 'The digest does not match the call waiting for approval.');
      if (!agent) throw new MayuraError('NOT_FOUND', `This runtime cannot resume agent ${body.agent.id}: list it in checkpoints.agents.`);
      if (activeRoots >= rootLimits.maxConcurrentRuns) throw new MayuraError('LIMIT_EXCEEDED', 'The runtime concurrent-root limit is reached.');
      await requireAuthorization('run', runId, 'approve');
      await authorizeSaved(runId, body, agent, decided.decision === 'approved');
      if (Date.now() >= body.pending.expiresAtMs) throw new MayuraError('CONFLICT', 'The approval expired during authorization.');
      await claimCheckpoint(runId);
      if (agentDigest(agent) !== body.agent.digest) await refuseChanged(runId, body, local);
      return resumeSaved(runId, body, agent, local, decided);
    },
    resumeTool: async (runId: string, input: { readonly callId: string; readonly digest: string }) => {
      if (externalResumes.has(runId)) throw new MayuraError('CONFLICT', 'An external result resume is already in progress.');
      externalResumes.add(runId);
      try {
        if (!checkpoints || closed || !input || typeof input.callId !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) throw new MayuraError('INVALID_INPUT', 'Invalid external wait recovery command.');
        await requireAuthorization('run', runId, 'resume_tool');
        const { body, agent, local } = await loadCheckpoint(runId);
        if (body.waitKind !== 'frontend' || body.pending.callId !== input.callId || body.pending.digest !== input.digest
          || Date.now() >= body.pending.expiresAtMs) throw new MayuraError('CONFLICT', 'The external result checkpoint changed or expired.');
        if (!agent) throw new MayuraError('NOT_FOUND', 'The saved agent is not registered.');
        if (agentDigest(agent) !== body.agent.digest) throw new MayuraError('DEFINITION_CHANGED', 'The saved agent definition changed.');
        await authorizeSaved(runId, body, agent, true);
        const restored = restoreHandoff(agent, permissionsFor({ allow: (body.handoff?.sourcePermissions ?? body.permissions).filter(grant => rootPermissions.allow.includes(grant)) }), body.handoff?.path ?? [], body.permissions);
        const tool = restored.agent.tools.find(item => item.id === body.pending.toolId); const port = tool && toolContinuation(tool);
        if (!tool || !port || tool.version !== body.pending.toolVersion) throw new MayuraError('DEFINITION_CHANGED', 'The saved external tool changed.');
        const required = [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
        if (required.some(grant => !body.permissions.includes(grant) || !restored.permissions.allow.includes(grant))) throw new MayuraError('PERMISSION_DENIED', 'The external result requires its original tool grants.');
        const context = { runId, callId: input.callId, scope, signal: authorizationStop.signal };
        // Re-publication can repair a crash between checkpoint commit and frontend dispatch. It never runs the browser.
        await port.publish(body.preparedInput!, context, body.externalDigest!);
        if (!await port.ready(body.preparedInput!, context, body.externalDigest!)) return undefined;
        if (activeRoots >= rootLimits.maxConcurrentRuns) throw new MayuraError('LIMIT_EXCEEDED', 'The runtime concurrent-root limit is reached.');
        if (body.recording) await recorder!.begin({ runId, scope, binding: body.recording });
        if (closed || authorizationStop.signal.aborted || Date.now() >= body.pending.expiresAtMs) throw new MayuraError('CONFLICT', 'External recovery stopped or expired before consumption.');
        await consumeExternalCheckpoint(runId, body);
        externalConsumptions.add(body);
        return resumeSaved(runId, body, agent, local, { decision: 'approved' });
      } finally { externalResumes.delete(runId); }
    },
    expireApproval: async (runId: string) => {
      const result = await expireRun(runId);
      return typeof result === 'boolean' ? Object.freeze({ status: result ? 'cancelled' as const : 'not_due' as const }) : Object.freeze({ status: 'resumed' as const, run: result });
    },
    expireApprovals: async (expiry?: { readonly limit?: number }): Promise<number> => {
      const limit = expiry?.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MayuraError('INVALID_INPUT', 'limit must be 1 to 100.');
      if (!checkpoints || closed) return 0;
      let due: readonly string[];
      try { due = await checkpoints.store.due({ expiresBeforeMs: Date.now(), limit }); }
      catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'The run checkpoint store could not be read.'); }
      let handled = 0;
      // Other scopes' runs are listed too; loadCheckpoint skips them, as expireRun skips runs it cannot resume.
      for (const runId of due) if (await expireRun(runId).catch(() => false)) handled++;
      return handled;
    },
    close: async (): Promise<void> => {
      closed = true; authorizationStop.abort();
      // Runs paused to the store stay there, for this or another runtime to resume; only their timers stop here.
      for (const paused of suspendedRuns.values()) clearTimeout(paused.suspended?.expiry);
      const runs = [...active.values()];
      for (const run of runs) run.cancel();
      await Promise.all(runs.map((run) => run.result()));
    },
  });
}
