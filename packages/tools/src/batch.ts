import { MayuraError, assertBudget, assertPositiveInteger, freezeJson, jsonValue, validate, type JsonValue, type Outcome } from '@mayura/core';
import { assertTool, invokeTool, type AnyTool, type InvokeToolContext } from './index.js';
import { snapshotToolContextBindings } from './context.js';

/** Literal-input call in a finite dependency graph. Resource keys are trusted application declarations. */
export interface BatchCall {
  readonly id: string;
  readonly tool: AnyTool;
  readonly input: JsonValue;
  readonly dependsOn?: readonly string[];
  readonly resources?: readonly string[];
}

export interface InvokeBatchOptions extends Omit<InvokeToolContext, 'callId'> {
  readonly failurePolicy?: 'collect-all' | 'fail-fast';
  readonly concurrency?: number;
  readonly preflightTimeoutMs?: number;
}

export interface SkippedBatchOutcome {
  readonly status: 'skipped';
  readonly reason: 'dependency_failed' | 'fail_fast' | 'resource_uncertain';
  readonly dependencies: readonly string[];
}
export interface BatchCallResult {
  readonly id: string;
  readonly outcome: Outcome<JsonValue> | SkippedBatchOutcome;
}

interface PreparedCall {
  readonly id: string; readonly tool: AnyTool; readonly input: JsonValue;
  readonly dependencies: readonly string[]; readonly resources: readonly string[];
  candidate: string;
}
interface CompletedCall { readonly call: PreparedCall; readonly outcome: Outcome<JsonValue> }
const encoder = new TextEncoder();

function text(value: unknown, label: string, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0') || encoder.encode(value).length > maximum) {
    throw new MayuraError('INVALID_CONFIG', `${label} must be a bounded nonempty string without null characters.`);
  }
}

function keys(value: readonly string[] | undefined, label: string, maximum: number): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maximum) throw new MayuraError('INVALID_CONFIG', `${label} exceeds the supported bound.`);
  for (const item of value) text(item, label);
  if (new Set(value).size !== value.length) throw new MayuraError('INVALID_CONFIG', `${label} must not contain duplicates.`);
  return Object.freeze([...value]);
}

/** Deterministic JSON equality independent of object insertion order. */
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

function skipped(reason: SkippedBatchOutcome['reason'], dependencies: readonly string[] = []): SkippedBatchOutcome {
  return Object.freeze({ status: 'skipped', reason, dependencies: Object.freeze([...dependencies]) });
}

function cancelled(): Outcome<JsonValue> {
  return Object.freeze({ status: 'cancelled', error: Object.freeze({ code: 'CANCELLED', message: 'Batch was cancelled before this call was dispatched.' }) });
}

/**
 * Validate the whole finite batch before effects, then invoke every runnable call through the
 * ordinary tool broker with shared accounting and bounded local concurrency. This is non-durable.
 */
export async function invokeBatch(calls: readonly BatchCall[], options: InvokeBatchOptions): Promise<readonly BatchCallResult[]> {
  if (!options || typeof options !== 'object' || !Array.isArray(calls) || calls.length < 1 || calls.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A batch requires valid options and 1–128 calls.');
  }
  text(options.runId, 'runId'); text(options.scope?.principalId, 'scope.principalId'); text(options.scope?.projectId, 'scope.projectId');
  if (!(options.signal instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'An AbortSignal is required.');
  assertBudget(options.budget);
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4096) throw new MayuraError('INVALID_CONFIG', 'Permissions must contain a bounded grant list.');
  for (const grant of options.permissions.allow) text(grant, 'grant', 384);
  const permissions = Object.freeze({ allow: Object.freeze([...options.permissions.allow]) });
  const grants = new Set(permissions.allow);
  const runId = options.runId;
  const scope = Object.freeze({ principalId: options.scope.principalId, projectId: options.scope.projectId });
  const budget = options.budget;
  const parentSignal = options.signal;
  const beforeDispatch = options.beforeDispatch;
  const onExecutionReceipt = options.onExecutionReceipt;
  const contextBindings = snapshotToolContextBindings(options.contextBindings);
  const acquireExecution = options.acquireExecution;
  if (acquireExecution !== undefined && typeof acquireExecution !== 'function') throw new MayuraError('INVALID_CONFIG', 'acquireExecution must be a function.');
  if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw new MayuraError('INVALID_CONFIG', 'beforeDispatch must be a function.');
  if (onExecutionReceipt !== undefined && typeof onExecutionReceipt !== 'function') throw new MayuraError('INVALID_CONFIG', 'onExecutionReceipt must be a function.');
  const concurrency = options.concurrency ?? 4;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const preflightTimeoutMs = options.preflightTimeoutMs ?? 30_000;
  const failurePolicy = options.failurePolicy ?? 'collect-all';
  assertPositiveInteger(concurrency, 'concurrency'); assertPositiveInteger(maxOutputBytes, 'maxOutputBytes'); assertPositiveInteger(preflightTimeoutMs, 'preflightTimeoutMs');
  if (concurrency > 32 || preflightTimeoutMs > 2_147_483_647 || !['collect-all', 'fail-fast'].includes(failurePolicy)) throw new MayuraError('INVALID_CONFIG', 'Batch execution limits or failure policy are invalid.');

  // Capture every mutable caller value before the first asynchronous schema operation.
  let inputBytes = 0;
  const prepared: PreparedCall[] = calls.map(call => {
    if (!call || typeof call !== 'object') throw new MayuraError('INVALID_CONFIG', 'Invalid batch call.');
    text(call.id, 'Call ID', 128);
    assertTool(call.tool);
    const required = [`tool:${call.tool.id}`, ...call.tool.capabilities, ...(call.tool.effects === 'none' ? [] : [`effect:${call.tool.effects}`])];
    if (!required.every(grant => grants.has(grant))) throw new MayuraError('PERMISSION_DENIED', 'The batch includes a tool requiring grants that are not present.');
    let input: JsonValue;
    try { input = freezeJson(jsonValue(call.input)); }
    catch { throw new MayuraError('INVALID_INPUT', 'Batch inputs must be bounded plain JSON.'); }
    inputBytes += encoder.encode(JSON.stringify(input)).length;
    if (inputBytes > 4_194_304) throw new MayuraError('LIMIT_EXCEEDED', 'Combined batch input exceeds four MiB.');
    return {
      id: call.id, tool: call.tool, input,
      dependencies: keys(call.dependsOn, 'Dependencies', 128),
      resources: Object.freeze([...keys(call.resources, 'Resource keys', 32)].sort()), candidate: '',
    };
  });
  const byId = new Map(prepared.map(call => [call.id, call]));
  if (byId.size !== prepared.length) throw new MayuraError('INVALID_CONFIG', 'Batch call IDs must be unique.');
  for (const call of prepared) if (call.dependencies.some(id => !byId.has(id))) throw new MayuraError('INVALID_CONFIG', 'Batch dependency references an unknown call.');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new MayuraError('INVALID_CONFIG', 'Batch dependency cycle detected.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const call of prepared) visit(call.id);

  const controller = new AbortController();
  let stop: 'cancelled' | 'fail_fast' | undefined;
  const relayAbort = (): void => { stop = 'cancelled'; controller.abort(); };
  parentSignal.addEventListener('abort', relayAbort, { once: true });
  if (parentSignal.aborted) relayAbort();
  try {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectOnAbort: (() => void) | undefined;
    const assertActive = (): void => {
      if (controller.signal.aborted) throw new MayuraError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? 'Batch preflight exceeded its deadline.' : 'Batch was cancelled before dispatch.');
    };
    try {
      assertActive();
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = (): void => { try { assertActive(); } catch (error) { reject(error); } };
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, preflightTimeoutMs);
      const preflight = async (): Promise<void> => {
        for (const call of prepared) {
          assertActive();
          call.candidate = canonical(freezeJson(jsonValue(await validate(call.tool.input, call.input, 'input'))));
          assertActive();
        }
      };
      await Promise.race([preflight(), aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    }

    const pending = new Set(prepared.map(call => call.id));
    const results = new Map<string, BatchCallResult['outcome']>();
    const running = new Map<string, Promise<CompletedCall>>();
    const heldResources = new Set<string>();
    const uncertainResources = new Set<string>();
    const completion = (call: PreparedCall, outcome: Outcome<JsonValue>): CompletedCall => {
      // Latch on settlement, not later queue consumption: another already-settled success must
      // not free capacity for a new dispatch while an unconsumed failure is sitting in the queue.
      if (failurePolicy === 'fail-fast' && outcome.status !== 'succeeded' && stop === undefined) {
        stop = 'fail_fast'; controller.abort();
      }
      return { call, outcome };
    };
    const start = (call: PreparedCall): void => {
      pending.delete(call.id);
      for (const key of call.resources) heldResources.add(key);
      const execution = invokeTool(call.tool, call.input, {
        runId, callId: call.id, scope, permissions, budget, signal: controller.signal, maxOutputBytes,
        ...(onExecutionReceipt ? { onExecutionReceipt } : {}),
        contextBindings,
        ...(acquireExecution ? { acquireExecution } : {}),
        beforeDispatch: async processed => {
          if (canonical(processed) !== call.candidate) throw new MayuraError('CONFLICT', 'Processed batch input changed after preflight.');
          if (beforeDispatch) await beforeDispatch(processed);
        },
      }).then((outcome): CompletedCall => {
        if (outcome.status !== 'succeeded') return completion(call, outcome);
        try { return completion(call, Object.freeze({ ...outcome, output: freezeJson(jsonValue(outcome.output, { maxBytes: maxOutputBytes })) })); }
        catch {
          // Defensive adapter-boundary validation must never discard an already-known receipt.
          return completion(call, Object.freeze({
            status: 'failed', error: Object.freeze({ code: 'INVALID_OUTPUT', message: 'Tool output could not be represented as bounded JSON.' }),
            ...(outcome.receipt ? { receipt: Object.freeze({ ...outcome.receipt, disclosure: 'withheld' }) } : {}),
          }));
        }
      }).catch((): CompletedCall => completion(call, Object.freeze({
        status: 'outcome_unknown', error: Object.freeze({ code: 'OUTCOME_UNKNOWN', message: 'Tool outcome could not be established; reconcile before repeating the action.' }),
      })));
      running.set(call.id, execution);
    };

    while (results.size < prepared.length) {
      let progressed = false;
      for (const call of prepared) {
        if (!pending.has(call.id)) continue;
        if (stop !== undefined) {
          results.set(call.id, stop === 'cancelled' ? cancelled() : skipped('fail_fast'));
          pending.delete(call.id); progressed = true; continue;
        }
        if (call.dependencies.some(id => !results.has(id))) continue;
        const failed = call.dependencies.filter(id => results.get(id)!.status !== 'succeeded');
        if (failed.length > 0 || call.resources.some(key => uncertainResources.has(key))) {
          results.set(call.id, failed.length > 0 ? skipped('dependency_failed', failed) : skipped('resource_uncertain'));
          pending.delete(call.id); progressed = true; continue;
        }
        if (running.size >= concurrency || call.resources.some(key => heldResources.has(key))) continue;
        start(call); progressed = true;
      }
      if (running.size === 0) {
        if (results.size === prepared.length) break;
        if (!progressed) throw new MayuraError('CONFLICT', 'The validated batch could not make scheduling progress.');
        continue;
      }
      const completed = await Promise.race(running.values());
      running.delete(completed.call.id);
      results.set(completed.call.id, completed.outcome);
      for (const key of completed.call.resources) heldResources.delete(key);
      const uncertain = completed.outcome.status !== 'succeeded'
        && completed.outcome.receipt?.execution !== 'not_started'
        && (completed.outcome.status === 'outcome_unknown' || completed.outcome.status === 'cancelled' || completed.outcome.error.code === 'TIMEOUT' || completed.outcome.receipt?.execution === 'unknown');
      if (uncertain) for (const key of completed.call.resources) uncertainResources.add(key);
    }
    return Object.freeze(prepared.map(call => Object.freeze({ id: call.id, outcome: results.get(call.id)! })));
  } finally { parentSignal.removeEventListener('abort', relayAbort); }
}
