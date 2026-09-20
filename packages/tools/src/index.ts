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
  type Guard,
  type InferInput,
  type InferOutput,
  type JsonObject,
  type JsonValue,
  type Outcome,
  type Permissions,
  type Schema,
} from '@mayura/core';

export { invokeBatch, type BatchCall, type InvokeBatchOptions, type BatchCallResult, type SkippedBatchOutcome } from './batch.js';
export { createToolContextSlot, type ToolContextSlot, type ToolContextBinding } from './context.js';
import { attachToolContext, type ToolContextBinding } from './context.js';

/** Authoring contract. Executors are trusted application code, not sandboxed callbacks. */
export interface ToolOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly effects: Effect;
  readonly capabilities: readonly string[];
  readonly execute: (input: InferOutput<I>, context: ExecutionContext) => InferInput<O> | Promise<InferInput<O>>;
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
  readonly maxOutputBytes?: number;
  /** Opaque trusted extension bindings; never copied into observable metadata or messages. */
  readonly contextBindings?: readonly ToolContextBinding[];
  /** Trusted operation limiter. Queuing conveys no permission; admission is rechecked afterward. */
  readonly acquireExecution?: (signal: AbortSignal) => Promise<() => void>;
  /** Trusted admission recheck for persisted claims/digests; cannot alter input or grant authority. */
  readonly beforeDispatch?: (validatedInput: JsonValue) => Promise<void>;
  /** Trusted mandatory persistence seam, not an observational or authorization hook. */
  readonly onExecutionReceipt?: (receipt: ExecutionReceipt) => Promise<void>;
}

interface Registration {
  readonly execute: (input: unknown, context: ExecutionContext) => unknown;
  readonly inputGuards: readonly Guard[];
  readonly outputGuards: readonly Guard[];
}

const registrations = new WeakMap<object, Registration>();
const identifier = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;

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
  if (!Array.isArray(guards) || guards.length > 32) {
    throw new MayuraError('INVALID_CONFIG', 'A guard boundary supports at most 32 guards.');
  }
  return Object.freeze(guards.map((guard) => {
    text(guard?.id, 'guard.id', 128);
    if (typeof guard.check !== 'function') throw new MayuraError('INVALID_CONFIG', 'A guard check is required.');
    return Object.freeze({ id: guard.id, check: guard.check.bind(guard) });
  }));
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
 * The standalone tool broker: snapshot, authorize, validate, guard, reserve, execute, disclose.
 * Async work is bounded; trusted synchronous callbacks cannot be forcibly interrupted here.
 */
export async function invokeTool<T extends AnyTool>(
  tool: T, input: unknown, options: InvokeToolContext,
): Promise<Outcome<ToolOutput<T>>> {
  let execution: ExecutionReceipt['execution'] = 'not_started';
  let dispatched = false;
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
  const receipt = (disclosure: ExecutionReceipt['disclosure']): ExecutionReceipt | undefined => context && registered
    ? Object.freeze({ callId: context.callId, toolId: tool.id, execution, disclosure })
    : undefined;

  try {
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
    const beforeDispatch = options.beforeDispatch;
    if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw new MayuraError('INVALID_CONFIG', 'beforeDispatch must be a function.');
    const onExecutionReceipt = options.onExecutionReceipt;
    if (onExecutionReceipt !== undefined && typeof onExecutionReceipt !== 'function') throw new MayuraError('INVALID_CONFIG', 'onExecutionReceipt must be a function.');
    const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
    assertPositiveInteger(maxOutputBytes, 'maxOutputBytes');
    externalSignal = options.signal;
    controller = new AbortController();
    const signal = controller.signal;
    context = Object.freeze({
      runId: options.runId,
      callId: options.callId,
      scope: Object.freeze({ principalId: options.scope.principalId, projectId: options.scope.projectId }),
      signal,
    });
    const executionContext = context;
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

    const barrier = async (guards: readonly Guard[], value: JsonValue, boundary: 'input' | 'output'): Promise<void> => {
      assertActive();
      const verdicts = await Promise.all(guards.map(async (guard) => {
        try {
          const verdict = await guard.check(value, Object.freeze({ ...executionContext, boundary }));
          const decision = verdict?.decision;
          if (decision !== 'allow' && decision !== 'block') throw new Error();
          return decision;
        } catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A required guard could not establish a safe verdict.'); }
      }));
      assertActive();
      if (verdicts.includes('block')) throw new MayuraError('GUARD_BLOCKED', 'A required guard withheld this operation or output.');
    };

    const work = async (): Promise<Outcome<ToolOutput<T>>> => {
      const parsedInput = freezeJson(jsonValue(await validate(tool.input, inputSnapshot, 'input')));
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
        reservation = budget.reserve(tool.costMicros);
      }
      catch (error) { releaseExecution?.(); throw error; }
      dispatched = true;
      const persistReceipt = async (): Promise<void> => {
        const knownReceipt = receipt('withheld');
        if (onExecutionReceipt && knownReceipt) {
          persistenceStarted = true;
          try { await onExecutionReceipt(knownReceipt); }
          catch { throw new MayuraError('OUTCOME_UNKNOWN', 'Execution receipt could not be confirmed in persistent storage. Do not replay this operation.'); }
          persistenceConfirmed = true;
        }
      };
      let rawOutput: unknown;
      let releaseFailure: unknown;
      try {
        rawOutput = await registration.execute(parsedInput, executionContext);
        execution = 'succeeded';
        reservation.settle(tool.costMicros);
      }
      catch {
        execution = tool.effects === 'none' ? 'failed' : 'unknown';
        if (tool.effects === 'none') reservation.settle(tool.costMicros);
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
      const parsedOutput = freezeJson(jsonValue(await validate(tool.output, rawOutput, 'output', { maxBytes: maxOutputBytes }), { maxBytes: maxOutputBytes }));
      assertActive();
      await barrier(registration.outputGuards, parsedOutput, 'output');
      assertActive();
      const successfulReceipt = receipt('released');
      return Object.freeze({ status: 'succeeded' as const, output: parsedOutput as ToolOutput<T>, ...(successfulReceipt ? { receipt: successfulReceipt } : {}) });
    };

    return await Promise.race([work(), bounded]);
  } catch (error) {
    const observedExecution = execution as ExecutionReceipt['execution'];
    if (dispatched && observedExecution !== 'succeeded' && tool.effects !== 'none') execution = 'unknown';
    else if (dispatched && observedExecution === 'not_started') execution = 'unknown';
    // A cancelled pure computation can still finish later. Its execution evidence is unknown,
    // while the requested result is cancelled/timed out; only uncertain effects force reconciliation.
    const unknown = (execution === 'unknown' && tool.effects !== 'none') || (persistenceStarted && !persistenceConfirmed);
    const safeError = unknown
      ? { code: 'OUTCOME_UNKNOWN' as const, message: 'The external operation may have occurred. Reconcile its outcome before retrying.' }
      : error instanceof MayuraError
        ? error.toJSON()
        : { code: 'INVALID_CONFIG' as const, message: 'Tool invocation configuration is invalid.' };
    const status = unknown ? 'outcome_unknown' as const
      : safeError.code === 'CANCELLED' ? 'cancelled' as const
        : ['PERMISSION_DENIED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE', 'BUDGET_EXCEEDED'].includes(safeError.code) ? 'blocked' as const : 'failed' as const;
    const withheldReceipt = receipt('withheld');
    return Object.freeze({ status, error: Object.freeze(safeError), ...(withheldReceipt ? { receipt: withheldReceipt } : {}) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (externalSignal && relayAbort) externalSignal.removeEventListener('abort', relayAbort);
    if (controller && rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}
