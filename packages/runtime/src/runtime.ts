import {
  assertPositiveInteger, Budget, freezeJson, jsonValue, MayuraError, ModelInvocationError, publicError, validate,
  type Guard, type InferInput, type InferOutput, type JsonValue, type ModelMessage, type ModelRequest,
  type Outcome, type Permissions, type RunHandle, type Schema, type Scope,
} from '@mayura/core';
import { invokeTool, type AnyTool } from '@mayura/tools';
import { assertAgent, isIdentifier, type AgentDefinition } from './agent.js';
import { EventBuffer } from './event-buffer.js';
import { modelCost, modelResponse } from './response.js';

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
  readonly maxConcurrentRuns?: number;
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
  /** Stop admissions, request cancellation, and wait for accepted runs to reach a terminal outcome. */
  close(): Promise<void>;
}

const defaults: Required<RuntimeLimits> = Object.freeze({
  maxSteps: 16, maxModelCalls: 16, maxToolCalls: 64, maxDurationMs: 60_000,
  maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576, maxContextBytes: 2_097_152,
  maxOutputTokens: 4_096, maxCostMicros: 0, maxEventRetention: 256, maxConcurrentRuns: 32,
});

function limitsFor(options: RuntimeLimits | undefined): Required<RuntimeLimits> {
  const result = { ...defaults, ...options };
  for (const [key, value] of Object.entries(result)) {
    if (key === 'maxCostMicros') {
      if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'maxCostMicros must be a non-negative safe integer.');
    } else assertPositiveInteger(value, key);
  }
  if (result.maxDurationMs > 2_147_483_647 || !Number.isSafeInteger(result.maxModelCalls + result.maxToolCalls)) {
    throw new MayuraError('INVALID_CONFIG', 'Runtime limits exceed the supported counter or timer range.');
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

/** Create a process-local runtime. This profile promises neither restart recovery nor hard process isolation. */
export function createRuntime(options: RuntimeOptions): Runtime {
  if (options.profile !== 'ephemeral') throw new MayuraError('UNSUPPORTED_PROFILE', 'Only the explicit ephemeral profile is supported by this runtime.');
  const limits = limitsFor(options.limits);
  const suppliedGrants = options.permissions?.allow ?? [];
  if (!Array.isArray(suppliedGrants) || suppliedGrants.length > 4096 || suppliedGrants.some((grant) => typeof grant !== 'string' || grant.length === 0 || grant.length > 256)) {
    throw new MayuraError('INVALID_CONFIG', 'Permissions must be an explicit list of bounded capability names.');
  }
  const permissions: Permissions = Object.freeze({ allow: Object.freeze([...new Set(suppliedGrants)]) });
  const grants = new Set(permissions.allow);
  const suppliedScope = options.scope ?? { principalId: 'local', projectId: 'default' };
  if (!isIdentifier(suppliedScope.principalId) || !isIdentifier(suppliedScope.projectId)) {
    throw new MayuraError('INVALID_CONFIG', 'Scope requires bounded principal and project identifiers.');
  }
  const scope = Object.freeze({ principalId: suppliedScope.principalId, projectId: suppliedScope.projectId });
  const active = new Map<string, RunHandle<unknown>>();
  let closed = false;

  const submit = <I extends Schema, O extends Schema>(agent: AgentDefinition<I, O>, submission: { readonly input: InferInput<I> }): RunHandle<InferOutput<O>> => {
    if (closed) throw new MayuraError('CONFLICT', 'Runtime is closed and cannot accept new runs.');
    assertAgent(agent);
    if (active.size >= limits.maxConcurrentRuns) throw new MayuraError('LIMIT_EXCEEDED', 'The runtime concurrent-run limit is reached.');
    let input: JsonValue;
    try { input = freezeJson(jsonValue(submission.input, { maxBytes: limits.maxInputBytes })); }
    catch { throw new MayuraError('INVALID_INPUT', 'Submitted input must satisfy the JSON and size limits.'); }
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const events = new EventBuffer(id, limits.maxEventRetention);
    const budget = new Budget(limits.maxCostMicros, limits.maxModelCalls + limits.maxToolCalls);
    const tools = new Map(agent.tools.map((tool) => [tool.id, tool]));
    const callIds = new Set<string>();
    let toolCalls = 0;
    let modelCalls = 0;
    let terminal = false;
    let settle!: (result: Outcome<InferOutput<O>>) => void;
    const result = new Promise<Outcome<InferOutput<O>>>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => {
      if (!terminal) controller.abort(new MayuraError('TIMEOUT', 'The run deadline elapsed; no new work will be dispatched.'));
    }, limits.maxDurationMs);
    const handle: RunHandle<InferOutput<O>> = Object.freeze({
      id, profile: 'ephemeral', result: () => result,
      observe: (observerOptions?: { readonly after?: number; readonly signal?: AbortSignal }) => events.observe(observerOptions),
      cancel: () => { if (!terminal && !controller.signal.aborted) controller.abort(new MayuraError('CANCELLED', 'Run cancellation was requested.')); },
    });
    active.set(id, handle);

    const checkCancelled = (): void => { if (controller.signal.aborted) throw controller.signal.reason; };
    const guard = async (checks: readonly Guard[], value: JsonValue, boundary: 'input' | 'output', callId: string): Promise<void> => {
      const verdicts = await cancellable(() => Promise.all(checks.map(async (check) => {
        try {
          const verdict = await check.check(value, Object.freeze({ runId: id, callId, scope, signal: controller.signal, boundary }));
          const decision = verdict?.decision;
          if (decision !== 'allow' && decision !== 'block') throw new Error();
          // Read adapter-owned properties inside the redaction boundary; do not retain a mutable verdict.
          return decision;
        }
        catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A required guard could not complete its check.'); }
      })), controller.signal);
      if (verdicts.some((decision) => decision !== 'allow')) {
        throw new MayuraError('GUARD_BLOCKED', 'A required guard withheld this content.');
      }
    };

    const preflight = async (tool: AnyTool, rawInput: JsonValue): Promise<void> => {
      const required = [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
      if (required.some((grant) => !grants.has(grant))) throw new MayuraError('PERMISSION_DENIED', 'The requested tool is not authorized.');
      await cancellable(() => validate(tool.input, rawInput, 'input', { maxBytes: limits.maxInputBytes }), controller.signal);
    };

    const execute = async (): Promise<Outcome<InferOutput<O>>> => {
      events.emit('run.started', { profile: 'ephemeral' });
      checkCancelled();
      const validated = await cancellable(() => validate(agent.input, input, 'input', { maxBytes: limits.maxInputBytes }), controller.signal);
      const approvedInput = freezeJson(jsonValue(validated, { maxBytes: limits.maxInputBytes }));
      await guard(agent.guards.input, approvedInput, 'input', 'input');
      const messages: ModelMessage[] = [{ role: 'user', content: approvedInput }];
      let continuation: JsonValue | undefined;
      for (let step = 0; step < limits.maxSteps; step++) {
        checkCancelled();
        if (!grants.has(`model:${agent.model.id}`)) throw new MayuraError('PERMISSION_DENIED', 'The model adapter is not authorized.');
        if (modelCalls >= limits.maxModelCalls) throw new MayuraError('LIMIT_EXCEEDED', 'The model-call limit was reached.');
        // Freeze a bounded copy: a provider cannot mutate history or the tool registry between checks.
        const snapshot = freezeJson(jsonValue(messages, { maxBytes: limits.maxContextBytes })) as unknown as readonly ModelMessage[];
        const modelTools = agent.tools.map((tool) => Object.freeze({ id: tool.id, description: tool.description,
          ...(tool.inputJsonSchema === undefined ? {} : { inputJsonSchema: freezeJson(jsonValue(tool.inputJsonSchema)) as typeof tool.inputJsonSchema }),
        }));
        const requestData = freezeJson(jsonValue({ instructions: agent.instructions, messages: snapshot, tools: modelTools, ...(continuation === undefined ? {} : { continuation }) }, { maxBytes: limits.maxContextBytes })) as unknown as Omit<ModelRequest, 'signal' | 'maxOutputTokens'>;
        const reservation = budget.reserve(agent.model.maxCostMicros);
        modelCalls++;
        events.emit('model.started', { step, modelCall: modelCalls });
        const rawResponse = await cancellable(async () => {
          let raw;
          try { raw = await agent.model.generate(Object.freeze({ ...requestData, signal: controller.signal, maxOutputTokens: limits.maxOutputTokens })); }
          catch (error) {
            if (error instanceof ModelInvocationError) reservation.settle(error.costMicros);
            throw new MayuraError('MODEL_FAILED', 'The model adapter failed to produce a response.');
          }
          // Account independently validated usage even when the content envelope is malformed.
          // The callback may complete after cooperative cancellation; it cannot re-open disclosure.
          reservation.settle(modelCost(raw));
          return raw;
        }, controller.signal);
        checkCancelled();
        const response = modelResponse(rawResponse, limits.maxOutputBytes, limits.maxToolCalls);
        continuation = response.continuation === undefined ? undefined : freezeJson(jsonValue(response.continuation, { maxBytes: limits.maxContextBytes }));
        events.emit('model.completed', { step, response: response.type });
        if (response.type === 'final') {
          const output = await cancellable(() => validate(agent.output, response.output, 'output', { maxBytes: limits.maxOutputBytes }), controller.signal);
          const approvedOutput = freezeJson(jsonValue(output, { maxBytes: limits.maxOutputBytes }));
          await guard(agent.guards.output, approvedOutput, 'output', `model.${modelCalls}`);
          checkCancelled();
          return Object.freeze({ status: 'succeeded' as const, output: approvedOutput as InferOutput<O> });
        }
        if (response.calls.length > limits.maxToolCalls - toolCalls) throw new MayuraError('LIMIT_EXCEEDED', 'The tool-call limit was reached.');
        // Admit every member before starting the first effect. Unknown or duplicate calls reject the batch.
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
          toolCalls++;
          events.emit('tool.started', { callId: call.id, toolId: call.toolId });
          let outcome = await invokeTool(tools.get(call.toolId)!, call.input, {
            runId: id, callId: call.id, scope, signal: controller.signal, permissions, budget,
            maxOutputBytes: limits.maxOutputBytes,
          });
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
          try { await guard(agent.guards.output, toolOutput, 'output', call.id); }
          catch (error) {
            const blocked = outcomeFor(error);
            events.emit('tool.completed', { callId: call.id, toolId: call.toolId, status: blocked.status, execution: 'succeeded', disclosure: 'withheld' });
            return { ...blocked, ...(outcome.receipt ? { receipt: Object.freeze({ ...outcome.receipt, disclosure: 'withheld' as const }) } : {}) };
          }
          events.emit('tool.completed', { callId: call.id, toolId: call.toolId, status: outcome.status, execution: 'succeeded', disclosure: 'released' });
          messages.push({ role: 'tool', callId: call.id, toolId: call.toolId, result: toolOutput });
        }
      }
      throw new MayuraError('LIMIT_EXCEEDED', 'The agent step limit was reached.');
    };

    queueMicrotask(() => {
      void execute().catch(outcomeFor).then((outcome) => {
        terminal = true;
        clearTimeout(timer);
        events.emit('run.completed', { status: outcome.status, ...budget.snapshot() });
        events.finish();
        active.delete(id);
        settle(Object.freeze(outcome));
      });
    });
    return handle;
  };

  return Object.freeze({
    profile: 'ephemeral', submit,
    close: async (): Promise<void> => {
      closed = true;
      const runs = [...active.values()];
      for (const run of runs) run.cancel();
      await Promise.all(runs.map((run) => run.result()));
    },
  });
}
