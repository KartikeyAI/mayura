import { MayuraError, assertBudget, assertPositiveInteger, freezeJson, jsonValue, validate,
  type JsonPrimitive, type JsonValue, type Outcome } from '@mayura/core';
import { assertTool, invokeTool, type AnyTool, type InvokeToolContext } from './index.js';
import { snapshotToolContextBindings } from './context.js';

export type BatchOutputPathSegment = string | number;
declare const batchOutputReferenceBrand: unique symbol;
export interface BatchOutputReference<T extends JsonValue = JsonValue> {
  readonly [batchOutputReferenceBrand]: T;
  readonly format: 'mayura-batch-output-reference-v1';
  readonly callId: string;
  readonly path: readonly BatchOutputPathSegment[];
}
export type BatchInput = JsonPrimitive | BatchOutputReference | readonly BatchInput[] | { readonly [key: string]: BatchInput };

/** Input-template call in a finite dependency graph. Resource keys are trusted application declarations. */
export interface BatchCall {
  readonly id: string;
  readonly tool: AnyTool;
  readonly input: BatchInput;
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
  readonly id: string; readonly tool: AnyTool; readonly input: InputTemplate; readonly dynamic: boolean;
  readonly dependencies: readonly string[]; readonly resources: readonly string[];
  readonly literalBytes: number;
  candidate?: string;
}
interface CompletedCall { readonly call: PreparedCall; readonly outcome: Outcome<JsonValue> }
interface OutputReferenceRecord { readonly callId: string; readonly path: readonly BatchOutputPathSegment[] }
const templateReference = Symbol('mayura.batch-output-template-reference');
interface TemplateReference { readonly [templateReference]: OutputReferenceRecord }
type InputTemplate = JsonPrimitive | TemplateReference | readonly InputTemplate[] | { readonly [key: string]: InputTemplate };
const encoder = new TextEncoder();
const outputReferences = new WeakMap<object, OutputReferenceRecord>();

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

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function snapshotPath(value: readonly BatchOutputPathSegment[] | undefined): readonly BatchOutputPathSegment[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 16) {
    throw new MayuraError('INVALID_CONFIG', 'Batch output path must contain at most 16 plain segments.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) throw new MayuraError('INVALID_CONFIG', 'Batch output path must be a dense plain array.');
  const result: BatchOutputPathSegment[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !hasOwn(descriptor, 'value')) throw new MayuraError('INVALID_CONFIG', 'Batch output path must contain data segments.');
    const segment = descriptor.value;
    if (typeof segment === 'string') {
      if (segment.includes('\0') || encoder.encode(segment).length > 256) throw new MayuraError('INVALID_CONFIG', 'Batch output property segment is invalid.');
    } else if (!Number.isSafeInteger(segment) || segment < 0 || segment > 99_999) {
      throw new MayuraError('INVALID_CONFIG', 'Batch output array index is invalid.');
    }
    result.push(segment as BatchOutputPathSegment);
  }
  return Object.freeze(result);
}

/** Create a genuine immutable reference to one admitted predecessor output or nested JSON path. */
export function batchOutput<T extends JsonValue = JsonValue>(callId: string,
  path?: readonly BatchOutputPathSegment[]): BatchOutputReference<T> {
  text(callId, 'Batch output call ID', 128);
  const record = Object.freeze({ callId, path: snapshotPath(path) });
  const handle = Object.freeze({ format: 'mayura-batch-output-reference-v1' as const, callId, path: record.path }) as BatchOutputReference<T>;
  outputReferences.set(handle, record);
  return handle;
}

function snapshotTemplate(input: BatchInput): { readonly value: InputTemplate; readonly dependencies: readonly string[];
  readonly bytes: number; readonly references: number } {
  const ancestors = new Set<object>(); const dependencies: string[] = []; const dependencySet = new Set<string>();
  let nodes = 0; let bytes = 0; let references = 0;
  const fail = (message = 'Batch input template must be bounded, acyclic plain JSON or genuine output references.'): never => {
    throw new MayuraError('INVALID_INPUT', message);
  };
  const charge = (amount: number): void => { bytes += amount; if (bytes > 1_048_576) fail('Batch input template exceeds one MiB.'); };
  const visit = (value: unknown, depth: number): InputTemplate => {
    if (++nodes > 100_000 || depth > 32) return fail();
    if (value !== null && typeof value === 'object') {
      const reference = outputReferences.get(value);
      if (reference !== undefined) {
        references += 1; if (references > 64) return fail('Batch input template exceeds 64 output references.');
        if (!dependencySet.has(reference.callId)) { dependencySet.add(reference.callId); dependencies.push(reference.callId); }
        charge(encoder.encode(JSON.stringify([reference.callId, reference.path])).length + 2);
        return Object.freeze({ [templateReference]: reference });
      }
    }
    if (value === null) { charge(4); return null; }
    if (typeof value === 'string') { charge(encoder.encode(JSON.stringify(value)).length); return value; }
    if (typeof value === 'boolean') { charge(value ? 4 : 5); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail();
      charge(String(value).length); return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) return fail();
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail();
    if (Object.getOwnPropertySymbols(value).length > 0) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const format = descriptors['format'];
    if (format !== undefined && hasOwn(format, 'value') && format.value === 'mayura-batch-output-reference-v1') {
      throw new MayuraError('INVALID_CONFIG', 'Batch output references must be genuine handles from batchOutput.');
    }
    ancestors.add(value); charge(2);
    try {
      if (array) {
        if (Object.keys(descriptors).length !== value.length + 1 || value.length > 100_000 - nodes) return fail();
        const result: InputTemplate[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !hasOwn(descriptor, 'value')) return fail();
          if (index > 0) charge(1);
          result.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      const result: Record<string, InputTemplate> = {};
      let count = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || key === '__proto__' || key === 'constructor' || key === 'prototype') return fail();
        if (count++ > 0) charge(1);
        charge(encoder.encode(JSON.stringify(key)).length + 1);
        result[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally { ancestors.delete(value); }
  };
  return Object.freeze({ value: visit(input, 0), dependencies: Object.freeze(dependencies), bytes, references });
}

function resolveTemplate(template: InputTemplate, results: ReadonlyMap<string, BatchCallResult['outcome']>): JsonValue {
  const visit = (value: InputTemplate): unknown => {
    if (value !== null && typeof value === 'object' && hasOwn(value, templateReference)) {
      const reference = (value as TemplateReference)[templateReference]; const outcome = results.get(reference.callId);
      if (outcome?.status !== 'succeeded') throw new MayuraError('CONFLICT', 'Referenced batch output is not available.');
      let selected: JsonValue = outcome.output;
      for (const segment of reference.path) {
        if (typeof segment === 'number') {
          if (!Array.isArray(selected) || segment >= selected.length || !hasOwn(selected, segment)) {
            throw new MayuraError('INVALID_INPUT', 'Batch output array path does not exist.');
          }
          selected = selected[segment]!;
        } else {
          if (selected === null || typeof selected !== 'object' || Array.isArray(selected) || !hasOwn(selected, segment)) {
            throw new MayuraError('INVALID_INPUT', 'Batch output property path does not exist.');
          }
          selected = selected[segment]!;
        }
      }
      return selected;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) result[key] = visit(child);
      return result;
    }
    return value;
  };
  try { return freezeJson(jsonValue(visit(template))); }
  catch (error) {
    if (error instanceof MayuraError && ['INVALID_INPUT', 'CONFLICT'].includes(error.code)) throw error;
    throw new MayuraError('INVALID_INPUT', 'Resolved batch input is not bounded plain JSON.');
  }
}

function resolutionFailure(error: unknown): Outcome<JsonValue> {
  const code = error instanceof MayuraError && error.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' as const : 'INVALID_INPUT' as const;
  const message = code === 'LIMIT_EXCEEDED' ? 'Resolved batch inputs exceed the aggregate limit.' : 'Referenced batch output could not produce a valid input.';
  return Object.freeze({ status: 'failed', error: Object.freeze({ code, message }) });
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
  let inputBytes = 0; let referenceCount = 0;
  const prepared: PreparedCall[] = calls.map(call => {
    if (!call || typeof call !== 'object') throw new MayuraError('INVALID_CONFIG', 'Invalid batch call.');
    text(call.id, 'Call ID', 128);
    assertTool(call.tool);
    const required = [`tool:${call.tool.id}`, ...call.tool.capabilities, ...(call.tool.effects === 'none' ? [] : [`effect:${call.tool.effects}`])];
    if (!required.every(grant => grants.has(grant))) throw new MayuraError('PERMISSION_DENIED', 'The batch includes a tool requiring grants that are not present.');
    const template = snapshotTemplate(call.input);
    inputBytes += template.bytes; referenceCount += template.references;
    if (inputBytes > 4_194_304) throw new MayuraError('LIMIT_EXCEEDED', 'Combined batch input exceeds four MiB.');
    if (referenceCount > 512) throw new MayuraError('LIMIT_EXCEEDED', 'Combined batch references exceed 512.');
    const explicitDependencies = keys(call.dependsOn, 'Dependencies', 128);
    const dependencies = Object.freeze([...explicitDependencies, ...template.dependencies.filter(id => !explicitDependencies.includes(id))]);
    return {
      id: call.id, tool: call.tool, input: template.value, dynamic: template.references > 0,
      dependencies, resources: Object.freeze([...keys(call.resources, 'Resource keys', 32)].sort()),
      literalBytes: template.references === 0 ? template.bytes : 0,
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
          if (!call.dynamic) call.candidate = canonical(freezeJson(jsonValue(await validate(call.tool.input, call.input, 'input'))));
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
    let resolvedInputBytes = prepared.reduce((total, call) => total + call.literalBytes, 0);
    const completion = (call: PreparedCall, outcome: Outcome<JsonValue>): CompletedCall => {
      // Latch on settlement, not later queue consumption: another already-settled success must
      // not free capacity for a new dispatch while an unconsumed failure is sitting in the queue.
      if (failurePolicy === 'fail-fast' && outcome.status !== 'succeeded' && stop === undefined) {
        stop = 'fail_fast'; controller.abort();
      }
      return { call, outcome };
    };
    const start = (call: PreparedCall, input: JsonValue): void => {
      pending.delete(call.id);
      for (const key of call.resources) heldResources.add(key);
      const execution = invokeTool(call.tool, input, {
        runId, callId: call.id, scope, permissions, budget, signal: controller.signal, maxOutputBytes,
        ...(onExecutionReceipt ? { onExecutionReceipt } : {}),
        contextBindings,
        ...(acquireExecution ? { acquireExecution } : {}),
        beforeDispatch: async processed => {
          if (call.candidate !== undefined && canonical(processed) !== call.candidate) throw new MayuraError('CONFLICT', 'Processed batch input changed after preflight.');
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
        let resolved: JsonValue;
        try {
          resolved = call.dynamic ? resolveTemplate(call.input, results) : call.input as JsonValue;
          if (call.dynamic) {
            resolvedInputBytes += encoder.encode(JSON.stringify(resolved)).length;
            if (!Number.isSafeInteger(resolvedInputBytes) || resolvedInputBytes > 4_194_304) {
              throw new MayuraError('LIMIT_EXCEEDED', 'Resolved batch inputs exceed four MiB.');
            }
          }
        } catch (error) {
          const outcome = resolutionFailure(error); results.set(call.id, outcome); pending.delete(call.id); progressed = true;
          if (failurePolicy === 'fail-fast' && stop === undefined) { stop = 'fail_fast'; controller.abort(); }
          continue;
        }
        start(call, resolved); progressed = true;
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
