import {
  assertPositiveInteger,
  assertSchema,
  assertBudget,
  Budget,
  freezeJson,
  jsonValue,
  MayuraError,
  validate,
  type Effect,
  type ExecutionContext,
  type ExecutionReceipt,
  type ExecutionSettlement,
  type PublicError,
  type Guard,
  type InferInput,
  type InferOutput,
  type JsonObject,
  type JsonValue,
  type Outcome,
  type Permissions,
  type Schema,
} from '@mayura/core';
import { snapshotLocalGuards } from '@mayura/core/host';

export { batchOutput, invokeBatch, type BatchCall, type BatchInput, type BatchOutputPathSegment,
  type BatchOutputReference, type InvokeBatchOptions, type BatchCallResult, type BatchOutcome,
  type BatchAdmissionRequest, type BatchAdmissionDecision, type SkippedBatchOutcome, type WaitingBatchOutcome } from './batch.js';
export { createToolContextSlot, type ToolContextSlot, type ToolContextBinding } from './context.js';
import { attachToolContext, type ToolContextBinding } from './context.js';
import { claimToolBudgetTicket, type ToolBudgetTicketBinding } from './budget-binding.js';
export type { ToolBudgetTicketBinding } from './budget-binding.js';

/** Authoring contract. Executors are trusted application code, not sandboxed callbacks. */
export interface ToolExecutionContext extends ExecutionContext {
  /** Report dynamic usage once. Omission conservatively charges the declared maximum. */
  readonly reportUsage: (settlement: ExecutionSettlement) => void;
}

export interface ToolOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly effects: Effect;
  readonly capabilities: readonly string[];
  readonly execute: (input: InferOutput<I>, context: ToolExecutionContext) => InferInput<O> | Promise<InferInput<O>>;
  readonly timeoutMs?: number;
  readonly costMicros?: number;
  readonly inputJsonSchema?: JsonObject;
  readonly guards?: { readonly input?: readonly Guard[]; readonly output?: readonly Guard[] };
}

/** Immutable public metadata; intentionally does not expose a callable executor. */
export interface ToolDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly effects: Effect;
  readonly capabilities: readonly string[];
  readonly timeoutMs: number;
  readonly costMicros: number;
  readonly inputJsonSchema?: JsonObject;
}

export type AnyTool = ToolDefinition<Schema, Schema>;
export type ToolOutput<T extends AnyTool> = InferOutput<T['output']>;
export interface InvokeToolContext extends ExecutionContext {
  readonly permissions: Permissions;
  readonly budget: Budget;
  /** Trusted-host pre-reserved invocation; still subject to every ordinary broker admission check. */
  readonly budgetBinding?: ToolBudgetTicketBinding;
  readonly maxOutputBytes?: number;
  /** Opaque trusted extension bindings; never copied into observable metadata or messages. */
  readonly contextBindings?: readonly ToolContextBinding[];
  /** Trusted operation limiter. Queuing conveys no permission; admission is rechecked afterward. */
  readonly acquireExecution?: (signal: AbortSignal) => Promise<() => void>;
  /** Trusted callback limiter; each schema/guard retains its permit until its actual promise settles. */
  readonly acquireCallback?: (signal: AbortSignal) => Promise<() => void>;
  /** Trusted admission recheck for persisted claims/digests; cannot alter input or grant authority. */
  readonly beforeDispatch?: (validatedInput: JsonValue) => Promise<void>;
  /** Trusted mandatory persistence seam, not an observational or authorization hook. */
  readonly onExecutionReceipt?: (receipt: ExecutionReceipt, settlement: ExecutionSettlement) => Promise<void>;
}

interface Registration {
  readonly execute: (input: unknown, context: ToolExecutionContext) => unknown;
  readonly inputGuards: readonly Guard[];
  readonly outputGuards: readonly Guard[];
}

const registrations = new WeakMap<object, Registration>();
const identifier = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;

/** Capture the complete invocation envelope before identity checks; accessors cannot swap a checked account. */
function snapshotInvocation(value: InvokeToolContext): InvokeToolContext {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const required = ['runId', 'callId', 'scope', 'signal', 'permissions', 'budget'];
    const optional = ['maxOutputBytes', 'contextBindings', 'acquireExecution', 'acquireCallback', 'beforeDispatch', 'onExecutionReceipt', 'budgetBinding'];
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
      || required.some(key => !fields[key])) throw new Error();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(fields)) {
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error();
      if (descriptor.value !== undefined || required.includes(key)) result[key] = descriptor.value;
    }
    const scope = jsonValue(result['scope'], { maxBytes: 2_048 });
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length !== 2
      || !Object.hasOwn(scope, 'principalId') || !Object.hasOwn(scope, 'projectId')) throw new Error();
    const permissions = jsonValue(result['permissions'], { maxBytes: 2_097_152 });
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)
      || Object.keys(permissions).length !== 1 || !Object.hasOwn(permissions, 'allow')) throw new Error();
    result['scope'] = freezeJson(scope); result['permissions'] = freezeJson(permissions);
    return Object.freeze(result) as unknown as InvokeToolContext;
  } catch { throw new MayuraError('INVALID_CONFIG', 'Tool invocation requires a plain data configuration with explicit scope, grants and accounting.'); }
}

const errorMessages = {
  INVALID_CONFIG: 'Tool invocation configuration is invalid.', INVALID_INPUT: 'Tool input did not pass its admission boundary.',
  INVALID_OUTPUT: 'Tool output did not pass its disclosure boundary.', INVALID_JSON: 'Tool data must be bounded plain JSON.',
  PERMISSION_DENIED: 'Tool invocation was not authorized.', BUDGET_EXCEEDED: 'The execution budget could not admit or settle this tool.',
  LIMIT_EXCEEDED: 'A tool execution limit was reached.', CANCELLED: 'Tool execution was cancelled.', TIMEOUT: 'Tool execution exceeded its deadline.',
  TOOL_FAILED: 'The tool executor failed; raw exception details are withheld.', GUARD_BLOCKED: 'A required guard withheld this operation or output.',
  GUARD_UNAVAILABLE: 'A required guard could not establish a verdict.', CONFLICT: 'The tool invocation authority is no longer available.',
} as const;
/** Even configuration/reflection exceptions that imitate framework errors never supply public text. */
function safeToolFailure(error: unknown): PublicError {
  let code: keyof typeof errorMessages = 'INVALID_CONFIG';
  try {
    const descriptor = error instanceof MayuraError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof value === 'string' && Object.hasOwn(errorMessages, value)) code = value as keyof typeof errorMessages;
  } catch { /* Hostile exception objects cannot control diagnostics. */ }
  return { code, message: errorMessages[code] };
}

/**
 * Throw from a tool's `execute` to say it refused the call before causing any external effect, for example because
 * the ticket does not exist or the request is not allowed. The call is recorded as not started: its outcome is
 * `failed` (never `outcome_unknown`), its reservation is released, and a durable run needs no reconciliation.
 * Throw it only when that is true; any other exception from a tool with effects is treated as possibly executed.
 * A refusal ends an agent's run; to let the model continue instead, return a result that says what happened.
 */
export class ToolRefusal extends MayuraError {
  /**
   * `reason` (at most 512 characters) replaces the generic message in the failed outcome, where the application and
   * the person see it, for example "The person declined this action." It is not sent to the model.
   */
  constructor(reason?: string) {
    super('TOOL_FAILED', typeof reason === 'string' && reason.length > 0 && reason.length <= 512 ? reason : 'The tool refused the call before any external effect.');
  }
}

/** Rejects forged or foreign-instance tool metadata before any model or effect dispatch. */
export function assertTool(tool: AnyTool): void {
  if (!registrations.has(tool)) throw new MayuraError('INVALID_CONFIG', 'Tool was not created by this tools package instance.');
}

function text(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new MayuraError('INVALID_CONFIG', `${name} must be a bounded nonempty string.`);
  }
}

function snapshotSchema<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  assertSchema(schema);
  const standard = schema['~standard'];
  // Capture the validator reference without freezing or mutating the consumer's library object.
  return Object.freeze({
    '~standard': Object.freeze({
      version: 1 as const,
      vendor: standard.vendor,
      validate: standard.validate.bind(standard),
    }),
  }) as Schema<InferInput<S>, InferOutput<S>>;
}

function snapshotGuards(guards: readonly Guard[] = []): readonly Guard[] {
  return snapshotLocalGuards(guards);
}

/** Defines a tool once; all supported invocation paths use invokeTool's policy boundary. */
export function defineTool<I extends Schema, O extends Schema>(options: ToolOptions<I, O>): ToolDefinition<I, O> {
  if (!options || !identifier.test(options.id)) throw new MayuraError('INVALID_CONFIG', 'Tool id must be a bounded identifier.');
  text(options.version, 'version', 128);
  text(options.description, 'description', 4096);
  if (!['none', 'read', 'write', 'host'].includes(options.effects)) throw new MayuraError('INVALID_CONFIG', 'Unknown tool effect category.');
  if (!Array.isArray(options.capabilities) || options.capabilities.length > 128) throw new MayuraError('INVALID_CONFIG', 'Tool capabilities must be a bounded array.');
  const capabilities = options.capabilities.map((capability) => { text(capability, 'capability', 256); return capability; });
  if (new Set(capabilities).size !== capabilities.length) throw new MayuraError('INVALID_CONFIG', 'Tool capabilities must be unique.');
  if (typeof options.execute !== 'function') throw new MayuraError('INVALID_CONFIG', 'A tool executor is required.');
  const timeoutMs = options.timeoutMs ?? 30_000;
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'timeoutMs exceeds the supported timer range.');
  const costMicros = options.costMicros ?? 0;
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new MayuraError('INVALID_CONFIG', 'costMicros must be a non-negative safe integer.');
  const inputJsonSchema = options.inputJsonSchema === undefined ? undefined : freezeJson(jsonValue(options.inputJsonSchema));
  if (inputJsonSchema !== undefined && (inputJsonSchema === null || Array.isArray(inputJsonSchema) || typeof inputJsonSchema !== 'object')) {
    throw new MayuraError('INVALID_CONFIG', 'inputJsonSchema must be a JSON object.');
  }
  const definition: ToolDefinition<I, O> = Object.freeze({
    id: options.id,
    version: options.version,
    description: options.description,
    input: snapshotSchema(options.input),
    output: snapshotSchema(options.output),
    effects: options.effects,
    capabilities: Object.freeze(capabilities),
    timeoutMs,
    costMicros,
    ...(inputJsonSchema === undefined ? {} : { inputJsonSchema }),
  });
  const execute = options.execute;
  registrations.set(definition, {
    execute: (input, context) => execute(input as InferOutput<I>, context),
    inputGuards: snapshotGuards(options.guards?.input),
    outputGuards: snapshotGuards(options.guards?.output),
  });
  return definition;
}

/**
 * The same tool, with `preflight` run on the validated input before its executor. A preflight that throws stops the
 * call before any effect; throw `ToolRefusal` to record it as not started (for example when a person declines).
 * `extraTimeoutMs` lengthens the tool's timeout for a preflight that waits, for example on a person.
 */
export function withPreflight<T extends AnyTool>(tool: T,
  preflight: (input: InferOutput<T['input']>, context: ToolExecutionContext) => void | Promise<void>,
  options: { readonly extraTimeoutMs?: number; readonly description?: string } = {}): T {
  const registration = registrations.get(tool); if (!registration) throw new MayuraError('INVALID_CONFIG', 'Tool was not created by this tools package instance.');
  if (typeof preflight !== 'function') throw new MayuraError('INVALID_CONFIG', 'A preflight function is required.');
  const extra = options.extraTimeoutMs ?? 0;
  if (!Number.isSafeInteger(extra) || extra < 0) throw new MayuraError('INVALID_CONFIG', 'extraTimeoutMs must be a non-negative integer.');
  const timeoutMs = tool.timeoutMs + extra; if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'timeoutMs exceeds the supported timer range.');
  if (options.description !== undefined) text(options.description, 'description', 4096);
  const definition = Object.freeze({ ...tool, description: options.description ?? tool.description, timeoutMs }) as T;
  registrations.set(definition, { ...registration, execute: async (input, context) => {
    await preflight(input as InferOutput<T['input']>, context);
    return registration.execute(input, context);
  } });
  return definition;
}

/**
 * The standalone tool broker: snapshot, authorize, validate, guard, reserve, execute, disclose.
 * Async work is bounded; trusted synchronous callbacks cannot be forcibly interrupted here.
 */
export async function invokeTool<T extends AnyTool>(
  tool: T, input: unknown, options: InvokeToolContext,
): Promise<Outcome<ToolOutput<T>>> {
  let execution: ExecutionReceipt['execution'] = 'not_started';
  let dispatched = false;
  // The executor declared, with ToolRefusal, that it caused no effect.
  let refused = false; let refusalReason = 'The tool refused the call before any external effect.';
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let externalSignal: AbortSignal | undefined;
  let relayAbort: (() => void) | undefined;
  let rejectOnAbort: (() => void) | undefined;
  let abortKind: 'CANCELLED' | 'TIMEOUT' = 'CANCELLED';
  let context: ExecutionContext | undefined;
  let registered: Registration | undefined;
  let persistenceStarted = false;
  let persistenceConfirmed = false;
  let hasCallbackLimiter = false;
  let reportedUsage: ExecutionSettlement | undefined;
  let handlerActive = false;
  const receipt = (disclosure: ExecutionReceipt['disclosure']): ExecutionReceipt | undefined => context && registered
    ? Object.freeze({ callId: context.callId, toolId: tool.id, execution, disclosure })
    : undefined;

  try {
    options = snapshotInvocation(options);
    assertTool(tool);
    registered = registrations.get(tool);
    if (!registered) throw new MayuraError('INVALID_CONFIG', 'Tool was not created by this tools package instance.');
    text(options.runId, 'runId', 256);
    text(options.callId, 'callId', 256);
    text(options.scope?.principalId, 'scope.principalId', 256);
    text(options.scope?.projectId, 'scope.projectId', 256);
    if (!(options.signal instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'An AbortSignal is required.');
    assertBudget(options.budget);
    if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4096) throw new MayuraError('INVALID_CONFIG', 'Permissions must be a bounded grant list.');
    const grants = new Set(options.permissions.allow.map((grant) => { text(grant, 'grant', 384); return grant; }));
    const budget = options.budget;
    const acquireExecution = options.acquireExecution;
    if (acquireExecution !== undefined && typeof acquireExecution !== 'function') throw new MayuraError('INVALID_CONFIG', 'acquireExecution must be a function.');
    const acquireCallback = options.acquireCallback;
    if (acquireCallback !== undefined && typeof acquireCallback !== 'function') throw new MayuraError('INVALID_CONFIG', 'acquireCallback must be a function.');
    hasCallbackLimiter = acquireCallback !== undefined;
    const beforeDispatch = options.beforeDispatch;
    if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw new MayuraError('INVALID_CONFIG', 'beforeDispatch must be a function.');
    const onExecutionReceipt = options.onExecutionReceipt;
    if (onExecutionReceipt !== undefined && typeof onExecutionReceipt !== 'function') throw new MayuraError('INVALID_CONFIG', 'onExecutionReceipt must be a function.');
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');
    externalSignal = options.signal;
    controller = new AbortController();
    const signal = controller.signal;
    const reportUsage = (value: ExecutionSettlement): void => {
      if (!handlerActive || reportedUsage !== undefined || !value || typeof value !== 'object'
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new MayuraError('INVALID_CONFIG', 'Tool usage must be reported exactly once during execution.');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== 2 || !descriptors['knownCostMicros'] || !descriptors['unknownCostMicros']
        || !('value' in descriptors['knownCostMicros']) || !('value' in descriptors['unknownCostMicros'])) {
        throw new MayuraError('INVALID_CONFIG', 'Tool usage must contain exact known and unknown cost fields.');
      }
      const knownCostMicros = descriptors['knownCostMicros'].value;
      const unknownCostMicros = descriptors['unknownCostMicros'].value;
      if (!Number.isSafeInteger(knownCostMicros) || knownCostMicros < 0 || !Number.isSafeInteger(unknownCostMicros)
        || unknownCostMicros < 0 || knownCostMicros > tool.costMicros - unknownCostMicros) {
        throw new MayuraError('BUDGET_EXCEEDED', 'Reported tool usage exceeds its admitted cost bound.');
      }
      reportedUsage = Object.freeze({ knownCostMicros, unknownCostMicros });
    };
    context = Object.freeze({
      runId: options.runId,
      callId: options.callId,
      scope: Object.freeze({ principalId: options.scope.principalId, projectId: options.scope.projectId }),
      signal,
      reportUsage,
    }) as ToolExecutionContext;
    const executionContext = context as ToolExecutionContext;
    const startReservation = options.budgetBinding === undefined ? undefined
      : claimToolBudgetTicket(options.budgetBinding, tool, { ...executionContext, budget, signal: externalSignal });
    attachToolContext(executionContext, options.contextBindings);
    const registration = registered;
    const abortError = (): MayuraError => new MayuraError(abortKind, abortKind === 'TIMEOUT' ? 'Tool execution exceeded its deadline.' : 'Tool execution was cancelled.');
    const assertActive = (): void => { if (signal.aborted) throw abortError(); };
    relayAbort = (): void => { if (!signal.aborted) { abortKind = 'CANCELLED'; controller?.abort(); } };
    externalSignal.addEventListener('abort', relayAbort, { once: true });
    if (externalSignal.aborted) relayAbort();
    assertActive();
    const required = [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
    if (!required.every((grant) => grants.has(grant))) throw new MayuraError('PERMISSION_DENIED', 'The tool requires capabilities that this invocation has not been granted.');
    // Copy before any await so caller mutation cannot replace a validated or authorized value.
    let inputSnapshot: JsonValue;
    try { inputSnapshot = freezeJson(jsonValue(input)); }
    catch { throw new MayuraError('INVALID_INPUT', 'Tool input must be bounded plain JSON.'); }

    const bounded = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = (): void => { reject(abortError()); };
      signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    timer = setTimeout(() => { if (!signal.aborted) { abortKind = 'TIMEOUT'; controller?.abort(); } }, tool.timeoutMs);

    /**
     * Logical broker cancellation must not release an actual pending callback's capacity.
     * A late permit is instead released without dispatch; this promise owns its permit
     * independently of the outer timeout race, and never nests another acquisition.
     */
    const callback = async <R>(operation: () => R | PromiseLike<R>): Promise<R> => {
      assertActive();
      let release: (() => void) | undefined;
      if (acquireCallback) {
        try {
          const admitted = await acquireCallback(signal);
          if (typeof admitted !== 'function') throw new Error();
          release = admitted;
        } catch {
          assertActive();
          throw new MayuraError('TOOL_FAILED', 'The callback scheduler could not admit this operation.');
        }
      }
      try { assertActive(); return await operation(); }
      finally {
        if (release) {
          try { release(); }
          catch { throw new MayuraError('TOOL_FAILED', 'The callback scheduler could not release its admission.'); }
        }
      }
    };

    const barrier = async (guards: readonly Guard[], value: JsonValue, boundary: 'input' | 'output'): Promise<void> => {
      assertActive();
      const verdicts = await Promise.all(guards.map(guard => callback(async () => {
        try {
          const verdict = await guard.check(value, Object.freeze({ ...executionContext, boundary }));
          const decision = verdict?.decision;
          if (decision !== 'allow' && decision !== 'block') throw new Error();
          return decision;
        } catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A required guard could not establish a safe verdict.'); }
      })));
      assertActive();
      if (verdicts.includes('block')) throw new MayuraError('GUARD_BLOCKED', 'A required guard withheld this operation or output.');
    };

    const work = async (): Promise<Outcome<ToolOutput<T>>> => {
      const parsedInput = freezeJson(jsonValue(await callback(() => validate(tool.input, inputSnapshot, 'input'))));
      assertActive();
      await barrier(registration.inputGuards, parsedInput, 'input');
      assertActive();
      let releaseExecution: (() => void) | undefined;
      if (acquireExecution) {
        try {
          const release = await acquireExecution(signal);
          if (typeof release !== 'function') throw new Error();
          releaseExecution = () => {
            try { release(); }
            catch { throw new MayuraError('TOOL_FAILED', 'The execution scheduler could not release its admission.'); }
          };
        } catch {
          assertActive();
          throw new MayuraError('TOOL_FAILED', 'The execution scheduler could not admit this operation.');
        }
      }
      let reservation;
      try {
        assertActive();
        if (beforeDispatch) {
          try { await beforeDispatch(parsedInput); }
          catch { throw new MayuraError('PERMISSION_DENIED', 'Tool admission could not be verified against its current execution claim.'); }
          assertActive();
        }
        reservation = startReservation ? startReservation() : budget.reserve(tool.costMicros);
      }
      catch (error) { releaseExecution?.(); throw error; }
      dispatched = true;
      let settlement: ExecutionSettlement | undefined;
      const usage = (): ExecutionSettlement => settlement ??= reportedUsage ?? Object.freeze(execution === 'unknown'
        ? { knownCostMicros: 0, unknownCostMicros: tool.costMicros }
        : { knownCostMicros: tool.costMicros, unknownCostMicros: 0 });
      const persistReceipt = async (): Promise<void> => {
        const knownReceipt = receipt('withheld');
        if (onExecutionReceipt && knownReceipt) {
          persistenceStarted = true;
          try { await onExecutionReceipt(knownReceipt, usage()); }
          catch { throw new MayuraError('OUTCOME_UNKNOWN', 'Execution receipt could not be confirmed in persistent storage. Do not replay this operation.'); }
          persistenceConfirmed = true;
        }
      };
      let rawOutput: unknown;
      let releaseFailure: unknown;
      try {
        handlerActive = true;
        rawOutput = await registration.execute(parsedInput, executionContext);
        handlerActive = false;
        if (reportedUsage && reportedUsage.unknownCostMicros > 0) {
          execution = 'unknown';
          throw new MayuraError('OUTCOME_UNKNOWN', 'Reported usage contains unresolved external cost.');
        }
        execution = 'succeeded';
        reservation.settle(usage().knownCostMicros);
      }
      catch (thrown) {
        handlerActive = false;
        // A refusal is believed only when the tool reported no usage: usage means something was spent.
        if (thrown instanceof ToolRefusal && !reportedUsage && execution === 'not_started') {
          // The reason is the tool author's own words (ToolRefusal), unlike raw exceptions, which stay withheld.
          refused = true; refusalReason = thrown.message; settlement = Object.freeze({ knownCostMicros: 0, unknownCostMicros: 0 });
        } else if (execution !== 'unknown') execution = tool.effects === 'none' ? 'failed' : 'unknown';
        const observed = usage();
        reservation.settleUsage(observed.knownCostMicros, observed.unknownCostMicros);
        await persistReceipt();
        assertActive();
        throw new MayuraError('TOOL_FAILED', 'The tool executor failed; raw exception details are withheld.');
      }
      finally {
        try { releaseExecution?.(); }
        catch (error) { releaseFailure = error; }
      }
      // A deadline withholds disclosure, not evidence. Late completion must still settle
      // known usage and persist its receipt without changing an already-returned outcome.
      await persistReceipt();
      assertActive();
      if (releaseFailure) throw releaseFailure;
      const parsedOutput = freezeJson(jsonValue(await callback(() => validate(tool.output, rawOutput, 'output', { maxBytes: maxOutputBytes })), { maxBytes: maxOutputBytes }));
      assertActive();
      await barrier(registration.outputGuards, parsedOutput, 'output');
      assertActive();
      const successfulReceipt = receipt('released');
      return Object.freeze({ status: 'succeeded' as const, output: parsedOutput as ToolOutput<T>, ...(successfulReceipt ? { receipt: successfulReceipt } : {}) });
    };

    return await Promise.race([work(), bounded]);
  } catch (error) {
    const observedExecution = execution as ExecutionReceipt['execution'];
    if (refused) { /* The executor declared no effect: keep `not_started`. */ }
    else if (dispatched && observedExecution !== 'succeeded' && tool.effects !== 'none') execution = 'unknown';
    else if (dispatched && observedExecution === 'not_started') execution = 'unknown';
    // A cancelled pure computation can still finish later. Its execution evidence is unknown,
    // while the requested result is cancelled/timed out; only uncertain effects force reconciliation.
    const unknown = (execution === 'unknown' && (tool.effects !== 'none' || (reportedUsage?.unknownCostMicros ?? 0) > 0))
      || (persistenceStarted && !persistenceConfirmed);
    const safeError = unknown
      ? { code: 'OUTCOME_UNKNOWN' as const, message: 'The external operation may have occurred. Reconcile its outcome before retrying.' }
      : refused ? { code: 'TOOL_FAILED' as const, message: refusalReason }
        : safeToolFailure(error);
    const status = unknown ? 'outcome_unknown' as const
      : safeError.code === 'CANCELLED' ? 'cancelled' as const
        : ['PERMISSION_DENIED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE', 'BUDGET_EXCEEDED'].includes(safeError.code) ? 'blocked' as const : 'failed' as const;
    const withheldReceipt = receipt('withheld');
    return Object.freeze({ status, error: Object.freeze(safeError), ...(withheldReceipt ? { receipt: withheldReceipt } : {}) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal && relayAbort) externalSignal.removeEventListener('abort', relayAbort);
    if (controller && rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    // A rejected parallel barrier may leave waiters even when the deadline did not fire.
    // Cancel queued host admissions, but their actual callbacks keep their own permits.
    if (hasCallbackLimiter) controller?.abort();
  }
}
